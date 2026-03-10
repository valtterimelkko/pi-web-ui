import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PiService, getPiService, initializePiService } from '../../src/pi/pi-service.js';

// Mock the pi-coding-agent module
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn().mockResolvedValue({
    session: {
      sessionId: 'test-session-id',
      subscribe: vi.fn(),
      setModel: vi.fn(),
      dispose: vi.fn(),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      sessionManager: {},
    },
  }),
  SessionManager: {
    create: vi.fn().mockReturnValue({}),
    open: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
    continueRecent: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue([
      {
        id: 'session-1',
        path: '/path/to/session-1',
        firstMessage: 'Hello',
        messageCount: 5,
        cwd: '/home/user',
        name: 'Test Session',
        parentSessionPath: undefined,
        created: new Date(),
        modified: new Date(),
      },
    ]),
    listAll: vi.fn().mockResolvedValue([
      {
        id: 'session-1',
        path: '/path/to/session-1',
        firstMessage: 'Hello',
        messageCount: 5,
        cwd: '/home/user',
        name: 'Test Session',
        parentSessionPath: undefined,
        created: new Date(),
        modified: new Date(),
      },
    ]),
  },
  AuthStorage: {
    create: vi.fn().mockReturnValue({
      getAll: vi.fn().mockReturnValue([]),
    }),
  },
  ModelRegistry: vi.fn().mockImplementation(() => ({
    getAvailable: vi.fn().mockResolvedValue([
      { id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai' },
    ]),
    find: vi.fn().mockReturnValue({ id: 'openai/gpt-4', name: 'GPT-4' }),
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

describe('PiService', () => {
  let service: PiService;

  beforeEach(() => {
    service = new PiService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a service instance', () => {
      expect(service).toBeDefined();
    });

    it('should initialize with empty session maps', () => {
      expect(service).toBeDefined();
      // Internal maps are private, but we can test behavior through methods
    });
  });

  describe('initialize', () => {
    it('should initialize the service', async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });

  describe('createSession', () => {
    it('should create a session with default options', async () => {
      const session = await service.createSession({ clientId: 'client-1' });
      expect(session).toBeDefined();
      expect(session.sessionId).toBe('test-session-id');
    });

    it('should create an in-memory session', async () => {
      const session = await service.createSession({
        clientId: 'client-1',
        inMemory: true,
      });
      expect(session).toBeDefined();
    });

    it('should create a session with specific path', async () => {
      const session = await service.createSession({
        clientId: 'client-1',
        sessionPath: '/path/to/session',
      });
      expect(session).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('should return undefined for non-existent session', () => {
      const session = service.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('getSessionByClientId', () => {
    it('should return undefined for non-existent client', () => {
      const session = service.getSessionByClientId('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('getSessionIdByClientId', () => {
    it('should return undefined for non-existent client', () => {
      const sessionId = service.getSessionIdByClientId('non-existent');
      expect(sessionId).toBeUndefined();
    });
  });

  describe('setEventHandler', () => {
    it('should set an event handler for a client', () => {
      const handler = vi.fn();
      service.setEventHandler('client-1', handler);
      // Handler is stored internally, no direct way to verify except through behavior
      expect(service).toBeDefined();
    });
  });

  describe('removeEventHandler', () => {
    it('should remove an event handler', () => {
      service.removeEventHandler('client-1');
      expect(service).toBeDefined();
    });
  });

  describe('listSessions', () => {
    it('should return a list of sessions', async () => {
      const sessions = await service.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]).toHaveProperty('id');
      expect(sessions[0]).toHaveProperty('path');
    });

    it('should return sessions for a specific cwd', async () => {
      const sessions = await service.listSessions('/home/user');
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe('listAllSessions', () => {
    it('should return all sessions', async () => {
      const sessions = await service.listAllSessions();
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', async () => {
      const fs = await import('fs/promises');
      vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);

      await expect(service.deleteSession('/path/to/session')).resolves.not.toThrow();
    });
  });

  describe('getAvailableModels', () => {
    it('should return available models', async () => {
      const models = await service.getAvailableModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('setModel', () => {
    it('should throw for non-existent session', async () => {
      await expect(service.setModel('non-existent', 'openai/gpt-4')).rejects.toThrow(
        'Session not found'
      );
    });

    it('should throw for invalid model ID format', async () => {
      // First create a session to have it in the map
      const session = await service.createSession({ clientId: 'client-1' });

      await expect(service.setModel(session.sessionId, 'invalid-model-id')).rejects.toThrow(
        'Invalid model ID format'
      );
    });
  });

  describe('removeClient', () => {
    it('should remove a client cleanly', async () => {
      // Create a session first
      await service.createSession({ clientId: 'client-1' });

      // Now remove it
      service.removeClient('client-1');
      expect(service.getSessionByClientId('client-1')).toBeUndefined();
    });

    it('should handle removing non-existent client', () => {
      expect(() => service.removeClient('non-existent')).not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should clean up all sessions', async () => {
      await service.createSession({ clientId: 'client-1' });
      await service.cleanup();
      expect(service).toBeDefined();
    });
  });
});

describe('getPiService', () => {
  it('should return a singleton instance', () => {
    const instance1 = getPiService();
    const instance2 = getPiService();
    expect(instance1).toBe(instance2);
  });
});

describe('initializePiService', () => {
  it('should initialize and return the service', async () => {
    const service = await initializePiService();
    expect(service).toBeDefined();
  });
});
