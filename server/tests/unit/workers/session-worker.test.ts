import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import type { RPCEvent } from '../../../src/workers/types.js';

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
  it('should track last activity', () => {
    const initial = worker.lastActivity;
    expect(initial).toBeGreaterThan(0);
  });
});
