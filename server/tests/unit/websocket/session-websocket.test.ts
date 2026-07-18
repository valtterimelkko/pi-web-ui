import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionWebSocketHandler } from '../../../src/websocket/session-websocket.js';
import { WorkerPool } from '../../../src/workers/worker-pool.js';
import type { SessionWorker } from '../../../src/workers/session-worker.js';

// Mock WorkerPool
vi.mock('../../../src/workers/worker-pool.js', () => ({
  WorkerPool: vi.fn().mockImplementation(() => ({
    getOrCreate: vi.fn().mockResolvedValue({
      sessionPath: '/tmp/test.jsonl',
      status: 'ready',
      pid: 12345,
      subscribe: vi.fn().mockReturnValue(() => {}),
    }),
    getStats: vi.fn().mockReturnValue({ active: 0, idle: 0, total: 0, maxWorkers: 15 }),
  })),
}));

// Mock SessionRPCClient
vi.mock('../../../src/workers/session-rpc-client.js', () => ({
  SessionRPCClient: vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
    sessionPath: '/tmp/test.jsonl',
    status: 'ready',
  })),
}));

describe('SessionWebSocketHandler', () => {
  let handler: SessionWebSocketHandler;
  const mockSend = vi.fn();
  const mockWs = {} as any;
  let mockWorkerPool: WorkerPool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkerPool = new WorkerPool();
    handler = new SessionWebSocketHandler({
      ws: mockWs,
      clientId: 'client-1',
      workerPool: mockWorkerPool,
      send: mockSend,
    });
  });

  describe('handleMessage', () => {
    it('should handle subscribe message', async () => {
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      expect(mockSend).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'subscribed',
        sessionId: '/tmp/test.jsonl',
      }));
    });

    it('should handle unsubscribe message and dispose the worker-level subscription', async () => {
      const { SessionRPCClient } = await import('../../../src/workers/session-rpc-client.js');
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      const client = SessionRPCClient as unknown as vi.Mock;
      const instance = client.mock.results[0]?.value;

      await handler.handleMessage({ type: 'unsubscribe', sessionPath: '/tmp/test.jsonl' });

      expect(instance?.dispose).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'unsubscribed',
      }));
    });

    it('re-subscribing the same path disposes the replaced client', async () => {
      const { SessionRPCClient } = await import('../../../src/workers/session-rpc-client.js');
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      const client = SessionRPCClient as unknown as vi.Mock;
      const first = client.mock.results[0]?.value;

      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });

      expect(first?.dispose).toHaveBeenCalledTimes(1);
      expect(handler.activeSessionCount).toBe(1);
    });

    it('keeps only the newest client when same-path subscriptions overlap', async () => {
      const { SessionRPCClient } = await import('../../../src/workers/session-rpc-client.js');
      const client = SessionRPCClient as unknown as vi.Mock;
      let releaseFirst!: (worker: SessionWorker) => void;
      const firstWorker = new Promise<SessionWorker>((resolve) => { releaseFirst = resolve; });
      const readyWorker = {
        sessionPath: '/tmp/test.jsonl', status: 'ready', pid: 1, subscribe: vi.fn(() => () => {}),
      } as unknown as SessionWorker;
      vi.mocked(mockWorkerPool.getOrCreate)
        .mockImplementationOnce(() => firstWorker)
        .mockResolvedValueOnce(readyWorker);

      const first = handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      await Promise.resolve();
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      releaseFirst(readyWorker);
      await first;

      expect(client).toHaveBeenCalledTimes(1);
      expect(handler.activeSessionCount).toBe(1);
    });

    it('should handle prompt message after subscribe', async () => {
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      await handler.handleMessage({ type: 'prompt', sessionPath: '/tmp/test.jsonl', message: 'Hello' });
      // Should not error
    });

    it('should error on prompt without subscribe', async () => {
      await handler.handleMessage({ type: 'prompt', sessionPath: '/tmp/test.jsonl', message: 'Hello' });
      expect(mockSend).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'error',
      }));
    });
  });

  describe('close', () => {
    it('should clean up subscriptions and dispose worker-level clients', async () => {
      const { SessionRPCClient } = await import('../../../src/workers/session-rpc-client.js');
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      const client = SessionRPCClient as unknown as vi.Mock;
      const instance = client.mock.results[0]?.value;
      expect(handler.activeSessionCount).toBe(1);

      handler.close();

      expect(handler.activeSessionCount).toBe(0);
      expect(instance?.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not install a subscription that finishes resolving after close', async () => {
      const { SessionRPCClient } = await import('../../../src/workers/session-rpc-client.js');
      const client = SessionRPCClient as unknown as vi.Mock;
      let release!: (worker: SessionWorker) => void;
      const pendingWorker = new Promise<SessionWorker>((resolve) => { release = resolve; });
      vi.mocked(mockWorkerPool.getOrCreate).mockImplementationOnce(() => pendingWorker);

      const subscribing = handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      await Promise.resolve();
      handler.close();
      release({
        sessionPath: '/tmp/test.jsonl', status: 'ready', pid: 1, subscribe: vi.fn(() => () => {}),
      } as unknown as SessionWorker);
      await subscribing;

      expect(client).not.toHaveBeenCalled();
      expect(handler.activeSessionCount).toBe(0);
    });
  });

  describe('activeSessionCount', () => {
    it('should start at 0', () => {
      expect(handler.activeSessionCount).toBe(0);
    });

    it('should increment on subscribe', async () => {
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      expect(handler.activeSessionCount).toBe(1);
    });
  });

  describe('set_thinking_level', () => {
    it('should handle set_thinking_level after subscribe', async () => {
      const { SessionRPCClient } = await import('../../../src/workers/session-rpc-client.js');
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      await handler.handleMessage({ type: 'set_thinking_level', sessionPath: '/tmp/test.jsonl', level: 'high' });
      const client = SessionRPCClient as unknown as vi.Mock;
      const instance = client.mock.results[0]?.value;
      expect(instance?.setThinkingLevel).toHaveBeenCalledWith('high');
    });

    it('should silently ignore set_thinking_level without subscribe', async () => {
      await handler.handleMessage({ type: 'set_thinking_level', sessionPath: '/tmp/test.jsonl', level: 'high' });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should silently ignore set_thinking_level without level', async () => {
      await handler.handleMessage({ type: 'subscribe', sessionPath: '/tmp/test.jsonl' });
      await handler.handleMessage({ type: 'set_thinking_level', sessionPath: '/tmp/test.jsonl' } as any);
      expect(mockSend).not.toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'error',
      }));
    });
  });
});
