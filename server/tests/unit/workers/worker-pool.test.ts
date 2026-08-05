import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../../../src/workers/worker-pool.js';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import type { WorkerLauncher } from '../../../src/workers/worker-launcher.js';

// Mock SessionWorker
vi.mock('../../../src/workers/session-worker.js', () => ({
  SessionWorker: vi.fn().mockImplementation((options, observability) => ({
    sessionPath: options.sessionPath,
    assignmentIdentity: observability?.assignment,
    status: 'ready',
    pid: 12345,
    lastActivity: Date.now(),
    spawnedAt: 123456789,
    spawn: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onTerminated: vi.fn().mockReturnValue(() => {}),
  })),
}));

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new WorkerPool({
      maxWorkers: 5,
      idleTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await pool.shutdownAll();
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const defaultPool = new WorkerPool();
      const stats = defaultPool.getStats();
      expect(stats.maxWorkers).toBe(15);
    });

    it('should accept custom config', () => {
      const stats = pool.getStats();
      expect(stats.maxWorkers).toBe(5);
    });
  });

  describe('getStats', () => {
    it('should return empty stats initially', () => {
      const stats = pool.getStats();
      expect(stats.active).toBe(0);
      expect(stats.idle).toBe(0);
      expect(stats.total).toBe(0);
    });
  });

  describe('worker lifecycle evidence', () => {
    it('passes the configured Pi executable into the worker launch seam', async () => {
      const configuredPool = new WorkerPool({ piPath: '/opt/pi/bin/pi' });
      await configuredPool.getOrCreate('/tmp/configured-session.jsonl');

      expect(SessionWorker).toHaveBeenCalledWith(
        expect.objectContaining({ sessionPath: '/tmp/configured-session.jsonl' }),
        expect.objectContaining({ executable: '/opt/pi/bin/pi' }),
      );
      await configuredPool.shutdownAll();
    });

    it('binds a server-derived assignment and launcher to the worker generation', async () => {
      const launcher = { launch: vi.fn() } as unknown as WorkerLauncher;
      const assignment = {
        sessionId: 'session-heavy', sessionPath: '/tmp/heavy.jsonl', runId: 'run-heavy',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy' as const,
      };
      const configuredPool = new WorkerPool({
        workerLauncher: launcher,
        commandTimeoutMs: 2_000,
        readinessFallbackMs: 250,
      });
      await configuredPool.getOrCreate('/tmp/heavy.jsonl', undefined, assignment);

      expect(SessionWorker).toHaveBeenCalledWith(
        expect.objectContaining({ sessionPath: '/tmp/heavy.jsonl' }),
        expect.objectContaining({ launcher, assignment, commandTimeoutMs: 2_000, readinessFallbackMs: 250 }),
      );
      await configuredPool.shutdownAll();
    });

    it('rejects a warm-worker lookup whose server assignment names a different session owner', async () => {
      const launcher = { launch: vi.fn() } as unknown as WorkerLauncher;
      const configuredPool = new WorkerPool({ workerLauncher: launcher });
      const first = {
        sessionId: 'session-heavy', sessionPath: '/tmp/heavy.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy' as const,
      };
      await configuredPool.getOrCreate(first.sessionPath, undefined, first);
      await expect(configuredPool.getOrCreate(first.sessionPath, undefined, {
        ...first, sessionId: 'foreign-session', runId: 'run-2', attemptEpoch: 2,
      })).rejects.toThrow(/assignment.*owner|identity/i);
      await configuredPool.shutdownAll();
    });

    it('does not return a warm worker while its exact resource termination is in flight', async () => {
      const sessionPath = '/tmp/terminating-session.jsonl';
      const first = await pool.getOrCreate(sessionPath);
      let finishTermination!: () => void;
      vi.mocked(first.terminate).mockImplementation(() => new Promise<void>((resolve) => {
        finishTermination = resolve;
      }));

      const termination = pool.terminate(sessionPath);
      let lookupSettled = false;
      const replacement = pool.getOrCreate(sessionPath).finally(() => { lookupSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lookupSettled).toBe(false);
      finishTermination();
      await termination;
      await expect(replacement).resolves.not.toBe(first);
    });

    it('prevents plain and contained pools from concurrently owning the same session path', async () => {
      const plainPool = new WorkerPool({ ownershipKind: 'plain' });
      const containedPool = new WorkerPool({ ownershipKind: 'contained' });
      const sessionPath = '/tmp/exclusive-session.jsonl';
      await plainPool.getOrCreate(sessionPath);

      await expect(containedPool.getOrCreate(sessionPath)).rejects.toThrow(/already owned.*plain/i);
      await plainPool.terminate(sessionPath);
      await expect(containedPool.getOrCreate(sessionPath)).resolves.toBeDefined();
      await containedPool.shutdownAll();
      await plainPool.shutdownAll();
    });

    it('reports the real worker spawn timestamp', async () => {
      await pool.getOrCreate('/tmp/session.jsonl');
      expect(pool.getAllWorkers()[0]).toMatchObject({
        sessionPath: '/tmp/session.jsonl',
        spawnedAt: 123456789,
      });
    });

    it('awaits idle cleanup and returns the number removed', async () => {
      const removed = await pool.cleanupIdle();
      expect(removed).toBe(0);
    });
  });

  describe('startCleanupInterval', () => {
    it('owns exactly one unrefd interval across repeated starts and clears it on stop', () => {
      vi.useFakeTimers();
      try {
        const baseline = vi.getTimerCount();
        pool.startCleanupInterval(1000);
        pool.startCleanupInterval(1000);
        expect(vi.getTimerCount()).toBe(baseline + 1);

        pool.stopCleanupInterval();
        expect(vi.getTimerCount()).toBe(baseline);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('shutdownAll', () => {
    it('should clear all workers', async () => {
      await pool.shutdownAll();
      const stats = pool.getStats();
      expect(stats.total).toBe(0);
    });

    it('awaits every owner teardown before reporting aggregate shutdown failure', async () => {
      let finishSecond!: () => void;
      let secondLifecycle = 'owned';
      const first = {
        resourceLifecycle: 'quarantined',
        terminate: vi.fn(async () => { throw new Error('first teardown failed'); }),
      } as unknown as SessionWorker;
      const second = {
        get resourceLifecycle() { return secondLifecycle; },
        terminate: vi.fn(() => new Promise<void>((resolve) => {
          finishSecond = () => { secondLifecycle = 'released'; resolve(); };
        })),
      } as unknown as SessionWorker;
      (pool as unknown as { workers: Map<string, SessionWorker> }).workers.set('/tmp/first.jsonl', first);
      (pool as unknown as { workers: Map<string, SessionWorker> }).workers.set('/tmp/second.jsonl', second);

      let settled = false;
      let shutdownError: unknown;
      const shutdown = pool.shutdownAll()
        .catch((error) => { shutdownError = error; })
        .finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(second.terminate).toHaveBeenCalledTimes(1);
      finishSecond();
      await shutdown;
      expect(shutdownError).toMatchObject({ message: expect.stringMatching(/first teardown failed/i) });
      expect(pool.get('/tmp/second.jsonl')).toBeUndefined();
      expect(pool.get('/tmp/first.jsonl')).toBe(first);
      // The failed pool intentionally remains quarantined; avoid re-awaiting
      // its memoized rejection in the suite-level cleanup.
      pool = new WorkerPool();
    });
  });
});
