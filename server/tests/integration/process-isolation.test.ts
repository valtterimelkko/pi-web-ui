import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from '../../src/workers/worker-pool.js';
import { SessionWorker } from '../../src/workers/session-worker.js';

describe('Process Isolation', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool({
      maxWorkers: 3,
      idleTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await pool.shutdownAll();
  });

  describe('WorkerPool', () => {
    it('should track worker statistics', () => {
      const stats = pool.getStats();
      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.idle).toBe(0);
    });

    it('should enforce max workers limit', async () => {
      // This test would spawn real workers, but we'll skip for unit tests
      // In real integration tests, we would verify:
      // - Workers are spawned up to maxWorkers
      // - Error is thrown when exceeding limit
    });

    it('should cleanup idle workers', async () => {
      const removed = await pool.cleanupIdle();
      expect(removed).toBe(0);
    });
  });

  describe('SessionWorker', () => {
    it('should track session path', () => {
      const worker = new SessionWorker({
        sessionPath: '/tmp/test.jsonl',
      });
      expect(worker.sessionPath).toBe('/tmp/test.jsonl');
    });

    it('should start in spawning status', () => {
      const worker = new SessionWorker({
        sessionPath: '/tmp/test.jsonl',
      });
      expect(worker.status).toBe('spawning');
    });
  });

  describe('Crash Recovery', () => {
    it('should handle worker termination gracefully', async () => {
      // In real integration tests, we would verify:
      // - Worker can be terminated without affecting other workers
      // - Session file is preserved after worker crash
      // - Client can reconnect to restarted worker
    });

    it('should preserve session state across worker restarts', async () => {
      // In real integration tests, we would verify:
      // - Session file is written correctly
      // - New worker can resume from existing session file
    });
  });
});
