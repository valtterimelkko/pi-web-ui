import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cancel } from '../../../../src/protocol/methods/cancel.js';
import type { MethodContext, CancelParams } from '../../../../src/protocol/methods/types.js';
import type { MultiSessionManager, SessionStatusInfo } from '../../../../src/pi/multi-session-manager.js';
import WebSocket from 'ws';

// Mock agent session
const mockAgentSession = {
  abort: vi.fn(),
  sessionId: 'agent-session-id',
  sessionFile: '/path/to/session.jsonl',
};

// Mock MultiSessionManager
const mockMultiSessionManager = {
  getAgentSession: vi.fn().mockReturnValue(mockAgentSession),
  getSessionStatus: vi.fn().mockReturnValue({
    sessionPath: '/path/to/session.jsonl',
    sessionId: 'test-session-id',
    status: 'streaming',
    lastActivity: new Date(),
    messageCount: 5,
    currentStep: 1,
    subscriberCount: 1,
  } as SessionStatusInfo),
  updateSessionStatus: vi.fn(),
} as unknown as MultiSessionManager;

// Mock WebSocket
const mockWs = {} as WebSocket;

// Create test context
const createTestContext = (): MethodContext => ({
  sessionId: 'test-session-id',
  sessionPath: '/path/to/session.jsonl',
  ws: mockWs,
  multiSessionManager: mockMultiSessionManager,
  requestId: 'test-request-id',
  clientId: 'test-client-id',
});

describe('Cancel Method Handler', () => {
  let context: MethodContext;

  beforeEach(() => {
    context = createTestContext();
    vi.clearAllMocks();
    mockAgentSession.abort.mockResolvedValue(undefined);
    mockMultiSessionManager.getAgentSession.mockReturnValue(mockAgentSession);
    mockMultiSessionManager.getSessionStatus.mockReturnValue({
      sessionPath: '/path/to/session.jsonl',
      sessionId: 'test-session-id',
      status: 'streaming',
      lastActivity: new Date(),
      messageCount: 5,
      currentStep: 1,
      subscriberCount: 1,
    });
  });

  describe('Session Not Found', () => {
    it('should return cancelled: false when session not found', async () => {
      mockMultiSessionManager.getAgentSession.mockReturnValue(undefined);

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(false);
      expect(result.message).toContain('Session not found');
    });

    it('should return cancelled: false when status unavailable', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue(undefined);

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(false);
      expect(result.message).toContain('Session status unavailable');
    });
  });

  describe('State Validation', () => {
    it('should not cancel when session is idle', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue({
        sessionPath: '/path/to/session.jsonl',
        sessionId: 'test-session-id',
        status: 'idle',
        lastActivity: new Date(),
        messageCount: 5,
        currentStep: 1,
        subscriberCount: 1,
      });

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(false);
      expect(result.message).toContain('not in a cancellable state');
      expect(mockAgentSession.abort).not.toHaveBeenCalled();
    });

    it('should not cancel when session is in error state', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue({
        sessionPath: '/path/to/session.jsonl',
        sessionId: 'test-session-id',
        status: 'error',
        lastActivity: new Date(),
        messageCount: 5,
        currentStep: 1,
        subscriberCount: 1,
      });

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(false);
      expect(result.message).toContain('not in a cancellable state');
    });
  });

  describe('Successful Cancellation', () => {
    it('should cancel when session is streaming', async () => {
      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(true);
      expect(result.message).toContain('cancelled successfully');
      expect(mockAgentSession.abort).toHaveBeenCalled();
    });

    it('should cancel when session is busy', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue({
        sessionPath: '/path/to/session.jsonl',
        sessionId: 'test-session-id',
        status: 'busy',
        lastActivity: new Date(),
        messageCount: 5,
        currentStep: 1,
        subscriberCount: 1,
      });

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(true);
      expect(mockAgentSession.abort).toHaveBeenCalled();
    });

    it('should update session status to idle after cancel', async () => {
      const params: CancelParams = {};
      await cancel(params, context);

      expect(mockMultiSessionManager.updateSessionStatus).toHaveBeenCalledWith(
        '/path/to/session.jsonl',
        'idle'
      );
    });

    it('should accept reason parameter', async () => {
      const params: CancelParams = { reason: 'User requested' };
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(true);
    });

    it('should accept requestId parameter', async () => {
      const params: CancelParams = { requestId: 'request-123' };
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(true);
    });

    it('should work with empty params', async () => {
      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle abort errors gracefully', async () => {
      mockAgentSession.abort.mockRejectedValue(new Error('Abort failed'));

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(false);
      expect(result.message).toContain('Failed to cancel');
      expect(result.message).toContain('Abort failed');
    });

    it('should handle unknown errors', async () => {
      mockAgentSession.abort.mockRejectedValue('Unknown error');

      const params: CancelParams = {};
      const result = await cancel(params, context);

      expect(result.cancelled).toBe(false);
      expect(result.message).toContain('Unknown error');
    });
  });
});
