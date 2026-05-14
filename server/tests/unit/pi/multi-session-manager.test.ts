import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Type definitions for the MultiSessionManager (will be implemented)
export type SessionStatus = 'idle' | 'busy' | 'streaming' | 'error';

export interface ActiveSession {
  sessionPath: string;
  sessionId: string;
  agentSession: MockAgentSession;
  status: SessionStatus;
  subscribers: Set<string>;
  lastActivity: Date;
  lastEventTimestamp: number;
  messageCount: number;
  currentStep: number;
}

export interface SessionStatusInfo {
  sessionPath: string;
  sessionId: string;
  status: SessionStatus;
  lastActivity: Date;
  messageCount: number;
  currentStep: number;
  subscriberCount: number;
}

// Mock types
interface MockAgentSession {
  sessionId: string;
  sessionFile: string;
  sessionPath: string;
  subscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
}

interface MockPiService {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  setEventHandler: ReturnType<typeof vi.fn>;
  removeEventHandler: ReturnType<typeof vi.fn>;
}

// Mock the pi-coding-agent module
vi.mock('@earendil-works/pi-coding-agent', () => ({
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
vi.mock('../../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
  },
}));

/**
 * Helper to create a mock AgentSession
 */
function createMockAgentSession(overrides: Partial<MockAgentSession> = {}): MockAgentSession {
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const sessionFile = `/default/session/${sessionId}.jsonl`;
  return {
    sessionId,
    sessionFile,
    sessionPath: sessionFile,
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setModel: vi.fn(),
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
 * Helper to create a mock broadcast function
 */
function createMockBroadcast() {
  return vi.fn();
}

describe('MultiSessionManager', () => {
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
    vi.mock('../../../src/pi/pi-service.js', () => ({
      getPiService: () => mockPiService,
      PiService: class {},
    }));

    // Import MultiSessionManager after mocks are set up
    const module = await import('../../../src/pi/multi-session-manager.js');
    MultiSessionManager = module.MultiSessionManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with empty sessions map', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      expect(manager).toBeDefined();
    });

    it('should accept options (for future extensibility)', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast, {});
      expect(manager).toBeDefined();
    });
  });

  describe('createAndSubscribe', () => {
    it('should create a new session and subscribe the client', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'new-session-1',
        sessionFile: '/path/to/new-session-1.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      const result = await manager.createAndSubscribe('client-1', '/work');

      expect(result.sessionId).toBe('new-session-1');
      expect(result.status).toBe('idle');
      expect(result.subscriberCount).toBe(1);
    });

    it('should register event handler under the same key passed to createSession', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'handler-key-test',
        sessionFile: '/path/to/handler-key.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.createAndSubscribe('client-1', '/work');

      const setHandlerCalls = mockPiService.setEventHandler.mock.calls;
      const createSessionCalls = mockPiService.createSession.mock.calls;

      expect(setHandlerCalls.length).toBeGreaterThanOrEqual(1);
      expect(createSessionCalls.length).toBeGreaterThanOrEqual(1);

      const handlerKey = setHandlerCalls[0][0] as string;
      const createClientId = createSessionCalls[0][0].clientId as string;

      expect(handlerKey).toBe(createClientId);
      expect(handlerKey).toMatch(/^multi-create-/);
    });

    it('should pass cwd to createSession', async () => {
      const mockSession = createMockAgentSession({
        sessionFile: '/path/to/cwd-test.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.createAndSubscribe('client-1', '/custom/cwd');

      expect(mockPiService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/custom/cwd',
        })
      );
    });

    it('should use unique clientId per session creation (not collide)', async () => {
      const mockSession1 = createMockAgentSession({
        sessionId: 'session-a',
        sessionFile: '/path/to/session-a.jsonl',
      });
      const mockSession2 = createMockAgentSession({
        sessionId: 'session-b',
        sessionFile: '/path/to/session-b.jsonl',
      });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);

      await manager.createAndSubscribe('client-1', '/work');
      await manager.createAndSubscribe('client-1', '/work');

      const createCalls = mockPiService.createSession.mock.calls;
      const setCalls = mockPiService.setEventHandler.mock.calls;

      // Each createSession call used a unique clientId
      expect(createCalls[0][0].clientId).not.toBe(createCalls[1][0].clientId);

      // Each setEventHandler was called with the same key as its corresponding createSession
      expect(setCalls[0][0]).toBe(createCalls[0][0].clientId);
      expect(setCalls[1][0]).toBe(createCalls[1][0].clientId);

      // All keys are unique
      expect(setCalls[0][0]).not.toBe(setCalls[1][0]);
    });

    it('should route events to the correct session when same client creates multiple sessions', async () => {
      const mockSessionA = createMockAgentSession({
        sessionId: 'session-a',
        sessionFile: '/path/to/session-a.jsonl',
      });
      const mockSessionB = createMockAgentSession({
        sessionId: 'session-b',
        sessionFile: '/path/to/session-b.jsonl',
      });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSessionA)
        .mockResolvedValueOnce(mockSessionB);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);

      await manager.createAndSubscribe('client-1', '/work');
      await manager.createAndSubscribe('client-1', '/work');

      mockBroadcast.mockClear();

      manager.handleAgentEvent('/path/to/session-a.jsonl', {
        type: 'message_start',
        message: { id: 'msg-a', role: 'user', content: 'Hello A' },
      });
      manager.handleAgentEvent('/path/to/session-b.jsonl', {
        type: 'message_start',
        message: { id: 'msg-b', role: 'user', content: 'Hello B' },
      });

      const broadcasts = mockBroadcast.mock.calls;
      const sessionABroadcasts = broadcasts.filter(
        (c: any[]) => c[1]?.sessionId === 'session-a'
      );
      const sessionBBroadcasts = broadcasts.filter(
        (c: any[]) => c[1]?.sessionId === 'session-b'
      );

      expect(sessionABroadcasts.length).toBe(1);
      expect(sessionBBroadcasts.length).toBe(1);

      expect(sessionABroadcasts[0][1].event.message.id).toBe('msg-a');
      expect(sessionBBroadcasts[0][1].event.message.id).toBe('msg-b');
    });

    it('should throw if session creation fails to produce a session file', async () => {
      const mockSession = createMockAgentSession({
        sessionFile: undefined as any,
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);

      await expect(manager.createAndSubscribe('client-1', '/work')).rejects.toThrow(
        'Failed to create session file'
      );
      expect(mockSession.dispose).toHaveBeenCalled();
    });

    it('should throw on empty clientId', async () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);

      await expect(manager.createAndSubscribe('', '/work')).rejects.toThrow('Invalid client ID');
    });

    it('should track client subscriptions for multiple created sessions', async () => {
      const mockSession1 = createMockAgentSession({
        sessionFile: '/path/to/s1.jsonl',
      });
      const mockSession2 = createMockAgentSession({
        sessionFile: '/path/to/s2.jsonl',
      });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.createAndSubscribe('client-1', '/work');
      await manager.createAndSubscribe('client-1', '/work');

      const subs = manager.getClientSubscriptions('client-1');
      expect(subs).toContain('/path/to/s1.jsonl');
      expect(subs).toContain('/path/to/s2.jsonl');
      expect(subs.length).toBe(2);
    });

    it('should allow webUIContext to be passed through', async () => {
      const mockSession = createMockAgentSession({
        sessionFile: '/path/to/ctx.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      const webUIContext = { workingDirectory: '/work' } as any;
      const result = await manager.createAndSubscribe('client-1', '/work', webUIContext);

      expect(result).toBeDefined();
    });

    it('should deliver events via the SDK dispatch path (handler key matches createSession clientId)', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'sdk-dispatch-test',
        sessionFile: '/path/to/sdk-dispatch.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.createAndSubscribe('client-1', '/work');

      const createCall = mockPiService.createSession.mock.calls[0];
      const setCall = mockPiService.setEventHandler.mock.calls[0];
      const sdkClientId = createCall[0].clientId;
      const handlerKey = setCall[0];
      const registeredHandler = setCall[1] as (event: any) => void;

      expect(sdkClientId).toBe(handlerKey);

      // Simulate the Pi SDK dispatch: the subscription closure in createSession
      // would look up eventHandlers.get(sdkClientId) and call it.
      // Since the handler was registered under the same key, it should be found.
      registeredHandler({
        type: 'agent_start',
      });
      registeredHandler({
        type: 'message_start',
        message: { id: 'msg-1', role: 'assistant', content: 'Hello' },
      });

      const broadcasts = mockBroadcast.mock.calls.filter(
        (c: any[]) => c[1]?.sessionId === 'sdk-dispatch-test'
      );
      expect(broadcasts.length).toBe(2);
      expect(broadcasts[0][1].event.type).toBe('agent_start');
      expect(broadcasts[1][1].event.type).toBe('message_start');
    });

    it('should clean up handler under tempClientId on stopSession', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'cleanup-test',
        sessionFile: '/path/to/cleanup.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.createAndSubscribe('client-1', '/work');

      const setCall = mockPiService.setEventHandler.mock.calls[0];
      const handlerKey = setCall[0] as string;

      mockPiService.removeEventHandler.mockClear();

      const stopped = manager.stopSession('/path/to/cleanup.jsonl');
      expect(stopped).toBe(true);
      expect(mockPiService.removeEventHandler).toHaveBeenCalledWith(handlerKey);
    });

    it('should clean up handler on failed session creation', async () => {
      const mockSession = createMockAgentSession({
        sessionFile: undefined as any,
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);

      const setCall = mockPiService.setEventHandler.mock.calls;
      await expect(manager.createAndSubscribe('client-1', '/work')).rejects.toThrow(
        'Failed to create session file'
      );

      const handlerKey = setCall[0][0] as string;
      expect(mockPiService.removeEventHandler).toHaveBeenCalledWith(handlerKey);
    });
  });

  describe('subscribeClient', () => {
    it('should create new session when first client subscribes', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'new-session-id',
        sessionPath: '/path/to/session.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      const result = await manager.subscribeClient('client-1', '/path/to/session.jsonl');

      expect(mockPiService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionPath: '/path/to/session.jsonl',
        })
      );
      expect(result.sessionId).toBe('new-session-id');
      expect(result.status).toBe('idle');
    });

    it('should reuse existing session when second client subscribes', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'shared-session-id',
        sessionPath: '/path/to/shared.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      // First client subscribes
      const result1 = await manager.subscribeClient('client-1', '/path/to/shared.jsonl');
      expect(mockPiService.createSession).toHaveBeenCalledTimes(1);
      
      // Second client subscribes to same session path
      const result2 = await manager.subscribeClient('client-2', '/path/to/shared.jsonl');
      
      // Should NOT have created a new session
      expect(mockPiService.createSession).toHaveBeenCalledTimes(1);
      expect(result2.sessionId).toBe('shared-session-id');
      expect(result2.sessionId).toBe(result1.sessionId);
    });

    it('should add client to subscribers list', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Subscribe second client
      await manager.subscribeClient('client-2', '/path/to/session.jsonl');
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.subscriberCount).toBe(2);
    });

    it('should return session status on subscribe', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'status-session',
        sessionPath: '/path/to/status.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      const result = await manager.subscribeClient('client-1', '/path/to/status.jsonl');

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('sessionPath');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('subscriberCount');
      expect(result.status).toBe('idle');
    });

    it('should throw on invalid session path (empty)', async () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      await expect(manager.subscribeClient('client-1', '')).rejects.toThrow('Invalid session path');
    });

    it('should throw on invalid session path (null/undefined)', async () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      await expect(manager.subscribeClient('client-1', null as any)).rejects.toThrow('Invalid session path');
      await expect(manager.subscribeClient('client-1', undefined as any)).rejects.toThrow('Invalid session path');
    });

    it('should throw on empty clientId', async () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      await expect(manager.subscribeClient('', '/path/to/session.jsonl')).rejects.toThrow('Invalid client ID');
    });

    it('should set up event handler for the session', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');

      expect(mockPiService.setEventHandler).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function)
      );
    });

    it('should update lastActivity timestamp on subscribe', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const beforeSubscribe = new Date();
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');

      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.lastActivity.getTime()).toBeGreaterThanOrEqual(beforeSubscribe.getTime());
    });

    it('should pass cwd parameter to createSession when provided', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'cwd-session',
        sessionPath: '/path/to/cwd-session.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      // cwd is the 3rd parameter, webUIContext is the 4th
      await manager.subscribeClient('client-1', '/path/to/cwd-session.jsonl', '/custom/cwd');

      expect(mockPiService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionPath: '/path/to/cwd-session.jsonl',
          cwd: '/custom/cwd',
        })
      );
    });

    it('should work without cwd parameter (backward compatible)', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');

      expect(mockPiService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionPath: '/path/to/session.jsonl',
        })
      );
      // When cwd is not provided, it should be undefined
      const callArgs = mockPiService.createSession.mock.calls[0][0];
      expect(callArgs.cwd).toBeUndefined();
    });
  });

  describe('unsubscribeClient', () => {
    it('should remove client from subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      // Session should still exist but with no subscribers
      expect(status?.subscriberCount).toBe(0);
    });

    it('should keep session alive if other subscribers exist', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      await manager.subscribeClient('client-2', '/path/to/session.jsonl');
      
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Session should still exist for client-2
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(status?.subscriberCount).toBe(1);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should keep session alive if agent is busy', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      const result = await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Mark session as busy
      manager.updateSessionStatus('/path/to/session.jsonl', 'busy');
      
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Session should still exist because it's busy
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should keep session alive if agent is streaming', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Mark session as streaming
      manager.updateSessionStatus('/path/to/session.jsonl', 'streaming');
      
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Session should still exist because it's streaming
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should mark idle session for cleanup when no subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Session is idle by default
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Session should still exist but be eligible for cleanup
      // (cleanup happens via cleanupInactiveSessions method)
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
    });

    it('should handle unsubscribe for non-existent client gracefully', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      expect(() => manager.unsubscribeClient('non-existent', '/path/to/session.jsonl')).not.toThrow();
    });

    it('should handle unsubscribe for non-existent session gracefully', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      expect(() => manager.unsubscribeClient('client-1', '/non/existent/session.jsonl')).not.toThrow();
    });

    it('should remove client from clientSubscriptions map', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      const subscriptionsBefore = manager.getClientSubscriptions('client-1');
      expect(subscriptionsBefore).toContain('/path/to/session.jsonl');
      
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      const subscriptionsAfter = manager.getClientSubscriptions('client-1');
      expect(subscriptionsAfter).not.toContain('/path/to/session.jsonl');
    });
  });

  describe('broadcastToSubscribers', () => {
    it('should send message to all subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      await manager.subscribeClient('client-2', '/path/to/session.jsonl');
      await manager.subscribeClient('client-3', '/path/to/session.jsonl');
      
      const message = { type: 'test_event', data: 'hello' };
      manager.broadcastToSubscribers('/path/to/session.jsonl', message);
      
      expect(mockBroadcast).toHaveBeenCalledTimes(3);
      expect(mockBroadcast).toHaveBeenCalledWith('client-1', message);
      expect(mockBroadcast).toHaveBeenCalledWith('client-2', message);
      expect(mockBroadcast).toHaveBeenCalledWith('client-3', message);
    });

    it('should handle disconnected clients gracefully', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      // Make broadcast throw for one client (simulating disconnect)
      mockBroadcast.mockImplementation((clientId: string) => {
        if (clientId === 'client-2') {
          throw new Error('Client disconnected');
        }
      });

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      await manager.subscribeClient('client-2', '/path/to/session.jsonl');
      await manager.subscribeClient('client-3', '/path/to/session.jsonl');
      
      const message = { type: 'test_event', data: 'hello' };
      
      // Should not throw even if one client is disconnected
      expect(() => manager.broadcastToSubscribers('/path/to/session.jsonl', message)).not.toThrow();
      
      // Should still attempt to send to all clients
      expect(mockBroadcast).toHaveBeenCalledTimes(3);
    });

    it('should not send to unsubscribed clients', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      await manager.subscribeClient('client-2', '/path/to/session.jsonl');
      
      manager.unsubscribeClient('client-2', '/path/to/session.jsonl');
      
      mockBroadcast.mockClear();
      
      const message = { type: 'test_event', data: 'hello' };
      manager.broadcastToSubscribers('/path/to/session.jsonl', message);
      
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(mockBroadcast).toHaveBeenCalledWith('client-1', message);
      expect(mockBroadcast).not.toHaveBeenCalledWith('client-2', expect.anything());
    });

    it('should do nothing for session with no subscribers', async () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      const message = { type: 'test_event', data: 'hello' };
      manager.broadcastToSubscribers('/non/existent/session.jsonl', message);
      
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should log warning when broadcast fails', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockBroadcast.mockImplementation(() => {
        throw new Error('Send failed');
      });

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      const message = { type: 'test_event', data: 'hello' };
      manager.broadcastToSubscribers('/path/to/session.jsonl', message);
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MultiSessionManager]'),
        expect.any(String)
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('getSessionStatus', () => {
    it('should return status for active session', async () => {
      const mockSession = createMockAgentSession({
        sessionId: 'status-test-session',
        sessionPath: '/path/to/status-test.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/status-test.jsonl');
      
      const status = manager.getSessionStatus('/path/to/status-test.jsonl');
      
      expect(status).toEqual({
        sessionPath: '/path/to/status-test.jsonl',
        sessionId: 'status-test-session',
        status: 'idle',
        lastActivity: expect.any(Date),
        messageCount: 0,
        currentStep: 0,
        subscriberCount: 1,
        pinned: false,
      });
    });

    it('should return undefined for non-existent session', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      const status = manager.getSessionStatus('/non/existent/session.jsonl');
      
      expect(status).toBeUndefined();
    });

    it('should include message count and current step', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Simulate some activity
      manager.incrementMessageCount('/path/to/session.jsonl');
      manager.incrementMessageCount('/path/to/session.jsonl');
      manager.updateCurrentStep('/path/to/session.jsonl', 5);
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      
      expect(status?.messageCount).toBe(2);
      expect(status?.currentStep).toBe(5);
    });

    it('should reflect current status after updates', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.updateSessionStatus('/path/to/session.jsonl', 'streaming');
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('streaming');
    });
  });

  describe('cleanupInactiveSessions', () => {
    it('should NOT remove sessions that are idle (sessions persist indefinitely)', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Run cleanup - should NOT remove idle sessions
      manager.cleanupInactiveSessions();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should not remove sessions with subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.cleanupInactiveSessions();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should not remove sessions that are busy', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.updateSessionStatus('/path/to/session.jsonl', 'busy');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.cleanupInactiveSessions();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should not remove sessions that are streaming', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.updateSessionStatus('/path/to/session.jsonl', 'streaming');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.cleanupInactiveSessions();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should reset stale streaming sessions to idle after 15 minutes without events', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Set session to streaming via agent_start event
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
      
      let status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('streaming');
      
      // Simulate time passing (16 minutes = exceeds 15 minute threshold)
      const originalDateNow = Date.now;
      const sixteenMinutesLater = Date.now() + 16 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(sixteenMinutesLater);
      
      // Run cleanup - should detect stale streaming and reset to idle
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      manager.cleanupInactiveSessions();
      
      // Status should now be idle (reset from streaming)
      status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('idle');
      
      // Should have logged the stale detection
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Detected stale streaming session')
      );
      
      consoleSpy.mockRestore();
      if (typeof (Date.now as any).mockRestore === 'function') {
        (Date.now as any).mockRestore();
      } else {
        vi.restoreAllMocks();
      }
    });

    it('should NOT reset streaming sessions that are still receiving events', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Set session to streaming
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
      
      // Simulate time passing (only 2 minutes)
      const originalDateNow = Date.now;
      const twoMinutesLater = Date.now() + 2 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(twoMinutesLater);
      
      // Run cleanup
      manager.cleanupInactiveSessions();
      
      // Status should still be streaming (not stale yet)
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('streaming');
      
      vi.restoreAllMocks();
    });

    it('should update lastActivity when resetting stale streaming session', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Set session to streaming
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
      
      // Get initial lastActivity
      const initialStatus = manager.getSessionStatus('/path/to/session.jsonl');
      const initialLastActivity = initialStatus?.lastActivity.getTime();
      
      // Wait 6 minutes
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to ensure time passes
      const laterTime = Date.now() + 6 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(laterTime);
      
      manager.cleanupInactiveSessions();
      
      // lastActivity should be updated (to a time after the initial)
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.lastActivity.getTime()).toBeGreaterThanOrEqual(initialLastActivity!);
      
      vi.restoreAllMocks();
    });

    it('should remove sessions that are in error state with no subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.updateSessionStatus('/path/to/session.jsonl', 'error');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.cleanupInactiveSessions();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeUndefined();
      expect(mockSession.dispose).toHaveBeenCalled();
    });

    it('should NOT remove error sessions that still have subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.updateSessionStatus('/path/to/session.jsonl', 'error');
      
      manager.cleanupInactiveSessions();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeDefined();
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should log cleanup actions for errored sessions', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.updateSessionStatus('/path/to/session.jsonl', 'error');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.cleanupInactiveSessions();
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MultiSessionManager] Cleaning up errored session:')
      );
      
      consoleSpy.mockRestore();
    });

    it('should return count of cleaned up sessions (only errored ones)', async () => {
      const mockSession1 = createMockAgentSession({ sessionPath: '/path/1.jsonl' });
      const mockSession2 = createMockAgentSession({ sessionPath: '/path/2.jsonl' });
      const mockSession3 = createMockAgentSession({ sessionPath: '/path/3.jsonl' });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2)
        .mockResolvedValueOnce(mockSession3);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/1.jsonl');
      await manager.subscribeClient('client-2', '/path/2.jsonl');
      await manager.subscribeClient('client-3', '/path/3.jsonl');
      
      // Set session 1 and 2 to error, leave session 3 as idle
      manager.updateSessionStatus('/path/1.jsonl', 'error');
      manager.updateSessionStatus('/path/2.jsonl', 'error');
      
      manager.unsubscribeClient('client-1', '/path/1.jsonl');
      manager.unsubscribeClient('client-2', '/path/2.jsonl');
      manager.unsubscribeClient('client-3', '/path/3.jsonl');
      
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Only the 2 errored sessions should be cleaned up
      expect(cleanedCount).toBe(2);
      
      // Session 3 (idle) should still exist
      expect(manager.getSessionStatus('/path/3.jsonl')).toBeDefined();
    });
  });

  describe('stopSession', () => {
    it('should stop and dispose a session', async () => {
      const mockSession = createMockAgentSession();
      mockSession.abort = vi.fn();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      const result = manager.stopSession('/path/to/session.jsonl');
      
      expect(result).toBe(true);
      expect(mockSession.abort).toHaveBeenCalled();
      expect(mockSession.dispose).toHaveBeenCalled();
      expect(manager.getSessionStatus('/path/to/session.jsonl')).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      const result = manager.stopSession('/non/existent.jsonl');
      
      expect(result).toBe(false);
    });

    it('should clear client viewing references', async () => {
      const mockSession = createMockAgentSession();
      mockSession.abort = vi.fn();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.setClientViewingSession('client-1', '/path/to/session.jsonl');
      
      manager.stopSession('/path/to/session.jsonl');
      
      expect(manager.getClientSessionPath('client-1')).toBeUndefined();
    });

    it('should remove from client subscriptions', async () => {
      const mockSession = createMockAgentSession();
      mockSession.abort = vi.fn();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.stopSession('/path/to/session.jsonl');
      
      expect(manager.getClientSubscriptions('client-1')).toEqual([]);
    });

    it('should abort ongoing operations before disposing', async () => {
      const mockSession = createMockAgentSession();
      mockSession.abort = vi.fn();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.updateSessionStatus('/path/to/session.jsonl', 'streaming');
      
      manager.stopSession('/path/to/session.jsonl');
      
      // Should have called abort before dispose
      expect(mockSession.abort).toHaveBeenCalled();
      expect(mockSession.dispose).toHaveBeenCalled();
    });
  });

  describe('event handling', () => {
    it('should update session status on agent_start', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Simulate agent_start event
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('streaming');
    });

    it('should update session status on agent_end', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // First set to streaming
      manager.updateSessionStatus('/path/to/session.jsonl', 'streaming');
      
      // Simulate agent_end event
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_end' });
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('idle');
    });

    it('should update message count on new messages', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Simulate message event
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'message_start',
        message: { id: 'msg-1', role: 'user' }
      });
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' }
      });
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.messageCount).toBe(2);
    });

    it('should track lastActivity timestamp', async () => {
      vi.useFakeTimers();
      
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      const initialStatus = manager.getSessionStatus('/path/to/session.jsonl');
      const initialActivity = initialStatus?.lastActivity;
      
      // Advance time and trigger an event
      vi.advanceTimersByTime(5000);
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
      
      const updatedStatus = manager.getSessionStatus('/path/to/session.jsonl');
      expect(updatedStatus?.lastActivity.getTime()).toBeGreaterThan(initialActivity!.getTime());
      
      vi.useRealTimers();
    });

    it('should update currentStep on step events', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Simulate step event
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'step',
        step: 3
      });
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.currentStep).toBe(3);
    });

    it('should set error status on error events', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Simulate error event
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'error',
        error: 'Something went wrong'
      });
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('error');
    });

    it('should emit api_error event when message has stopReason error (e.g. 429 rate limit)', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      mockBroadcast.mockClear();
      
      // Simulate a message_start with stopReason='error' (like a 429 from GitHub Copilot)
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'message_start',
        message: {
          id: 'msg-429',
          role: 'assistant',
          stopReason: 'error',
          errorMessage: "429 Sorry, you've exhausted this model's rate limit.",
          provider: 'github-copilot',
          model: 'claude-sonnet-4.6',
        }
      });
      
      // Should broadcast both the original message event and an api_error event
      const apiErrorCalls = mockBroadcast.mock.calls.filter(
        (call: any[]) => call[1]?.event?.type === 'api_error'
      );
      expect(apiErrorCalls.length).toBe(1);
      expect(apiErrorCalls[0][1]?.event?.message).toBe("429 Sorry, you've exhausted this model's rate limit.");
    });

    it('should NOT emit api_error for normal message_start without error', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      mockBroadcast.mockClear();
      
      // Normal message_start
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'message_start',
        message: {
          id: 'msg-normal',
          role: 'assistant',
          stopReason: 'endTurn',
        }
      });
      
      // Should only broadcast the original event, no api_error
      const apiErrorCalls = mockBroadcast.mock.calls.filter(
        (call: any[]) => call[1]?.event?.type === 'api_error'
      );
      expect(apiErrorCalls.length).toBe(0);
    });

    describe('API error grace period', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should emit synthetic agent_end after grace period if no further events arrive', async () => {
        const mockSession = createMockAgentSession();
        mockPiService.createSession.mockResolvedValueOnce(mockSession);

        const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
        await manager.subscribeClient('client-1', '/path/to/session.jsonl');

        // Start agent turn
        manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
        expect(manager.getSessionStatus('/path/to/session.jsonl')?.status).toBe('streaming');

        mockBroadcast.mockClear();

        // API error arrives (429)
        manager.handleAgentEvent('/path/to/session.jsonl', {
          type: 'message_start',
          message: {
            id: 'msg-429',
            role: 'assistant',
            stopReason: 'error',
            errorMessage: '429 rate limit exceeded',
            provider: 'github-copilot',
          },
        });

        // Status should still be streaming (grace period hasn't elapsed)
        expect(manager.getSessionStatus('/path/to/session.jsonl')?.status).toBe('streaming');

        // Advance past grace period (60 seconds)
        vi.advanceTimersByTime(61_000);

        // Now status should be idle
        expect(manager.getSessionStatus('/path/to/session.jsonl')?.status).toBe('idle');

        // Should have broadcast a synthetic agent_end
        const agentEndCalls = mockBroadcast.mock.calls.filter(
          (call: any[]) => call[1]?.event?.type === 'agent_end'
        );
        expect(agentEndCalls.length).toBe(1);
        expect(agentEndCalls[0][1]?.event?.result).toBeNull();
      });

      it('should cancel grace timer when a new event arrives (SDK retried)', async () => {
        const mockSession = createMockAgentSession();
        mockPiService.createSession.mockResolvedValueOnce(mockSession);

        const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
        await manager.subscribeClient('client-1', '/path/to/session.jsonl');

        manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
        mockBroadcast.mockClear();

        // API error
        manager.handleAgentEvent('/path/to/session.jsonl', {
          type: 'message_start',
          message: {
            id: 'msg-429',
            role: 'assistant',
            stopReason: 'error',
            errorMessage: '429 rate limit exceeded',
          },
        });

        // 30 seconds later, SDK retries successfully and sends a normal event
        vi.advanceTimersByTime(30_000);
        manager.handleAgentEvent('/path/to/session.jsonl', {
          type: 'message_update',
          message: { id: 'msg-retry', content: 'retrying...' },
          assistantMessageEvent: { type: 'content_part_delta', delta: 'retrying...' },
        });

        // Advance well past the original grace period
        vi.advanceTimersByTime(90_000);

        // Status should STILL be streaming — grace timer was cancelled
        expect(manager.getSessionStatus('/path/to/session.jsonl')?.status).toBe('streaming');

        // No synthetic agent_end should have been broadcast
        const agentEndCalls = mockBroadcast.mock.calls.filter(
          (call: any[]) => call[1]?.event?.type === 'agent_end'
        );
        expect(agentEndCalls.length).toBe(0);
      });

      it('should not schedule grace timer for non-streaming sessions', async () => {
        const mockSession = createMockAgentSession();
        mockPiService.createSession.mockResolvedValueOnce(mockSession);

        const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
        await manager.subscribeClient('client-1', '/path/to/session.jsonl');

        // Session is idle (no agent_start)
        expect(manager.getSessionStatus('/path/to/session.jsonl')?.status).toBe('idle');

        mockBroadcast.mockClear();

        // API error arrives on idle session
        manager.handleAgentEvent('/path/to/session.jsonl', {
          type: 'message_start',
          message: {
            id: 'msg-err',
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'some error',
          },
        });

        // Advance past grace period
        vi.advanceTimersByTime(90_000);

        // No synthetic agent_end should have been broadcast
        const agentEndCalls = mockBroadcast.mock.calls.filter(
          (call: any[]) => call[1]?.event?.type === 'agent_end'
        );
        expect(agentEndCalls.length).toBe(0);
      });

      it('should clean up grace timers when session is disposed', async () => {
        const mockSession = createMockAgentSession();
        mockPiService.createSession.mockResolvedValueOnce(mockSession);

        const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
        await manager.subscribeClient('client-1', '/path/to/session.jsonl');

        manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });

        // API error starts grace timer
        manager.handleAgentEvent('/path/to/session.jsonl', {
          type: 'message_start',
          message: {
            id: 'msg-429',
            role: 'assistant',
            stopReason: 'error',
            errorMessage: '429 rate limit exceeded',
          },
        });

        // Stop the manager (which clears all grace timers)
        manager.stopCleanupTimer();

        // Advance past grace period — timer should have been cancelled
        vi.advanceTimersByTime(90_000);

        // No synthetic agent_end broadcast because timer was cancelled
        const agentEndCalls = mockBroadcast.mock.calls.filter(
          (call: any[]) => call[1]?.event?.type === 'agent_end'
        );
        expect(agentEndCalls.length).toBe(0);
      });

      it('should not fire if real agent_end arrives before grace period', async () => {
        const mockSession = createMockAgentSession();
        mockPiService.createSession.mockResolvedValueOnce(mockSession);

        const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
        await manager.subscribeClient('client-1', '/path/to/session.jsonl');

        manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
        mockBroadcast.mockClear();

        // API error
        manager.handleAgentEvent('/path/to/session.jsonl', {
          type: 'message_start',
          message: {
            id: 'msg-429',
            role: 'assistant',
            stopReason: 'error',
            errorMessage: '429 rate limit exceeded',
          },
        });

        // Real agent_end arrives 10 seconds later
        vi.advanceTimersByTime(10_000);
        manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_end' });

        // Advance well past grace period
        vi.advanceTimersByTime(90_000);

        // Only one agent_end (the real one), no synthetic duplicate
        const agentEndCalls = mockBroadcast.mock.calls.filter(
          (call: any[]) => call[1]?.event?.type === 'agent_end'
        );
        expect(agentEndCalls.length).toBe(1);
      });
    });

    it('should broadcast events to all subscribers', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      await manager.subscribeClient('client-2', '/path/to/session.jsonl');
      
      mockBroadcast.mockClear();
      
      // Simulate event that should be broadcast
      manager.handleAgentEvent('/path/to/session.jsonl', { 
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Hello' }
      });
      
      // Should broadcast to both subscribers
      expect(mockBroadcast).toHaveBeenCalledTimes(2);
    });
  });

  describe('getClientSubscriptions', () => {
    it('should return empty array for client with no subscriptions', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      const subscriptions = manager.getClientSubscriptions('client-1');
      
      expect(subscriptions).toEqual([]);
    });

    it('should return all session paths client is subscribed to', async () => {
      const mockSession1 = createMockAgentSession({ sessionPath: '/path/1.jsonl' });
      const mockSession2 = createMockAgentSession({ sessionPath: '/path/2.jsonl' });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/1.jsonl');
      await manager.subscribeClient('client-1', '/path/2.jsonl');
      
      const subscriptions = manager.getClientSubscriptions('client-1');
      
      expect(subscriptions).toContain('/path/1.jsonl');
      expect(subscriptions).toContain('/path/2.jsonl');
      expect(subscriptions.length).toBe(2);
    });

    it('should update after unsubscribe', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      const subscriptions = manager.getClientSubscriptions('client-1');
      expect(subscriptions).toEqual([]);
    });
  });

  describe('updateSessionStatus', () => {
    it('should update status to streaming', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.updateSessionStatus('/path/to/session.jsonl', 'streaming');
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('streaming');
    });

    it('should update status to busy', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.updateSessionStatus('/path/to/session.jsonl', 'busy');
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('busy');
    });

    it('should update status to error', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.updateSessionStatus('/path/to/session.jsonl', 'error');
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('error');
    });

    it('should do nothing for non-existent session', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      expect(() => manager.updateSessionStatus('/non/existent.jsonl', 'streaming')).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should dispose all sessions', async () => {
      const mockSession1 = createMockAgentSession({ sessionPath: '/path/1.jsonl' });
      const mockSession2 = createMockAgentSession({ sessionPath: '/path/2.jsonl' });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/1.jsonl');
      await manager.subscribeClient('client-2', '/path/2.jsonl');
      
      manager.dispose();
      
      expect(mockSession1.dispose).toHaveBeenCalled();
      expect(mockSession2.dispose).toHaveBeenCalled();
    });

    it('should clear all internal maps', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.dispose();
      
      const status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status).toBeUndefined();
      
      const subscriptions = manager.getClientSubscriptions('client-1');
      expect(subscriptions).toEqual([]);
    });
  });

  describe('getAllSessionStatuses', () => {
    it('should return empty array when no sessions', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      const statuses = manager.getAllSessionStatuses();
      
      expect(statuses).toEqual([]);
    });

    it('should return all active session statuses', async () => {
      const mockSession1 = createMockAgentSession({ sessionPath: '/path/1.jsonl' });
      const mockSession2 = createMockAgentSession({ sessionPath: '/path/2.jsonl' });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/1.jsonl');
      await manager.subscribeClient('client-2', '/path/2.jsonl');
      
      const statuses = manager.getAllSessionStatuses();
      
      expect(statuses.length).toBe(2);
      expect(statuses.map(s => s.sessionPath)).toContain('/path/1.jsonl');
      expect(statuses.map(s => s.sessionPath)).toContain('/path/2.jsonl');
    });
  });

  describe('hasSession', () => {
    it('should return false for non-existent session', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      expect(manager.hasSession('/non/existent.jsonl')).toBe(false);
    });

    it('should return true for active session', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      expect(manager.hasSession('/path/to/session.jsonl')).toBe(true);
    });
  });

  describe('session pinning', () => {
    it('should pin a session', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      const result = manager.pinSession('/path/to/session.jsonl');
      
      expect(result).toBe(true);
      expect(manager.isSessionPinned('/path/to/session.jsonl')).toBe(true);
    });

    it('should unpin a session', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.pinSession('/path/to/session.jsonl');
      
      const result = manager.unpinSession('/path/to/session.jsonl');
      
      expect(result).toBe(true);
      expect(manager.isSessionPinned('/path/to/session.jsonl')).toBe(false);
    });

    it('should return false when pinning non-existent session', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      expect(manager.pinSession('/non/existent.jsonl')).toBe(false);
    });

    it('should return false when unpinning non-existent session', () => {
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      
      expect(manager.unpinSession('/non/existent.jsonl')).toBe(false);
    });

    it('should enforce max pinned sessions limit (default 2)', async () => {
      const mockSession1 = createMockAgentSession({ sessionPath: '/path/1.jsonl' });
      const mockSession2 = createMockAgentSession({ sessionPath: '/path/2.jsonl' });
      const mockSession3 = createMockAgentSession({ sessionPath: '/path/3.jsonl' });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2)
        .mockResolvedValueOnce(mockSession3);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/1.jsonl');
      await manager.subscribeClient('client-1', '/path/2.jsonl');
      await manager.subscribeClient('client-1', '/path/3.jsonl');
      
      expect(manager.pinSession('/path/1.jsonl')).toBe(true);
      expect(manager.pinSession('/path/2.jsonl')).toBe(true);
      expect(manager.pinSession('/path/3.jsonl')).toBe(false); // Exceeds limit
      expect(manager.getPinnedCount()).toBe(2);
    });

    it('should allow pinning same session twice without counting twice', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      manager.pinSession('/path/to/session.jsonl');
      manager.pinSession('/path/to/session.jsonl'); // Already pinned
      
      expect(manager.getPinnedCount()).toBe(1);
    });

    it('should NOT clean up pinned idle sessions after timeout', async () => {
      vi.useFakeTimers();
      
      const mockSession = createMockAgentSession({
        sessionId: 'pinned-idle-session',
        sessionPath: '/path/to/pinned-idle.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast, {
        cleanupIntervalMs: 24 * 60 * 60 * 1000, // disabled
        idleSessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
        enableMemoryMonitoring: false,
      });
      
      await manager.subscribeClient('client-1', '/path/to/pinned-idle.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/pinned-idle.jsonl');
      manager.pinSession('/path/to/pinned-idle.jsonl');
      
      // Advance past timeout
      vi.advanceTimersByTime(60 * 60 * 1000); // 60 minutes
      
      const cleanedCount = manager.cleanupInactiveSessions();
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/to/pinned-idle.jsonl')).toBe(true);
      expect(mockSession.dispose).not.toHaveBeenCalled();
      
      vi.useRealTimers();
    });

    it('should stale-detect pinned streaming sessions and reset to idle (but NOT unload them)', async () => {
      vi.useFakeTimers();
      
      const mockSession = createMockAgentSession({
        sessionId: 'pinned-streaming-session',
        sessionPath: '/path/to/pinned-streaming.jsonl',
      });
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast, {
        cleanupIntervalMs: 24 * 60 * 60 * 1000,
        enableMemoryMonitoring: false,
      });
      
      await manager.subscribeClient('client-1', '/path/to/pinned-streaming.jsonl');
      // Keep client-1 subscribed so it receives the stale_stream_reset broadcast
      manager.pinSession('/path/to/pinned-streaming.jsonl');
      
      // Set session to streaming
      manager.handleAgentEvent('/path/to/pinned-streaming.jsonl', { type: 'agent_start' });
      expect(manager.getSessionStatus('/path/to/pinned-streaming.jsonl')?.status).toBe('streaming');
      
      // Advance past stale threshold (15 minutes)
      vi.advanceTimersByTime(20 * 60 * 1000);
      
      mockBroadcast.mockClear();
      manager.cleanupInactiveSessions();
      
      // Should be reset to idle (dead worker detected) but NOT unloaded
      const status = manager.getSessionStatus('/path/to/pinned-streaming.jsonl');
      expect(status?.status).toBe('idle');
      expect(manager.hasSession('/path/to/pinned-streaming.jsonl')).toBe(true);
      // Session should NOT have been disposed (pinned protects from cleanup)
      expect(mockSession.dispose).not.toHaveBeenCalled();
      // A stale_stream_reset event should have been broadcast to subscribers
      const staleResetCalls = mockBroadcast.mock.calls.filter(
        (call: any[]) => call[1]?.event?.type === 'stale_stream_reset'
      );
      expect(staleResetCalls.length).toBe(1);
      
      vi.useRealTimers();
    });

    it('should NOT evict pinned sessions for LRU', async () => {
      const mockSession1 = createMockAgentSession({ sessionPath: '/path/1.jsonl' });
      const mockSession2 = createMockAgentSession({ sessionPath: '/path/2.jsonl' });
      mockPiService.createSession
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      // Max 1 session to force eviction
      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast, {
        maxSessions: 1,
        enableMemoryMonitoring: false,
      });
      
      await manager.subscribeClient('client-1', '/path/1.jsonl');
      manager.unsubscribeClient('client-1', '/path/1.jsonl');
      manager.pinSession('/path/1.jsonl');
      
      // Trigger cleanup that would evict idle sessions
      const cleanedCount = manager.cleanupInactiveSessions();
      
      // Pinned session should not be evicted
      expect(cleanedCount).toBe(0);
      expect(manager.hasSession('/path/1.jsonl')).toBe(true);
    });

    it('should NOT aggressive-clean pinned sessions', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      manager.pinSession('/path/to/session.jsonl');
      
      // Access private method via any for testing
      (manager as any).aggressiveCleanup();
      
      expect(manager.hasSession('/path/to/session.jsonl')).toBe(true);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it('should still allow stopSession to remove pinned sessions', async () => {
      const mockSession = createMockAgentSession();
      mockSession.abort = vi.fn();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.pinSession('/path/to/session.jsonl');
      
      const result = manager.stopSession('/path/to/session.jsonl');
      
      expect(result).toBe(true);
      expect(manager.hasSession('/path/to/session.jsonl')).toBe(false);
      expect(mockSession.dispose).toHaveBeenCalled();
    });

    it('should include pinned in session status', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      
      // Initially not pinned
      expect(manager.getSessionStatus('/path/to/session.jsonl')?.pinned).toBe(false);
      
      // After pinning
      manager.pinSession('/path/to/session.jsonl');
      expect(manager.getSessionStatus('/path/to/session.jsonl')?.pinned).toBe(true);
    });

    it('should reset idle clock on unpin', async () => {
      vi.useFakeTimers();
      
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast, {
        cleanupIntervalMs: 24 * 60 * 60 * 1000,
        idleSessionTimeoutMs: 30 * 60 * 1000,
        enableMemoryMonitoring: false,
      });
      
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      manager.pinSession('/path/to/session.jsonl');
      
      // Advance 40 minutes while pinned (no cleanup)
      vi.advanceTimersByTime(40 * 60 * 1000);
      manager.cleanupInactiveSessions();
      expect(manager.hasSession('/path/to/session.jsonl')).toBe(true);
      
      // Unpin - should reset idle clock
      manager.unpinSession('/path/to/session.jsonl');
      
      // Advance only 15 minutes (not enough to trigger 30 min timeout)
      vi.advanceTimersByTime(15 * 60 * 1000);
      manager.cleanupInactiveSessions();
      expect(manager.hasSession('/path/to/session.jsonl')).toBe(true);
      
      // Advance another 20 minutes (total 35 min since unpin, exceeds 30 min)
      vi.advanceTimersByTime(20 * 60 * 1000);
      manager.cleanupInactiveSessions();
      expect(manager.hasSession('/path/to/session.jsonl')).toBe(false);
      
      vi.useRealTimers();
    });
  });
});
