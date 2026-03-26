import { describe, it, expect, vi, beforeEach } from 'vitest';
import { steer } from '../../../../src/protocol/methods/steer.js';
import type { MethodContext, SteerParams } from '../../../../src/protocol/methods/types.js';
import type { MultiSessionManager, SessionStatusInfo } from '../../../../src/pi/multi-session-manager.js';
import WebSocket from 'ws';

// Mock agent session
const mockAgentSession = {
  steer: vi.fn(),
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

describe('Steer Method Handler', () => {
  let context: MethodContext;

  beforeEach(() => {
    context = createTestContext();
    vi.clearAllMocks();
    mockAgentSession.steer.mockResolvedValue(undefined);
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

  describe('Validation', () => {
    it('should reject empty message', async () => {
      const params: SteerParams = { message: '' };

      await expect(steer(params, context)).rejects.toThrow(
        'Invalid steer: message must be a non-empty string'
      );
    });

    it('should reject whitespace-only message', async () => {
      const params: SteerParams = { message: '   ' };

      await expect(steer(params, context)).rejects.toThrow(
        'Invalid steer: message cannot be empty or whitespace only'
      );
    });

    it('should reject non-string message', async () => {
      const params = { message: 123 } as unknown as SteerParams;

      await expect(steer(params, context)).rejects.toThrow(
        'Invalid steer: message must be a non-empty string'
      );
    });

    it('should reject missing message', async () => {
      const params = {} as SteerParams;

      await expect(steer(params, context)).rejects.toThrow(
        'Invalid steer: message must be a non-empty string'
      );
    });
  });

  describe('Session Handling', () => {
    it('should reject when session not found', async () => {
      mockMultiSessionManager.getAgentSession.mockReturnValue(undefined);

      const params: SteerParams = { message: 'steer message' };

      await expect(steer(params, context)).rejects.toThrow(
        'Session not found: /path/to/session.jsonl'
      );
    });

    it('should reject when session status unavailable', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue(undefined);

      const params: SteerParams = { message: 'steer message' };

      await expect(steer(params, context)).rejects.toThrow(
        'Session status unavailable'
      );
    });
  });

  describe('State Validation', () => {
    it('should reject when session is idle', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue({
        sessionPath: '/path/to/session.jsonl',
        sessionId: 'test-session-id',
        status: 'idle',
        lastActivity: new Date(),
        messageCount: 5,
        currentStep: 1,
        subscriberCount: 1,
      });

      const params: SteerParams = { message: 'steer message' };
      const result = await steer(params, context);

      expect(result.accepted).toBe(false);
      expect(result.message).toContain('only valid during streaming');
      expect(result.message).toContain('idle');
    });

    it('should reject when session is busy (not streaming)', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue({
        sessionPath: '/path/to/session.jsonl',
        sessionId: 'test-session-id',
        status: 'busy',
        lastActivity: new Date(),
        messageCount: 5,
        currentStep: 1,
        subscriberCount: 1,
      });

      const params: SteerParams = { message: 'steer message' };
      const result = await steer(params, context);

      expect(result.accepted).toBe(false);
      expect(result.message).toContain('only valid during streaming');
    });

    it('should reject when session is in error state', async () => {
      mockMultiSessionManager.getSessionStatus.mockReturnValue({
        sessionPath: '/path/to/session.jsonl',
        sessionId: 'test-session-id',
        status: 'error',
        lastActivity: new Date(),
        messageCount: 5,
        currentStep: 1,
        subscriberCount: 1,
      });

      const params: SteerParams = { message: 'steer message' };
      const result = await steer(params, context);

      expect(result.accepted).toBe(false);
    });
  });

  describe('Successful Steering', () => {
    it('should accept steer when session is streaming', async () => {
      const params: SteerParams = { message: 'Please focus on X' };
      const result = await steer(params, context);

      expect(result.accepted).toBe(true);
      expect(result.message).toContain('accepted');
      expect(mockAgentSession.steer).toHaveBeenCalledWith('Please focus on X');
    });

    it('should generate request ID if not provided', async () => {
      const params: SteerParams = { message: 'steer message' };
      const result = await steer(params, context);

      expect(result.requestId).toBeDefined();
      expect(typeof result.requestId).toBe('string');
      expect(result.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should use provided request ID', async () => {
      const params: SteerParams = { message: 'steer message', requestId: 'custom-id' };
      const result = await steer(params, context);

      expect(result.requestId).toBe('custom-id');
    });
  });

  describe('Error Handling', () => {
    it('should handle steer errors gracefully', async () => {
      mockAgentSession.steer.mockRejectedValue(new Error('Steer failed'));

      const params: SteerParams = { message: 'steer message' };
      const result = await steer(params, context);

      expect(result.accepted).toBe(false);
      expect(result.message).toContain('Failed to steer');
      expect(result.message).toContain('Steer failed');
    });

    it('should handle unknown errors', async () => {
      mockAgentSession.steer.mockRejectedValue('Unknown error');

      const params: SteerParams = { message: 'steer message' };
      const result = await steer(params, context);

      expect(result.accepted).toBe(false);
      expect(result.message).toContain('Unknown error');
    });
  });
});
