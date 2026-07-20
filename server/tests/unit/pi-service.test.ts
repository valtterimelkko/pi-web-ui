import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PiService, getPiService, initializePiService } from '../../src/pi/pi-service.js';

// Mock the pi-coding-agent module
// Top-level mocks referenced inside vi.mock() factories must be created with
// vi.hoisted() so they exist when the (hoisted) factories run during module
// load — pi-service now imports fs/promises eagerly via its refresh module.
const { resourceLoaderInstances, accessMock, modelRuntime } = vi.hoisted(() => ({
  // Track DefaultResourceLoader constructor calls
  resourceLoaderInstances: [] as Array<{ cwd: string; agentDir: string }>,
  // fs.access is non-configurable on Node's fs/promises module, so we mock the
  // whole module. `accessMock` lets individual tests simulate existing vs new files.
  accessMock: vi.fn().mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  ),
  // The Pi SDK 0.80.8+ integration boundary: one shared asynchronous runtime
  // owns model discovery and credential resolution for every AgentSession.
  modelRuntime: {
    setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    getError: vi.fn().mockReturnValue(undefined),
    getModels: vi.fn().mockReturnValue([
      { id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai' },
    ]),
    getAvailable: vi.fn().mockResolvedValue([
      { id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai' },
    ]),
    getModel: vi.fn().mockReturnValue({ id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai' }),
    hasConfiguredAuth: vi.fn().mockReturnValue(false),
    registerProvider: vi.fn(),
  },
}));

// Factory that builds a mock SessionManager whose `flushed` flag and
// `_rewriteFile`/`setSessionFile` calls are observable. This mirrors the
// real SDK field that Pi Web UI must keep in sync when force-writing the
// session file at creation time (see forceFlushSessionManager in pi-service.ts).
function createMockSessionManager() {
  return {
    flushed: false,
    setSessionFile: vi.fn(function (this: { flushed: boolean }) {
      // Real SDK resets flushed=false when switching to a non-existent file
      this.flushed = false;
    }),
    _rewriteFile: vi.fn(),
  };
}

vi.mock('fs/promises', () => ({
  access: accessMock,
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
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
    create: vi.fn().mockReturnValue(createMockSessionManager()),
    open: vi.fn().mockReturnValue(createMockSessionManager()),
    inMemory: vi.fn().mockReturnValue(createMockSessionManager()),
    continueRecent: vi.fn().mockResolvedValue(createMockSessionManager()),
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
  ModelRuntime: {
    create: vi.fn().mockResolvedValue(modelRuntime),
  },
  DefaultResourceLoader: vi.fn().mockImplementation((opts: { cwd: string; agentDir: string }) => {
    resourceLoaderInstances.push({ cwd: opts.cwd, agentDir: opts.agentDir });
    return {
      reload: vi.fn().mockResolvedValue(undefined),
      getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
      getSkills: vi.fn().mockReturnValue({ skills: [], diagnostics: [] }),
      getAgentsFiles: vi.fn().mockReturnValue({ agentsFiles: [] }),
    };
  }),
}));

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
    // Keep the OpenRouter refresh path out of these unit tests.
    piOpenrouterModelsEnabled: false,
  },
}));

