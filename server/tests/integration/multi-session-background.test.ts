import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Type definitions for mocking
export type SessionStatus = 'idle' | 'busy' | 'streaming' | 'error';

export interface MockAgentSession {
  sessionId: string;
  sessionPath: string;
  subscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

export interface MockPiService {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  setEventHandler: ReturnType<typeof vi.fn>;
  removeEventHandler: ReturnType<typeof vi.fn>;
}

// Mock the pi-coding-agent module
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn().mockReturnValue({}),
    open: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
  },
  AuthStorage: {
    create: vi.fn().mockReturnValue({
      getAll: vi.fn().mockReturnValue([]),
    }),
  },
  ModelRegistry: vi.fn().mockImplementation(() => ({
    getAvailable: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    find: vi.fn().mockReturnValue(null),
    getError: vi.fn().mockReturnValue(null),
  })),
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
  })),
}));

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
  },
}));

/**
 * Helper to create a mock AgentSession with full capabilities
 */
function createMockAgentSession(overrides: Partial<MockAgentSession> = {}): MockAgentSession {
  const sessionId = overrides.sessionId || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  return {
    sessionId,
    sessionPath: '/default/session/path.jsonl',
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setModel: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Helper to create a mock PiService
 */
function createMockPiService(overrides: Partial<MockPiService> = {}): MockPiService {
  return {
    createSession: vi.fn().mockResolvedValue(createMockAgentSession()),
    getSession: vi.fn(),
    setEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    ...overrides,
  };
}

/**
 * Helper to create a mock broadcast function that tracks all messages
 */
function createMockBroadcast() {
  const messages: Array<{ clientId: string; message: any }> = [];
  
  const broadcast = vi.fn((clientId: string, message: any) => {
    messages.push({ clientId, message });
  });
  
  return { broadcast, messages, clearMessages: () => { messages.length = 0; } };
}

describe('MultiSessionManager - Background Session Integration', () => {
  let mockPiService: MockPiService;
  let mockBroadcast: ReturnType<typeof createMockBroadcast>;
  let MultiSessionManager: typeof import('../../../src/pi/multi-session-manager.js').MultiSessionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPiService = createMockPiService();
    mockBroadcast = createMockBroadcast();

    // Clear module cache to get fresh import
    vi.resetModules();
    
    // Mock the PiService module before importing MultiSessionManager
    vi.mock('../../src/pi/pi-service.js', () => ({
      getPiService: () => mockPiService,
      PiService: class {},
    }));

    // Import MultiSessionManager after mocks are set up
    const module = await import('../../src/pi/multi-session-manager.js');
    MultiSessionManager = module.MultiSessionManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Session Switching - Background Retention', () => {
    it('should NOT dispose Session A when client switches to Session B', async () => {
      // Create two mock sessions
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Client subscribes to Session A
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      expect(mockPiService.createSession).toHaveBeenCalledTimes(1);
      expect(manager.hasSession('/path/to/session-a.jsonl')).toBe(true);

      // Client subscribes to Session B (switches context)
      await manager.subscribeClient('client-1', '/path/to/session-b.jsonl');
      expect(mockPiService.createSession).toHaveBeenCalledTimes(2);

      // Session A should still exist and NOT be disposed
      expect(manager.hasSession('/path/to/session-a.jsonl')).toBe(true);
      expect(mockSessionA.dispose).not.toHaveBeenCalled();
      
      // Session B should also exist
      expect(manager.hasSession('/path/to/session-b.jsonl')).toBe(true);
      
      // Client should be subscribed to both sessions
      const subscriptions = manager.getClientSubscriptions('client-1');
      expect(subscriptions).toContain('/path/to/session-a.jsonl');
      expect(subscriptions).toContain('/path/to/session-b.jsonl');
    });

    it('should keep Session A streaming when client switches to Session B', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Client subscribes to Session A and starts streaming
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      manager.updateSessionStatus('/path/to/session-a.jsonl', 'streaming');
      
      // Verify streaming status
      let statusA = manager.getSessionStatus('/path/to/session-a.jsonl');
      expect(statusA?.status).toBe('streaming');

      // Client subscribes to Session B (while A is streaming)
      await manager.subscribeClient('client-1', '/path/to/session-b.jsonl');
      
      // Session A should still be streaming
      statusA = manager.getSessionStatus('/path/to/session-a.jsonl');
      expect(statusA?.status).toBe('streaming');
      
      // Session B should be idle
      const statusB = manager.getSessionStatus('/path/to/session-b.jsonl');
      expect(statusB?.status).toBe('idle');
      
      // Session A should NOT be disposed
      expect(mockSessionA.dispose).not.toHaveBeenCalled();
    });

    it('should allow client to switch back to Session A and find it still active', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Initial subscribe to Session A
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      manager.updateSessionStatus('/path/to/session-a.jsonl', 'streaming');
      
      // Switch to Session B
      await manager.subscribeClient('client-1', '/path/to/session-b.jsonl');
      
      // Simulate some activity on Session A while client is viewing B
      manager.handleAgentEvent('/path/to/session-a.jsonl', { 
        type: 'message_start',
        message: { id: 'msg-1', role: 'assistant' }
      });
      manager.handleAgentEvent('/path/to/session-a.jsonl', { 
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' }
      });

      // Switch back to Session A
      const statusA = manager.getSessionStatus('/path/to/session-a.jsonl');
      expect(statusA).toBeDefined();
      expect(statusA?.sessionId).toBe('session-a');
      expect(statusA?.messageCount).toBe(2); // Messages received while on Session B
      
      // Session should still be subscribed
      expect(manager.getClientSubscriptions('client-1')).toContain('/path/to/session-a.jsonl');
      
      // No new session should be created when switching back
      expect(mockPiService.createSession).toHaveBeenCalledTimes(2);
    });

    it('should maintain separate state for each background session', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });
      const mockSessionC = createMockAgentSession({
        sessionId: 'session-c',
        sessionPath: '/path/to/session-c.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB)
        .mockResolvedValueOnce(mockSessionC);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Subscribe to all three sessions
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      await manager.subscribeClient('client-1', '/path/to/session-b.jsonl');
      await manager.subscribeClient('client-1', '/path/to/session-c.jsonl');

      // Set different states
      manager.updateSessionStatus('/path/to/session-a.jsonl', 'streaming');
      manager.updateSessionStatus('/path/to/session-b.jsonl', 'busy');
      manager.updateSessionStatus('/path/to/session-c.jsonl', 'idle');

      // Add messages to each
      manager.handleAgentEvent('/path/to/session-a.jsonl', { type: 'message_start', message: { id: 'a1' } });
      manager.handleAgentEvent('/path/to/session-a.jsonl', { type: 'message_start', message: { id: 'a2' } });
      manager.handleAgentEvent('/path/to/session-b.jsonl', { type: 'message_start', message: { id: 'b1' } });
      manager.handleAgentEvent('/path/to/session-c.jsonl', { type: 'message_start', message: { id: 'c1' } });
      manager.handleAgentEvent('/path/to/session-c.jsonl', { type: 'message_start', message: { id: 'c2' } });
      manager.handleAgentEvent('/path/to/session-c.jsonl', { type: 'message_start', message: { id: 'c3' } });

      // Verify each session maintains its own state
      const statusA = manager.getSessionStatus('/path/to/session-a.jsonl');
      const statusB = manager.getSessionStatus('/path/to/session-b.jsonl');
      const statusC = manager.getSessionStatus('/path/to/session-c.jsonl');

      expect(statusA?.status).toBe('streaming');
      expect(statusA?.messageCount).toBe(2);
      
      expect(statusB?.status).toBe('busy');
      expect(statusB?.messageCount).toBe(1);
      
      expect(statusC?.status).toBe('idle');
      expect(statusC?.messageCount).toBe(3);

      // All sessions should exist
      expect(manager.getAllSessionStatuses().length).toBe(3);
    });
  });

  describe('Multiple Clients - Shared Session', () => {
    it('should allow multiple clients to subscribe to the same session', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'shared-session',
        sessionPath: '/path/to/shared.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Three clients subscribe to the same session
      await manager.subscribeClient('client-1', '/path/to/shared.jsonl');
      await manager.subscribeClient('client-2', '/path/to/shared.jsonl');
      await manager.subscribeClient('client-3', '/path/to/shared.jsonl');

      // Session should be created only once
      expect(mockPiService.createSession).toHaveBeenCalledTimes(1);

      // All clients should be subscribers
      const status = manager.getSessionStatus('/path/to/shared.jsonl');
      expect(status?.subscriberCount).toBe(3);

      // Each client should have the session in their subscriptions
      expect(manager.getClientSubscriptions('client-1')).toContain('/path/to/shared.jsonl');
      expect(manager.getClientSubscriptions('client-2')).toContain('/path/to/shared.jsonl');
      expect(manager.getClientSubscriptions('client-3')).toContain('/path/to/shared.jsonl');
    });

    it('should broadcast events to all subscribed clients', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'shared-session',
        sessionPath: '/path/to/shared.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Subscribe multiple clients
      await manager.subscribeClient('client-1', '/path/to/shared.jsonl');
      await manager.subscribeClient('client-2', '/path/to/shared.jsonl');
      await manager.subscribeClient('client-3', '/path/to/shared.jsonl');

      mockBroadcast.clearMessages();

      // Simulate an agent event
      manager.handleAgentEvent('/path/to/shared.jsonl', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'assistant', content: 'Hello everyone' }
      });

      // Should broadcast to all three clients
      expect(mockBroadcast.broadcast).toHaveBeenCalledTimes(3);
      
      // Verify each client received the message
      const client1Received = mockBroadcast.messages.find(m => m.clientId === 'client-1');
      const client2Received = mockBroadcast.messages.find(m => m.clientId === 'client-2');
      const client3Received = mockBroadcast.messages.find(m => m.clientId === 'client-3');

      expect(client1Received).toBeDefined();
      expect(client2Received).toBeDefined();
      expect(client3Received).toBeDefined();

      // All should receive session_event wrapper with message_start inside
      expect(client1Received?.message.type).toBe('session_event');
      expect((client1Received?.message as any).event?.type).toBe('message_start');
      expect(client2Received?.message.type).toBe('session_event');
      expect((client2Received?.message as any).event?.type).toBe('message_start');
      expect(client3Received?.message.type).toBe('session_event');
      expect((client3Received?.message as any).event?.type).toBe('message_start');
    });

    it('should continue session for remaining clients when one unsubscribes', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'shared-session',
        sessionPath: '/path/to/shared.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Subscribe three clients
      await manager.subscribeClient('client-1', '/path/to/shared.jsonl');
      await manager.subscribeClient('client-2', '/path/to/shared.jsonl');
      await manager.subscribeClient('client-3', '/path/to/shared.jsonl');

      // Client 2 unsubscribes
      manager.unsubscribeClient('client-2', '/path/to/shared.jsonl');

      // Session should still exist
      expect(manager.hasSession('/path/to/shared.jsonl')).toBe(true);
      
      // Session should NOT be disposed
      expect(mockSession.dispose).not.toHaveBeenCalled();

      // Remaining subscribers
      const status = manager.getSessionStatus('/path/to/shared.jsonl');
      expect(status?.subscriberCount).toBe(2);

      // Unsubscribed client should no longer receive events
      mockBroadcast.clearMessages();
      manager.handleAgentEvent('/path/to/shared.jsonl', { type: 'agent_start' });
      
      expect(mockBroadcast.broadcast).toHaveBeenCalledTimes(2);
      expect(mockBroadcast.messages.find(m => m.clientId === 'client-2')).toBeUndefined();
    });

    it('should keep session alive when streaming even if all but one client unsubscribes', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'streaming-session',
        sessionPath: '/path/to/streaming.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Subscribe multiple clients and start streaming
      await manager.subscribeClient('client-1', '/path/to/streaming.jsonl');
      await manager.subscribeClient('client-2', '/path/to/streaming.jsonl');
      manager.updateSessionStatus('/path/to/streaming.jsonl', 'streaming');

      // All but one unsubscribe
      manager.unsubscribeClient('client-2', '/path/to/streaming.jsonl');

      // Session should still exist and be streaming
      const status = manager.getSessionStatus('/path/to/streaming.jsonl');
      expect(status?.status).toBe('streaming');
      expect(status?.subscriberCount).toBe(1);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should handle mixed subscriptions where clients have different session sets', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Client 1: A only
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      
      // Client 2: A and B
      await manager.subscribeClient('client-2', '/path/to/session-a.jsonl');
      await manager.subscribeClient('client-2', '/path/to/session-b.jsonl');
      
      // Client 3: B only
      await manager.subscribeClient('client-3', '/path/to/session-b.jsonl');

      // Verify session A has 2 subscribers
      const statusA = manager.getSessionStatus('/path/to/session-a.jsonl');
      expect(statusA?.subscriberCount).toBe(2);

      // Verify session B has 2 subscribers
      const statusB = manager.getSessionStatus('/path/to/session-b.jsonl');
      expect(statusB?.subscriberCount).toBe(2);

      // Client 2 unsubscribes from A
      manager.unsubscribeClient('client-2', '/path/to/session-a.jsonl');

      // Session A should still have 1 subscriber (client-1)
      const statusAAfter = manager.getSessionStatus('/path/to/session-a.jsonl');
      expect(statusAAfter?.subscriberCount).toBe(1);

      // Session B should be unaffected
      const statusBAfter = manager.getSessionStatus('/path/to/session-b.jsonl');
      expect(statusBAfter?.subscriberCount).toBe(2);
    });
  });

  describe('Cleanup Behavior', () => {
    it('should NOT clean up sessions that have subscribers', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'active-session',
        sessionPath: '/path/to/active.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);
      
      // Subscribe a client (session has subscribers)
      await manager.subscribeClient('client-1', '/path/to/active.jsonl');
      
      // Run cleanup
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Should not clean up because there are subscribers
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/to/active.jsonl')).toBe(true);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should NOT clean up sessions that are busy', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'busy-session',
        sessionPath: '/path/to/busy.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);
      
      await manager.subscribeClient('client-1', '/path/to/busy.jsonl');
      manager.updateSessionStatus('/path/to/busy.jsonl', 'busy');
      manager.unsubscribeClient('client-1', '/path/to/busy.jsonl');
      
      // Run cleanup
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Should not clean up because sessions persist indefinitely
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/to/busy.jsonl')).toBe(true);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should NOT clean up sessions that are streaming', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'streaming-session',
        sessionPath: '/path/to/streaming.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);
      
      await manager.subscribeClient('client-1', '/path/to/streaming.jsonl');
      manager.updateSessionStatus('/path/to/streaming.jsonl', 'streaming');
      manager.unsubscribeClient('client-1', '/path/to/streaming.jsonl');
      
      // Run cleanup
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Should not clean up because sessions persist indefinitely
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/to/streaming.jsonl')).toBe(true);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should NOT clean up idle sessions (sessions persist indefinitely)', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'idle-session',
        sessionPath: '/path/to/idle.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);
      
      await manager.subscribeClient('client-1', '/path/to/idle.jsonl');
      // Leave session idle (default state)
      manager.unsubscribeClient('client-1', '/path/to/idle.jsonl');
      
      // Run cleanup - should NOT clean up idle sessions
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Should NOT clean up because sessions persist indefinitely
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/to/idle.jsonl')).toBe(true);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should only clean up sessions that are errored with no subscribers', async () => {
      const mockSessionIdle = createMockAgentSession({
        sessionId: 'idle-session',
        sessionPath: '/path/to/idle.jsonl',
      });
      const mockSessionStreaming = createMockAgentSession({
        sessionId: 'streaming-session',
        sessionPath: '/path/to/streaming.jsonl',
      });
      const mockSessionError = createMockAgentSession({
        sessionId: 'error-session',
        sessionPath: '/path/to/error.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionIdle)
        .mockResolvedValueOnce(mockSessionStreaming)
        .mockResolvedValueOnce(mockSessionError);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);
      
      // Setup: Idle, no subs
      await manager.subscribeClient('client-1', '/path/to/idle.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/idle.jsonl');
      
      // Setup: Streaming, no subs
      await manager.subscribeClient('client-2', '/path/to/streaming.jsonl');
      manager.updateSessionStatus('/path/to/streaming.jsonl', 'streaming');
      manager.unsubscribeClient('client-2', '/path/to/streaming.jsonl');
      
      // Setup: Error, no subs
      await manager.subscribeClient('client-3', '/path/to/error.jsonl');
      manager.updateSessionStatus('/path/to/error.jsonl', 'error');
      manager.unsubscribeClient('client-3', '/path/to/error.jsonl');

      // Run cleanup
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Only the errored, no-subscriber session should be cleaned
      expect(cleanedCount).toBe(1);
      expect(manager.hasSession('/path/to/idle.jsonl')).toBe(true);  // Idle persists
      expect(manager.hasSession('/path/to/streaming.jsonl')).toBe(true);  // Streaming persists
      expect(manager.hasSession('/path/to/error.jsonl')).toBe(false);  // Error cleaned up
      
      expect(mockSessionIdle.dispose).not.toHaveBeenCalled();
      expect(mockSessionStreaming.dispose).not.toHaveBeenCalled();
      expect(mockSessionError.dispose).toHaveBeenCalled();
    });

    it('should unload idle sessions after timeout (15 minutes)', async () => {
      vi.useFakeTimers();
      
      const mockSession = createMockAgentSession({
        sessionId: 'old-session',
        sessionPath: '/path/to/old.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      // Create manager with disabled auto-cleanup to avoid timer interference
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast, {
        cleanupIntervalMs: 24 * 60 * 60 * 1000, // 24 hours (effectively disabled)
        idleSessionTimeoutMs: 15 * 60 * 1000, // 15 minutes
        enableMemoryMonitoring: false,
      });
      
      await manager.subscribeClient('client-1', '/path/to/old.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/old.jsonl');
      
      // Advance time by 10 minutes - session should still be there
      vi.advanceTimersByTime(10 * 60 * 1000);
      
      const cleanedCount1 = manager.cleanupInactiveSessions();
      expect(cleanedCount1).toBe(0);
      expect(manager.hasSession('/path/to/old.jsonl')).toBe(true);
      
      // Advance time by another 10 minutes (total 20 minutes, exceeding 15 min timeout)
      vi.advanceTimersByTime(10 * 60 * 1000);
      
      // Now the session should be unloaded
      const cleanedCount2 = manager.cleanupInactiveSessions();
      expect(cleanedCount2).toBe(1);
      expect(manager.hasSession('/path/to/old.jsonl')).toBe(false);
      
      vi.useRealTimers();
    });

    it('should update lastActivity on events to prevent premature cleanup', async () => {
      vi.useFakeTimers();
      
      const mockSession = createMockAgentSession({
        sessionId: 'active-session',
        sessionPath: '/path/to/active.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);
      
      await manager.subscribeClient('client-1', '/path/to/active.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/active.jsonl');
      
      // Advance time by 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      
      // Trigger an event to update lastActivity
      manager.handleAgentEvent('/path/to/active.jsonl', { type: 'message_start', message: { id: '1' } });
      
      // Advance time by another 5 minutes (10 total, but lastActivity is at 5)
      vi.advanceTimersByTime(5 * 60 * 1000);
      
      // Cleanup should NOT clean up because sessions persist indefinitely
      const cleanedCount = manager.cleanupInactiveSessions();
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/to/active.jsonl')).toBe(true);
      
      vi.useRealTimers();
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle client switching between multiple sessions multiple times', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Multiple switches
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      await manager.subscribeClient('client-1', '/path/to/session-b.jsonl');
      
      // Switch back and forth by getting status
      expect(manager.getSessionStatus('/path/to/session-a.jsonl')).toBeDefined();
      expect(manager.getSessionStatus('/path/to/session-b.jsonl')).toBeDefined();
      
      // Both sessions should exist with one subscriber each
      const statusA = manager.getSessionStatus('/path/to/session-a.jsonl');
      const statusB = manager.getSessionStatus('/path/to/session-b.jsonl');
      
      expect(statusA?.subscriberCount).toBe(1);
      expect(statusB?.subscriberCount).toBe(1);
      
      // Only 2 sessions should have been created
      expect(mockPiService.createSession).toHaveBeenCalledTimes(2);
    });

    it('should handle rapid subscribe/unsubscribe without errors', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'rapid-session',
        sessionPath: '/path/to/rapid.jsonl',
      });
      mockPiService.createSession.mockResolvedValue(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Rapid subscribe/unsubscribe cycles
      for (let i = 0; i < 10; i++) {
        await manager.subscribeClient('client-1', '/path/to/rapid.jsonl');
        manager.unsubscribeClient('client-1', '/path/to/rapid.jsonl');
      }

      // Session should exist but have no subscribers
      const status = manager.getSessionStatus('/path/to/rapid.jsonl');
      expect(status?.subscriberCount).toBe(0);
      
      // Session should only be created once
      expect(mockPiService.createSession).toHaveBeenCalledTimes(1);
    });

    it('should handle event broadcasting during session switches', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionPath: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionPath: '/path/to/session-b.jsonl',
      });

      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Subscribe to both sessions
      await manager.subscribeClient('client-1', '/path/to/session-a.jsonl');
      await manager.subscribeClient('client-1', '/path/to/session-b.jsonl');

      mockBroadcast.clearMessages();

      // Events from both sessions should be received
      manager.handleAgentEvent('/path/to/session-a.jsonl', { type: 'agent_start' });
      manager.handleAgentEvent('/path/to/session-b.jsonl', { type: 'message_start', message: { id: '1' } });
      manager.handleAgentEvent('/path/to/session-a.jsonl', { type: 'agent_end' });

      // Should have received 3 events (all broadcast to client-1)
      expect(mockBroadcast.broadcast).toHaveBeenCalledTimes(3);
      
      // Verify event types (now wrapped in session_event)
      const eventTypes = mockBroadcast.messages.map(m => (m.message as any).event?.type);
      expect(eventTypes).toContain('agent_start');
      expect(eventTypes).toContain('message_start');
      expect(eventTypes).toContain('agent_end');
      
      // Verify all events are wrapped in session_event
      const allWrapped = mockBroadcast.messages.every(m => m.message.type === 'session_event');
      expect(allWrapped).toBe(true);
    });

    it('should maintain correct subscriber count through multiple client lifecycle events', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'lifecycle-session',
        sessionPath: '/path/to/lifecycle.jsonl',
      });
      mockPiService.createSession.mockResolvedValue(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast.broadcast);

      // Add clients 1, 2, 3
      await manager.subscribeClient('client-1', '/path/to/lifecycle.jsonl');
      await manager.subscribeClient('client-2', '/path/to/lifecycle.jsonl');
      await manager.subscribeClient('client-3', '/path/to/lifecycle.jsonl');
      expect(manager.getSessionStatus('/path/to/lifecycle.jsonl')?.subscriberCount).toBe(3);

      // Remove client 2
      manager.unsubscribeClient('client-2', '/path/to/lifecycle.jsonl');
      expect(manager.getSessionStatus('/path/to/lifecycle.jsonl')?.subscriberCount).toBe(2);

      // Add client 4
      await manager.subscribeClient('client-4', '/path/to/lifecycle.jsonl');
      expect(manager.getSessionStatus('/path/to/lifecycle.jsonl')?.subscriberCount).toBe(3);

      // Remove all
      manager.unsubscribeClient('client-1', '/path/to/lifecycle.jsonl');
      manager.unsubscribeClient('client-3', '/path/to/lifecycle.jsonl');
      manager.unsubscribeClient('client-4', '/path/to/lifecycle.jsonl');
      expect(manager.getSessionStatus('/path/to/lifecycle.jsonl')?.subscriberCount).toBe(0);
    });
  });
});
