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
  return {
    sessionId: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    sessionPath: '/default/session/path.jsonl',
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

    it('should reset stale streaming sessions to idle after 5 minutes without events', async () => {
      const mockSession = createMockAgentSession();
      mockPiService.createSession.mockResolvedValueOnce(mockSession);

      const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
      await manager.subscribeClient('client-1', '/path/to/session.jsonl');
      manager.unsubscribeClient('client-1', '/path/to/session.jsonl');
      
      // Set session to streaming via agent_start event
      manager.handleAgentEvent('/path/to/session.jsonl', { type: 'agent_start' });
      
      let status = manager.getSessionStatus('/path/to/session.jsonl');
      expect(status?.status).toBe('streaming');
      
      // Simulate time passing (6 minutes = 360 seconds = 360000ms)
      const originalDateNow = Date.now;
      const sixMinutesLater = Date.now() + 6 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(sixMinutesLater);
      
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
});
