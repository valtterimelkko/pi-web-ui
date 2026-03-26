import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLegacyConnection, isLegacyMessage } from '../../../src/websocket/legacy-connection.js';

describe('Legacy Connection', () => {
  const mockSend = vi.fn();
  const mockAgentSession = {
    prompt: vi.fn().mockResolvedValue(undefined),
  };
  const mockSessionManager = {
    subscribeClient: vi.fn().mockResolvedValue({}),
    unsubscribeClient: vi.fn(),
    getAgentSession: vi.fn().mockReturnValue(mockAgentSession),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  } as any;
  const mockWs = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createLegacyConnection', () => {
    it('should handle subscribe messages', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage({ type: 'subscribe', sessionId: 'session-1' });

      expect(mockSessionManager.subscribeClient).toHaveBeenCalledWith(
        'client-1',
        'session-1'
      );
    });

    it('should handle unsubscribe messages', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage({ type: 'subscribe', sessionId: 'session-1' });
      await conn.handleMessage({ type: 'unsubscribe', sessionId: 'session-1' });

      expect(mockSessionManager.unsubscribeClient).toHaveBeenCalledWith(
        'client-1',
        'session-1'
      );
    });

    it('should handle prompt messages', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage({
        type: 'prompt',
        sessionId: 'session-1',
        message: 'Hello',
      });

      expect(mockSessionManager.getAgentSession).toHaveBeenCalledWith('session-1');
      expect(mockAgentSession.prompt).toHaveBeenCalledWith('Hello', { images: undefined });
    });

    it('should handle steer messages', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage({
        type: 'steer',
        sessionId: 'session-1',
        message: 'Steer message',
      });

      expect(mockSessionManager.steer).toHaveBeenCalledWith('session-1', 'Steer message');
    });

    it('should handle abort messages', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage({
        type: 'abort',
        sessionId: 'session-1',
      });

      expect(mockSessionManager.abort).toHaveBeenCalledWith('session-1');
    });

    it('should cleanup on close', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage({ type: 'subscribe', sessionId: 'session-1' });
      await conn.handleMessage({ type: 'subscribe', sessionId: 'session-2' });
      conn.close();

      expect(mockSessionManager.unsubscribeClient).toHaveBeenCalledTimes(2);
    });

    it('should handle missing session gracefully', async () => {
      mockSessionManager.getAgentSession.mockReturnValueOnce(null);

      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      // Should not throw
      await conn.handleMessage({
        type: 'prompt',
        sessionId: 'non-existent-session',
        message: 'Hello',
      });

      expect(mockAgentSession.prompt).not.toHaveBeenCalled();
    });

    it('should ignore non-object messages', async () => {
      const conn = createLegacyConnection({
        ws: mockWs,
        clientId: 'client-1',
        sessionManager: mockSessionManager,
        send: mockSend,
      });

      await conn.handleMessage('string');
      await conn.handleMessage(123);
      await conn.handleMessage(null);

      expect(mockSessionManager.subscribeClient).not.toHaveBeenCalled();
    });
  });

  describe('isLegacyMessage', () => {
    it('should identify legacy messages', () => {
      expect(isLegacyMessage({ type: 'prompt', sessionId: 's1' })).toBe(true);
      expect(isLegacyMessage({ type: 'subscribe', sessionId: 's1' })).toBe(true);
      expect(isLegacyMessage({ type: 'unsubscribe', sessionId: 's1' })).toBe(true);
      expect(isLegacyMessage({ type: 'steer', sessionId: 's1' })).toBe(true);
      expect(isLegacyMessage({ type: 'abort', sessionId: 's1' })).toBe(true);
    });

    it('should reject non-legacy messages', () => {
      expect(isLegacyMessage(null)).toBe(false);
      expect(isLegacyMessage({ type: 'prompt' })).toBe(false);
      expect(isLegacyMessage('string')).toBe(false);
      expect(isLegacyMessage(123)).toBe(false);
      expect(isLegacyMessage({ jsonrpc: '2.0', method: 'test' })).toBe(false);
      expect(isLegacyMessage({})).toBe(false);
    });
  });
});
