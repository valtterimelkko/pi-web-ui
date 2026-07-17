import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import type { RPCEvent } from '../../../src/workers/types.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import { getCrashLogger, resetCrashLogger } from '../../../src/workers/crash-logger.js';

describe('SessionWorker', () => {
  let worker: SessionWorker;

  const testOptions = {
    sessionPath: '/tmp/test-session.jsonl',
    maxOldSpaceSize: 256,
  };

  beforeEach(() => {
    worker = new SessionWorker(testOptions);
  });

  afterEach(async () => {
    resetCrashLogger();
    if (worker) {
      await worker.terminate();
    }
  });

  describe('constructor', () => {
    it('should initialize with correct session path', () => {
      expect(worker.sessionPath).toBe('/tmp/test-session.jsonl');
    });

    it('should start in spawning status', () => {
      expect(worker.status).toBe('spawning');
    });
  });

  describe('subscribe', () => {
    it('should allow event subscription', () => {
      const handler = vi.fn();
      const unsubscribe = worker.subscribe(handler);
      
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  // Note: Actual spawn tests require the pi binary and are integration tests
  it('should track stable spawn and activity timestamps', () => {
    const initial = worker.lastActivity;
    expect(initial).toBeGreaterThan(0);
    expect(worker.spawnedAt).toBeGreaterThan(0);
  });

  it('does not classify a normal zero-code exit as a crash', () => {
    const crashLogger = getCrashLogger({ logToConsole: false });
    (worker as unknown as { handleExit(code: number | null, signal: string | null): void }).handleExit(0, null);
    expect(crashLogger.getStats().totalCrashes).toBe(0);
  });

  it('records a warning and metric when readiness uses the bounded fallback', async () => {
    const metrics = new OperationalMetrics();
    const fallbackWorker = new SessionWorker(testOptions, { metrics, readinessFallbackMs: 5 });
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    try {
      await (fallbackWorker as unknown as { waitForReady(timeout?: number): Promise<void> }).waitForReady(100);
      expect(metrics.snapshot().pipeline.workerReadinessFallbacks).toBe(1);
      expect(records.some((record) =>
        record.component === 'SessionWorker'
        && record.level === 'warn'
        && record.msg.includes('readiness fallback'),
      )).toBe(true);
    } finally {
      setLogTap(null);
      await fallbackWorker.terminate();
    }
  });
});
