import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../../../src/workers/worker-pool.js';

// Mock SessionWorker with MUTABLE status so tests can simulate a process
// exit/crash (status -> 'terminated') without spawning a real `pi` process.
let nextSpawnError: Error | undefined;
let nextSpawnGate: Promise<void> | undefined;
let nextTerminateError: Error | undefined;
const created: Array<{
  sessionPath: string;
  status: string;
  pid: number;
  lastActivity: number;
  spawnedAt: number;
  spawn: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onTerminated: ReturnType<typeof vi.fn>;
  resourceLifecycle: string;
  simulateExit: () => void;
}> = [];

vi.mock('../../../src/workers/session-worker.js', () => ({
  SessionWorker: vi.fn().mockImplementation((options: { sessionPath: string }) => {
    const w = {
      sessionPath: options.sessionPath,
      status: 'ready',
      resourceLifecycle: 'owned',
      pid: 1000 + created.length,
      lastActivity: Date.now(),
      spawnedAt: 123456789 + created.length, // distinct, stable timestamp
      spawn: vi.fn(async () => {
        if (nextSpawnError) {
          const error = nextSpawnError;
          nextSpawnError = undefined;
          throw error;
        }
        await nextSpawnGate;
      }),
      terminate: vi.fn(async function (this: typeof w) {
        this.status = 'terminated';
        if (nextTerminateError) {
          this.resourceLifecycle = 'quarantined';
          const error = nextTerminateError;
          nextTerminateError = undefined;
          throw error;
        }
        this.resourceLifecycle = 'released';
        (this as typeof w & { terminatedHandler?: () => void }).terminatedHandler?.();
      }),
      onTerminated: vi.fn((handler: () => void) => {
        (w as typeof w & { terminatedHandler?: () => void }).terminatedHandler = handler;
        return () => {
          delete (w as typeof w & { terminatedHandler?: () => void }).terminatedHandler;
        };
      }),
      simulateExit() {
        w.status = 'terminated';
        w.resourceLifecycle = 'released';
        (w as typeof w & { terminatedHandler?: () => void }).terminatedHandler?.();
      },
    };
    created.push(w);
    return w;
  }),
}));

describe('L2: WorkerPool capacity release + idempotent cleanup', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    created.length = 0;
    nextSpawnError = undefined;
    nextSpawnGate = undefined;
    nextTerminateError = undefined;
    pool = new WorkerPool({ maxWorkers: 1, idleTimeoutMs: 5000 });
  });

  afterEach(async () => {
    await pool.shutdownAll();
  });

  it('single-flights concurrent same-session creation until the one worker is ready', async () => {
    let release!: () => void;
    nextSpawnGate = new Promise<void>((resolve) => { release = resolve; });

    const a = pool.getOrCreate('/s/gated');
    await Promise.resolve();
    let bSettled = false;
    const b = pool.getOrCreate('/s/gated').then((worker) => { bSettled = true; return worker; });
    await Promise.resolve();

    expect(bSettled).toBe(false);
    release();
    const [workerA, workerB] = await Promise.all([a, b]);
    expect(workerB).toBe(workerA);
    expect(created).toHaveLength(1);
  });

  it('retains quarantined ownership when exact teardown fails', async () => {
    await pool.getOrCreate('/s/quarantined');
    nextTerminateError = new Error('cgroup remained populated');

    await expect(pool.terminate('/s/quarantined')).rejects.toThrow(/cgroup remained populated/i);
    expect(pool.get('/s/quarantined')).toBe(created[0]);
    expect(pool.getStats().total).toBe(1);
    await expect(pool.getOrCreate('/s/new')).rejects.toThrow(/Maximum worker limit/i);

    // Test-only recovery lets afterEach prove normal shutdown does not leak.
    created[0].resourceLifecycle = 'owned';
    await pool.terminate('/s/quarantined');
  });

  it('releases capacity when a worker exits, allowing a new spawn at maxWorkers=1', async () => {
    await pool.getOrCreate('/s/a');
    expect(pool.getStats().total).toBe(1);

    // The worker's process exits/crashes (status -> 'terminated') but is NOT
    // explicitly terminated by the pool. It must not occupy capacity.
    created[0].simulateExit();

    await pool.getOrCreate('/s/b'); // must not throw "Maximum worker limit reached"
    expect(pool.getStats().total).toBe(1);
    expect(pool.get('/s/a')).toBeUndefined();
    expect(pool.get('/s/b')).toBeDefined();
  });

  it('releases capacity when a worker is reused-by-recreate on the same path after exit', async () => {
    await pool.getOrCreate('/s/a');
    created[0].simulateExit();
    // Same path, terminated -> must sweep and recreate, not block.
    const again = await pool.getOrCreate('/s/a');
    expect(again).toBeDefined();
    expect(pool.getStats().total).toBe(1);
  });

  it('repeated terminate() changes capacity only once (idempotent)', async () => {
    await pool.getOrCreate('/s/a');
    const before = pool.getStats().total;
    await pool.terminate('/s/a');
    await pool.terminate('/s/a'); // no-op, must not throw
    await pool.terminate('/s/a');
    expect(pool.getStats().total).toBe(before - 1);
  });

  it('preserves the original spawn timestamp (no fabricated metadata)', async () => {
    await pool.getOrCreate('/s/a');
    const info = pool.getAllWorkers();
    expect(info).toHaveLength(1);
    expect(info[0].spawnedAt).toBe(123456789);
  });

  it('100 churned workers settle to map size 0 after termination', async () => {
    pool = new WorkerPool({ maxWorkers: 200, idleTimeoutMs: 5000 });
    for (let i = 0; i < 100; i++) {
      await pool.getOrCreate(`/s/${i}`);
    }
    expect(pool.getStats().total).toBe(100);
    for (let i = 0; i < 100; i++) {
      await pool.terminate(`/s/${i}`);
    }
    expect(pool.getStats().total).toBe(0);
  });

  it('releases exited workers immediately without requiring another pool operation', async () => {
    pool = new WorkerPool({ maxWorkers: 200, idleTimeoutMs: 5000 });
    for (let i = 0; i < 50; i++) {
      await pool.getOrCreate(`/s/${i}`);
    }

    for (const w of created) w.simulateExit();

    expect(pool.getStats().total).toBe(0);
  });

  it('releases a reserved map entry when spawn fails', async () => {
    nextSpawnError = new Error('spawn failed');

    await expect(pool.getOrCreate('/s/broken')).rejects.toThrow('spawn failed');

    expect(pool.get('/s/broken')).toBeUndefined();
    expect(pool.getStats().total).toBe(0);
    await expect(pool.getOrCreate('/s/recovery')).resolves.toBeDefined();
  });

  it('rejects new workers while shutdown is in progress instead of losing a replacement', async () => {
    await pool.getOrCreate('/s/a');
    let releaseTermination!: () => void;
    created[0].terminate.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseTermination = () => {
        created[0].resourceLifecycle = 'released';
        resolve();
      };
    }));

    const shutdown = pool.shutdownAll();
    await Promise.resolve();

    await expect(pool.getOrCreate('/s/b')).rejects.toThrow(/shutting down/i);
    releaseTermination();
    await shutdown;
    expect(pool.getStats().total).toBe(0);
  });
});
