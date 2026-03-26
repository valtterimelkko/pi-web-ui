import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionRPCClient } from '../../../src/workers/session-rpc-client.js';
import type { SessionWorker } from '../../../src/workers/session-worker.js';
import type { RPCEvent } from '../../../src/workers/types.js';

// Create a mock worker
const createMockWorker = (): SessionWorker => {
  const subscribers: Set<(event: RPCEvent) => void> = new Set();
  
  return {
    sessionPath: '/tmp/test-session.jsonl',
    status: 'ready',
    pid: 12345,
    lastActivity: Date.now(),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((handler: (event: RPCEvent) => void) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }),
    spawn: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionWorker;
};

describe('SessionRPCClient', () => {
  let client: SessionRPCClient;
  let mockWorker: SessionWorker;

  beforeEach(() => {
    mockWorker = createMockWorker();
    client = new SessionRPCClient(mockWorker);
  });

  describe('constructor', () => {
    it('should initialize with worker', () => {
      expect(client.sessionPath).toBe('/tmp/test-session.jsonl');
    });
  });

  describe('prompt', () => {
    it('should send prompt command', async () => {
      await client.prompt('Hello');
      expect(mockWorker.sendCommand).toHaveBeenCalledWith({
        type: 'prompt',
        message: 'Hello',
        images: undefined,
      });
    });
  });

  describe('steer', () => {
    it('should send steer command', async () => {
      await client.steer('Continue');
      expect(mockWorker.sendCommand).toHaveBeenCalledWith({
        type: 'steer',
        message: 'Continue',
        images: undefined,
      });
    });
  });

  describe('abort', () => {
    it('should send abort command', async () => {
      await client.abort();
      expect(mockWorker.sendCommand).toHaveBeenCalledWith({ type: 'abort' });
    });
  });

  describe('compact', () => {
    it('should send compact command', async () => {
      await client.compact('Custom instructions');
      expect(mockWorker.sendCommand).toHaveBeenCalledWith({
        type: 'compact',
        customInstructions: 'Custom instructions',
      });
    });
  });

  describe('setModel', () => {
    it('should send set_model command', async () => {
      await client.setModel('anthropic', 'claude-3-sonnet');
      expect(mockWorker.sendCommand).toHaveBeenCalledWith({
        type: 'set_model',
        provider: 'anthropic',
        modelId: 'claude-3-sonnet',
      });
    });
  });

  describe('subscribe', () => {
    it('should allow event subscription', () => {
      const handler = vi.fn();
      const unsubscribe = client.subscribe(handler);
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('getWorker', () => {
    it('should return the underlying worker', () => {
      expect(client.getWorker()).toBe(mockWorker);
    });
  });
});
