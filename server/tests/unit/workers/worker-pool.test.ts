import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../../../src/workers/worker-pool.js';

// Mock SessionWorker
vi.mock('../../../src/workers/session-worker.js', () => ({
  SessionWorker: vi.fn().mockImplementation((options) => ({
    sessionPath: options.sessionPath,
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
  });
});
