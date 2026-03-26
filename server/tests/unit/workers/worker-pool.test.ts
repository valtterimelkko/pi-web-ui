import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../../../src/workers/worker-pool.js';

// Mock SessionWorker
vi.mock('../../../src/workers/session-worker.js', () => ({
  SessionWorker: vi.fn().mockImplementation((options) => ({
    sessionPath: options.sessionPath,
    status: 'ready',
    pid: 12345,
    lastActivity: Date.now(),
    spawn: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
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

  describe('cleanupIdle', () => {
    it('should return 0 when no workers', () => {
      const removed = pool.cleanupIdle();
      expect(removed).toBe(0);
    });
  });

  describe('startCleanupInterval', () => {
    it('should start and stop interval', () => {
      pool.startCleanupInterval(1000);
      pool.stopCleanupInterval();
      // No error means success
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
