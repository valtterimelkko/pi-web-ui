import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';

/** Capture structured log records via the central logger tap (restores on return). */
function captureLogRecords(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  setLogTap((r) => records.push(r));
  return { records, restore: () => setLogTap(null) };
}

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