describe('PiService', () => {
  let service: PiService;

  beforeEach(() => {
    service = new PiService();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resourceLoaderInstances.length = 0;
    // Restore accessMock's default (ENOENT) after per-test overrides
    accessMock.mockClear();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
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
    it('creates one configured ModelRuntime and passes it to AgentSession creation', async () => {
      const { createAgentSession, ModelRuntime } = await import('@earendil-works/pi-coding-agent');

      await service.createSession({ clientId: 'model-runtime-client' });

      expect(ModelRuntime.create).toHaveBeenCalledWith({
        authPath: '/tmp/pi-agent/auth.json',
        modelsPath: '/tmp/pi-agent/models.json',
      });
      expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
        modelRuntime,
      }));
    });

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

    it('binds extensions even when the caller has no Web UI context', async () => {
      const session = await service.createSession({ clientId: 'internal-api-client' });

      expect(session.bindExtensions).toHaveBeenCalledOnce();
      expect(session.bindExtensions).toHaveBeenCalledWith({});
    });

    it('binds Web UI reload to the same active AgentSession', async () => {
      const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
      const mockSession = {
        sessionId: 'web-ui-reload-session',
        subscribe: vi.fn(),
        setModel: vi.fn(),
        dispose: vi.fn(),
        reload: vi.fn().mockResolvedValue(undefined),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        sessionManager: {},
      };
      (createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ session: mockSession });

      await service.createSession({
        clientId: 'web-ui-reload-client',
        webUIContext: {
          clientId: 'web-ui-reload-client',
          sendToClient: vi.fn(),
        },
      });
      const bindings = mockSession.bindExtensions.mock.calls[0]?.[0];

      await bindings.commandContextActions.reload();

      expect(mockSession.reload).toHaveBeenCalledOnce();
      expect(service.getSessionByClientId('web-ui-reload-client')).toBe(mockSession);
    });

    it('forwards extension command failures to the Web UI context', async () => {
      const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
      const sendToClient = vi.fn();
      const mockSession = {
        sessionId: 'extension-error-session',
        subscribe: vi.fn(),
        setModel: vi.fn(),
        dispose: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        sessionManager: {},
      };
      (createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ session: mockSession });

      await service.createSession({
        clientId: 'extension-error-client',
        webUIContext: { clientId: 'extension-error-client', sendToClient },
      });
      const bindings = mockSession.bindExtensions.mock.calls[0]?.[0];

      bindings.onError({
        extensionPath: 'command:goal',
        event: 'command',
        error: 'hideGoalStatusWidget is not defined',
      });

      expect(sendToClient).toHaveBeenCalledWith({
        type: 'extension_error',
        extensionPath: 'command:goal',
        event: 'command',
        error: 'hideGoalStatusWidget is not defined',
      });
    });

    it('waits for extension session_start handlers before returning the session', async () => {
      const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
      let releaseBind!: () => void;
      const bindPending = new Promise<void>((resolve) => { releaseBind = resolve; });
      const mockSession = {
        sessionId: 'bind-wait-session',
        subscribe: vi.fn(),
        setModel: vi.fn(),
        dispose: vi.fn(),
        bindExtensions: vi.fn().mockReturnValue(bindPending),
        sessionManager: {},
      };
      (createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ session: mockSession });

      let settled = false;
      const creation = service.createSession({ clientId: 'bind-wait-client' }).then((session) => {
        settled = true;
        return session;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockSession.bindExtensions).toHaveBeenCalledWith({});
      expect(settled).toBe(false);

      releaseBind();
      await expect(creation).resolves.toBe(mockSession);
    });

    it('cleans up the partially created session when extension binding fails', async () => {
      const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
      const mockSession = {
        sessionId: 'bind-failure-session',
        subscribe: vi.fn(),
        setModel: vi.fn(),
        dispose: vi.fn(),
        bindExtensions: vi.fn().mockRejectedValue(new Error('session_start failed')),
        sessionManager: {},
      };
      (createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ session: mockSession });
      const removeEventHandler = vi.spyOn(service, 'removeEventHandler');
      service.setEventHandler('bind-failure-client', vi.fn());

      await expect(service.createSession({ clientId: 'bind-failure-client' }))
        .rejects.toThrow('session_start failed');

      expect(mockSession.dispose).toHaveBeenCalledOnce();
      expect(removeEventHandler).toHaveBeenCalledWith('bind-failure-client');
      expect(service.getSessionByClientId('bind-failure-client')).toBeUndefined();
      expect(service.getSession('bind-failure-session')).toBeUndefined();
    });
  });

  describe('createSession — force-flush (EEXIST defence)', () => {
    /**
     * Regression coverage for the EEXIST bug where the SDK's `_persist()`
     * would throw `EEXIST: file already exists, open '<path>.jsonl'` on the
     * first assistant-message write, because Pi Web UI pre-wrote the file via
     * `_rewriteFile()` without also setting the SDK's internal `flushed` flag
     * to true. The EEXIST was thrown from inside `handleRunFailure` and masked
     * any real upstream error from the agent run.
     */
    it('sets the SDK flushed flag to true after force-writing a new session file', async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const mockSm = createMockSessionManager();
      (SessionManager.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSm);

      await service.createSession({ clientId: 'client-flush-1' });

      // _rewriteFile must have been called to force the file onto disk
      expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);
      // The critical fix: the SDK's flushed flag must be true so its own
      // _persist() does not later attempt an exclusive openSync(path, 'wx')
      // against the file we just wrote.
      expect(mockSm.flushed).toBe(true);
    });

    it('sets flushed=true after force-writing when an explicit sessionPath is given for a new file', async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const mockSm = createMockSessionManager();
      (SessionManager.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSm);

      // accessMock defaults to ENOENT (file does not exist) -> createSession
      // takes the create + setSessionFile + forceFlush path.
      await service.createSession({
        clientId: 'client-flush-2',
        sessionPath: '/tmp/does-not-exist-yet.jsonl',
      });

      expect(accessMock).toHaveBeenCalledWith('/tmp/does-not-exist-yet.jsonl');
      expect(mockSm.setSessionFile).toHaveBeenCalledWith('/tmp/does-not-exist-yet.jsonl');
      expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);
      expect(mockSm.flushed).toBe(true);
    });

    it('does NOT touch flushed/_rewriteFile when opening an existing session file', async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const mockSm = createMockSessionManager();
      (SessionManager.open as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSm);

      // Simulate an existing file: fs.access resolves successfully.
      accessMock.mockResolvedValueOnce(undefined);

      await service.createSession({
        clientId: 'client-flush-3',
        sessionPath: '/tmp/already-exists.jsonl',
      });

      // SessionManager.open is used for existing files; the force-flush path
      // is not taken, so _rewriteFile should not be invoked by pi-service.
      expect(mockSm._rewriteFile).not.toHaveBeenCalled();
      // flushed stays at its initial false value (open() owns its own load logic)
      expect(mockSm.flushed).toBe(false);
    });

    it('forceFlushSessionManager tolerates a SessionManager that lacks _rewriteFile (future SDK)', async () => {
      // If the SDK ever removes the internal _rewriteFile method (e.g. by
      // adding a public flush()), forceFlushSessionManager must not throw.
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const minimalSm: { flushed: boolean; _rewriteFile?: () => void } = { flushed: false };
      (SessionManager.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(minimalSm);

      await expect(
        service.createSession({ clientId: 'client-flush-4' })
      ).resolves.toBeDefined();

      // flushed is still flipped so the SDK's _persist() won't try exclusive create
      expect(minimalSm.flushed).toBe(true);
    });
  });

  describe('getSession', () => {
    it('should return undefined for non-existent session', () => {
      const session = service.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('reloadSession', () => {
    it('reloads the active AgentSession in place', async () => {
      const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
      const mockSession = {
        sessionId: 'reload-session',
        subscribe: vi.fn(),
        setModel: vi.fn(),
        dispose: vi.fn(),
        reload: vi.fn().mockResolvedValue(undefined),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        sessionManager: {},
      };
      (createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ session: mockSession });
      await service.createSession({ clientId: 'reload-client' });

      await service.reloadSession('reload-session');

      expect(mockSession.reload).toHaveBeenCalledOnce();
      expect(service.getSession('reload-session')).toBe(mockSession);
      expect(service.getSessionByClientId('reload-client')).toBe(mockSession);
    });

    it('fails explicitly for an unknown session', async () => {
      await expect(service.reloadSession('missing-session')).rejects.toThrow('Session not found');
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
    it('should have a deleteSession method', () => {
      expect(service.deleteSession).toBeDefined();
      expect(typeof service.deleteSession).toBe('function');
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

  describe('per-session resourceLoader', () => {
    it('should create a per-session resourceLoader with the session cwd', async () => {
      await service.createSession({ clientId: 'client-1', cwd: '/root/tasks' });

      const sessionInstances = resourceLoaderInstances.filter(
        i => i.cwd === '/root/tasks'
      );
      expect(sessionInstances.length).toBeGreaterThanOrEqual(1);
    });

    it('should NOT pass process.cwd() to the per-session resourceLoader when cwd is specified', async () => {
      await service.createSession({ clientId: 'client-2', cwd: '/root/tasks' });

      const sessionInstances = resourceLoaderInstances.filter(
        i => i.cwd === '/root/tasks'
      );
      const wrongInstances = resourceLoaderInstances.filter(
        i => i.cwd === process.cwd() && i !== resourceLoaderInstances[0]
      );

      expect(sessionInstances.length).toBeGreaterThanOrEqual(1);
      expect(wrongInstances.length).toBe(0);
    });

    it('should create separate resourceLoaders for sessions with different cwds', async () => {
      await service.createSession({ clientId: 'client-a', cwd: '/root/project-a' });
      await service.createSession({ clientId: 'client-b', cwd: '/root/project-b' });

      const aInstances = resourceLoaderInstances.filter(i => i.cwd === '/root/project-a');
      const bInstances = resourceLoaderInstances.filter(i => i.cwd === '/root/project-b');

      expect(aInstances.length).toBe(1);
      expect(bInstances.length).toBe(1);
    });

    it('should create a constructor-time resourceLoader with process.cwd() for shared use', () => {
      expect(resourceLoaderInstances.length).toBeGreaterThanOrEqual(1);
      expect(resourceLoaderInstances[0].cwd).toBe(process.cwd());
    });

    it('should pass the configured agentDir to the per-session resourceLoader', async () => {
      await service.createSession({ clientId: 'client-1', cwd: '/root/tasks' });

      const sessionInstances = resourceLoaderInstances.filter(
        i => i.cwd === '/root/tasks'
      );
      expect(sessionInstances[0].agentDir).toBe('/tmp/pi-agent');
    });

    it('should create a per-session resourceLoader even when cwd is not provided (falls back to process.cwd)', async () => {
      await service.createSession({ clientId: 'client-1' });

      const fallbackInstances = resourceLoaderInstances.filter(
        i => i.cwd === process.cwd()
      );
      expect(fallbackInstances.length).toBeGreaterThanOrEqual(2);
    });

    it('should pass per-session resourceLoader to createAgentSession', async () => {
      const { createAgentSession } = await import('@earendil-works/pi-coding-agent');

      await service.createSession({ clientId: 'client-rl', cwd: '/root/my-project' });

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/root/my-project',
        })
      );

      const lastCall = (createAgentSession as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      const passedLoader = lastCall?.[0]?.resourceLoader;
      expect(passedLoader).toBeDefined();
      expect(passedLoader.reload).toHaveBeenCalled();
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
