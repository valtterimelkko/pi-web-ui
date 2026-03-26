import { describe, it, expect, beforeEach } from 'vitest';
import { CrashLogger, CrashStats, getCrashLogger, resetCrashLogger } from '../../../src/workers/crash-logger.js';
import type { WorkerStatus } from '@pi-web-ui/shared';

describe('CrashLogger', () => {
  let logger: CrashLogger;

  beforeEach(() => {
    resetCrashLogger();
    logger = new CrashLogger({ logToConsole: false });
  });

  describe('recordCrash', () => {
    it('should record a basic crash', () => {
      const record = logger.recordCrash({
        sessionPath: '/test/session',
        pid: 12345,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 10000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(record.id).toBeDefined();
      expect(record.sessionPath).toBe('/test/session');
      expect(record.pid).toBe(12345);
      expect(record.exitCode).toBe(1);
      expect(record.type).toBe('crashed');
      expect(record.lifetimeMs).toBeGreaterThanOrEqual(10000);
    });

    it('should categorize OOM kills (SIGKILL)', () => {
      const record = logger.recordCrash({
        sessionPath: '/test/session',
        pid: 12345,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 5000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(record.type).toBe('oom_killed');
    });

    it('should categorize graceful shutdown', () => {
      const record = logger.recordCrash({
        sessionPath: '/test/session',
        pid: 12345,
        exitCode: 0,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 10000,
        previousStatus: 'ready' as WorkerStatus,
      });

      expect(record.type).toBe('graceful');
    });

    it('should categorize spawn failures', () => {
      const record = logger.recordCrash({
        sessionPath: '/test/session',
        pid: undefined,
        exitCode: null,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now(),
        errorMessage: 'spawn pi ENOENT',
        previousStatus: 'spawning' as WorkerStatus,
      });

      expect(record.type).toBe('spawn_failed');
    });

    it('should categorize signal termination (non-OOM)', () => {
      const record = logger.recordCrash({
        sessionPath: '/test/session',
        pid: 12345,
        exitCode: null,
        signal: 'SIGTERM',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 10000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(record.type).toBe('signal_terminated');
    });

    it('should detect Node.js OOM exit codes', () => {
      // Exit code 134 often indicates OOM
      const record134 = logger.recordCrash({
        sessionPath: '/test/session',
        pid: 12345,
        exitCode: 134,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 5000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(record134.type).toBe('oom_killed');

      // Exit code 139 (SIGSEGV) can also indicate OOM
      const record139 = logger.recordCrash({
        sessionPath: '/test/session',
        pid: 12346,
        exitCode: 139,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 5000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(record139.type).toBe('oom_killed');
    });

    it('should maintain circular buffer of records', () => {
      // Create logger with small buffer
      const smallLogger = new CrashLogger({ maxRecords: 3, logToConsole: false });

      // Add 5 records
      for (let i = 0; i < 5; i++) {
        smallLogger.recordCrash({
          sessionPath: `/test/session-${i}`,
          pid: 10000 + i,
          exitCode: 1,
          signal: null,
          memoryLimitMB: 512,
          spawnedAt: Date.now() - 1000,
          previousStatus: 'streaming' as WorkerStatus,
        });
      }

      const records = smallLogger.getRecords();
      expect(records).toHaveLength(3);
      // Should keep the most recent (newest first in getRecords)
      expect(records[0].sessionPath).toBe('/test/session-4');
      expect(records[2].sessionPath).toBe('/test/session-2');
    });
  });

  describe('getRecords', () => {
    beforeEach(() => {
      // Add some test records
      logger.recordCrash({
        sessionPath: '/test/session-1',
        pid: 10001,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session-2',
        pid: 10002,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session-1', // Same session as first
        pid: 10003,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });
    });

    it('should filter by crash type', () => {
      const oomRecords = logger.getRecords({ type: 'oom_killed' });
      expect(oomRecords).toHaveLength(2);
      expect(oomRecords.every(r => r.type === 'oom_killed')).toBe(true);

      const crashRecords = logger.getRecords({ type: 'crashed' });
      expect(crashRecords).toHaveLength(1);
    });

    it('should filter by session path', () => {
      const session1Records = logger.getRecords({ sessionPath: '/test/session-1' });
      expect(session1Records).toHaveLength(2);

      const session2Records = logger.getRecords({ sessionPath: '/test/session-2' });
      expect(session2Records).toHaveLength(1);
    });

    it('should respect limit parameter', () => {
      const limited = logger.getRecords({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('should return records newest first', () => {
      const records = logger.getRecords();
      expect(records[0].timestamp).toBeGreaterThanOrEqual(records[1].timestamp);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty logger', () => {
      const stats = logger.getStats();

      expect(stats.totalCrashes).toBe(0);
      expect(stats.crashesLast24h).toBe(0);
      expect(stats.crashesLastHour).toBe(0);
      expect(stats.oomStats.total).toBe(0);
      expect(stats.topSessions).toHaveLength(0);
    });

    it('should count crashes by type', () => {
      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10001,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10002,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10003,
        exitCode: 0,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'ready' as WorkerStatus,
      });

      const stats = logger.getStats();
      expect(stats.byType.oom_killed).toBe(1);
      expect(stats.byType.crashed).toBe(1);
      expect(stats.byType.graceful).toBe(1);
    });

    it('should track session crash counts', () => {
      logger.recordCrash({
        sessionPath: '/test/problematic',
        pid: 10001,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/problematic',
        pid: 10002,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/stable',
        pid: 10003,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      const stats = logger.getStats();
      expect(stats.topSessions).toHaveLength(2);
      expect(stats.topSessions[0].sessionPath).toBe('/test/problematic');
      expect(stats.topSessions[0].crashCount).toBe(2);
      expect(stats.topSessions[1].crashCount).toBe(1);
    });

    it('should calculate OOM average lifetime', () => {
      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10001,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 10000, // 10 seconds ago
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10002,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 20000, // 20 seconds ago
        previousStatus: 'streaming' as WorkerStatus,
      });

      const stats = logger.getStats();
      expect(stats.oomStats.total).toBe(2);
      expect(stats.oomStats.averageLifetimeMs).toBeGreaterThanOrEqual(14000);
      expect(stats.oomStats.averageLifetimeMs).toBeLessThanOrEqual(16000);
    });
  });

  describe('getSessionCrashCount', () => {
    it('should return crash count for specific session', () => {
      logger.recordCrash({
        sessionPath: '/test/problematic',
        pid: 10001,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/problematic',
        pid: 10002,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(logger.getSessionCrashCount('/test/problematic')).toBe(2);
      expect(logger.getSessionCrashCount('/test/stable')).toBe(0);
    });
  });

  describe('getRecentOOMs', () => {
    it('should return only OOM kills', () => {
      logger.recordCrash({
        sessionPath: '/test/session-1',
        pid: 10001,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session-2',
        pid: 10002,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      logger.recordCrash({
        sessionPath: '/test/session-3',
        pid: 10003,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      const ooms = logger.getRecentOOMs();
      expect(ooms).toHaveLength(2);
      expect(ooms.every(r => r.type === 'oom_killed')).toBe(true);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        logger.recordCrash({
          sessionPath: `/test/session-${i}`,
          pid: 10000 + i,
          exitCode: null,
          signal: 'SIGKILL',
          memoryLimitMB: 512,
          spawnedAt: Date.now() - 1000,
          previousStatus: 'streaming' as WorkerStatus,
        });
      }

      const ooms = logger.getRecentOOMs(3);
      expect(ooms).toHaveLength(3);
    });
  });

  describe('hasRecentOOMs', () => {
    it('should return true if OOM in specified window', () => {
      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10001,
        exitCode: null,
        signal: 'SIGKILL',
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(logger.hasRecentOOMs(60 * 60 * 1000)).toBe(true);
    });

    it('should return false if no recent OOMs', () => {
      expect(logger.hasRecentOOMs(60 * 60 * 1000)).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all records', () => {
      logger.recordCrash({
        sessionPath: '/test/session',
        pid: 10001,
        exitCode: 1,
        signal: null,
        memoryLimitMB: 512,
        spawnedAt: Date.now() - 1000,
        previousStatus: 'streaming' as WorkerStatus,
      });

      expect(logger.getRecords()).toHaveLength(1);
      expect(logger.getSessionCrashCount('/test/session')).toBe(1);

      logger.clear();

      expect(logger.getRecords()).toHaveLength(0);
      expect(logger.getSessionCrashCount('/test/session')).toBe(0);
    });
  });
});

describe('getCrashLogger', () => {
  beforeEach(() => {
    resetCrashLogger();
  });

  it('should return singleton instance', () => {
    const logger1 = getCrashLogger({ logToConsole: false });
    const logger2 = getCrashLogger();

    expect(logger1).toBe(logger2);
  });

  it('should use config on first call only', () => {
    const logger1 = getCrashLogger({ maxRecords: 50, logToConsole: false });
    const logger2 = getCrashLogger({ maxRecords: 200, logToConsole: true });

    // Second config should be ignored
    expect(logger1).toBe(logger2);
  });
});
