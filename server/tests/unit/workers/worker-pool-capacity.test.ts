import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../../../src/workers/worker-pool.js';

// Mock SessionWorker with MUTABLE status so tests can simulate a process
// exit/crash (status -> 'terminated') without spawning a real `pi` process.
const created: Array<{
  sessionPath: string;
  status: string;
  pid: number;
  lastActivity: number;
  spawnedAt: number;
  spawn: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  simulateExit: () => void;
}> = [];

vi.mock('../../../src/workers/session-worker.js', () => ({
  SessionWorker: vi.fn().mockImplementation((options: { sessionPath: string }) => {
    const w = {
      sessionPath: options.sessionPath,
      status: 'ready',
      pid: 1000 + created.length,
      lastActivity: Date.now(),
      spawnedAt: 123456789 + created.length, // distinct, stable timestamp
      spawn: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(async function (this: typeof w) {
        this.status = 'terminated';
      }),
      simulateExit() {
        w.status = 'terminated';
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
    pool = new WorkerPool({ maxWorkers: 1, idleTimeoutMs: 5000 });
  });

  afterEach(async () => {
    await pool.shutdownAll();
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

  it('sweeps exited workers on the next getOrCreate so capacity is not held', async () => {
    pool = new WorkerPool({ maxWorkers: 200, idleTimeoutMs: 5000 });
    for (let i = 0; i < 50; i++) {
      await pool.getOrCreate(`/s/${i}`);
    }
    // All processes exit (crash). None are explicitly terminated.
    for (const w of created) w.simulateExit();
    expect(pool.getStats().total).toBe(50); // still in the map until swept

    // A new spawn must sweep the terminated workers and succeed.
    await pool.getOrCreate('/s/new');
    expect(pool.getStats().total).toBe(1); // only the new worker remains
  });
});
