import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../src/claude/claude-channel-process-manager.js', () => {
  const ClaudeChannelProcessManager = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    healthCheck: vi.fn().mockResolvedValue(true),
    getState: vi.fn().mockReturnValue({ process: null, status: 'running', startedAt: Date.now() }),
    switchModel: vi.fn(),
    setThinkingLevel: vi.fn(),
  }));
  return { ClaudeChannelProcessManager };
});

vi.mock('../../../src/claude/claude-channel-ws-client.js', () => {
  const ClaudeChannelWsClient = vi.fn().mockImplementation(() => {
    const emitter = new (EventEmitter as unknown as new () => EventEmitter)();
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      onEvent: vi.fn((handler: (e: unknown) => void) => emitter.on('event', handler)),
      onConnected: vi.fn((handler: () => void) => emitter.on('connected', handler)),
      onDisconnected: vi.fn((handler: () => void) => emitter.on('disconnected', handler)),
      onError: vi.fn((handler: (e: Error) => void) => emitter.on('error', handler)),
      __emitter: emitter,
    };
  });
  return { ClaudeChannelWsClient };
});

vi.mock('../../../src/claude/claude-channel-hooks-config.js', () => ({
  ClaudeChannelHooksConfig: vi.fn().mockImplementation(() => ({
    writeHooksConfig: vi.fn().mockResolvedValue(undefined),
    removeHooksConfig: vi.fn().mockResolvedValue(undefined),
    buildHooksConfig: vi.fn().mockReturnValue({ hooks: {} }),
  })),
}));

vi.mock('../../../src/claude/claude-session-store.js', () => ({
  ClaudeSessionStore: vi.fn().mockImplementation(() => ({
    initSession: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi.fn().mockResolvedValue([]),
    getFilePath: vi.fn((id: string) => `/tmp/sessions/${id}.jsonl`),
    sessionExists: vi.fn().mockResolvedValue(false),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/session-registry.js', () => ({
  SessionRegistryManager: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    listBySdkType: vi.fn().mockResolvedValue([]),
  })),
  getSessionRegistry: vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    listBySdkType: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { ClaudeChannelService } from '../../../src/claude/claude-channel-service.js';
import { ClaudeChannelProcessManager } from '../../../src/claude/claude-channel-process-manager.js';
import { ClaudeChannelWsClient } from '../../../src/claude/claude-channel-ws-client.js';
import { ClaudeChannelHooksConfig } from '../../../src/claude/claude-channel-hooks-config.js';
import { ClaudeSessionStore } from '../../../src/claude/claude-session-store.js';
import { getSessionRegistry } from '../../../src/session-registry.js';
import { execSync } from 'node:child_process';

function createService() {
  return new ClaudeChannelService({
    claudeSessionDir: '/tmp/sessions',
    registryPath: '/tmp/registry.json',
    pluginDir: '/tmp/plugin',
    wsPort: 9999,
    hookPort: 8888,
    cwd: '/tmp/workspace',
  });
}

type WsMock = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onConnected: ReturnType<typeof vi.fn>;
  onDisconnected: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  __emitter: EventEmitter;
};

function findWsMock(): WsMock | undefined {
  const results = (ClaudeChannelWsClient as unknown as ReturnType<typeof vi.fn>).mock.results as Array<{ value: unknown }>;
  for (const r of results) {
    const v = r.value as Record<string, unknown> | null;
    if (v && typeof v === 'object' && '__emitter' in v) {
      return v as WsMock;
    }
  }
  return undefined;
}

function getMocks() {
  const pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
  const wsInstance = findWsMock();
  const hooksInstance = (ClaudeChannelHooksConfig as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
  const storeInstance = (ClaudeSessionStore as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

  return { pmInstance, wsInstance, hooksInstance, storeInstance };
}

describe('ClaudeChannelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    it('should write hooks config before starting Claude', async () => {
      const service = createService();
      const { pmInstance, hooksInstance } = getMocks();
      await service.start();

      const hooksOrder = (hooksInstance.writeHooksConfig as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const startOrder = (pmInstance.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(hooksOrder).toBeLessThan(startOrder);
    });

    it('should start process manager', async () => {
      const service = createService();
      const { pmInstance } = getMocks();
      await service.start();
      expect(pmInstance.start).toHaveBeenCalled();
    });

    it('should connect WS client', async () => {
      const service = createService();
      await service.start();
      const wsInstance = findWsMock();
      expect(wsInstance?.connect).toHaveBeenCalled();
    });

    it('should wire up event handler', async () => {
      const service = createService();
      await service.start();
      const wsInstance = findWsMock();
      expect(wsInstance?.onEvent).toHaveBeenCalled();
    });

    it('should throw if Claude fails to start', async () => {
      const service = createService();
      const { pmInstance } = getMocks();
      (pmInstance.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Claude failed'));
      await expect(service.start()).rejects.toThrow('Claude failed');
    });
  });

  describe('sendPrompt', () => {
    let service: ClaudeChannelService;
    let wsInstance: WsMock;
    let storeInstance: { appendEntry: ReturnType<typeof vi.fn>; getFilePath: ReturnType<typeof vi.fn>; initSession: ReturnType<typeof vi.fn> };
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();

      wsInstance = findWsMock() as WsMock;

      storeInstance = (ClaudeSessionStore as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof storeInstance;
      registry = (getSessionRegistry as ReturnType<typeof vi.fn>).mock.results[0]?.value as typeof registry;

      if (!registry) {
        const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
        registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
      }
    });

    it('should persist user message to JSONL', async () => {
      const sessionId = 'test-sid-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-1', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      expect(storeInstance.appendEntry).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        type: 'user',
        content: 'Hello',
      }));
    });

    it('should send prompt via WS client', async () => {
      const sessionId = 'test-sid-2';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-2', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(wsInstance.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'prompt',
        sessionId: 'cs-2',
        content: 'Hello',
        cwd: '/tmp',
      }));
    });

    it('should emit agent_start before sending', async () => {
      const sessionId = 'test-sid-3';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-3', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, vi.fn());

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent_start',
        sessionId,
      }));
    });

    it('should route events to correct session callback', async () => {
      const sessionId = 'test-sid-4';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-4', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, vi.fn());

      const channelEvent = {
        type: 'message_update',
        sessionId: 'cs-4',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hi there' },
        delta: 'Hi there',
        timestamp: Date.now(),
      };
      wsInstance.__emitter.emit('event', channelEvent);

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message_update',
      }));
    });

    it('should persist tool events to JSONL', async () => {
      const sessionId = 'test-sid-5';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-5', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      const toolEvent = {
        type: 'tool_execution_start',
        sessionId: 'cs-5',
        toolName: 'Read',
        toolCallId: 'tc-1',
        args: { path: '/tmp/file.txt' },
        timestamp: Date.now(),
      };
      wsInstance.__emitter.emit('event', toolEvent);

      await vi.waitFor(() => {
        expect(storeInstance.appendEntry).toHaveBeenCalledWith(sessionId, expect.objectContaining({
          type: 'tool',
          toolName: 'Read',
          toolCallId: 'tc-1',
        }));
      });
    });

    it('should emit agent_end and call onComplete', async () => {
      const sessionId = 'test-sid-6';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-6', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      const agentEndEvent = {
        type: 'agent_end',
        sessionId: 'cs-6',
        result: 'success',
        usage: { input_tokens: 10, output_tokens: 20 },
        timestamp: Date.now(),
      };
      wsInstance.__emitter.emit('event', agentEndEvent);

      await vi.waitFor(() => {
        expect(onComplete).toHaveBeenCalledWith();
      });
    });

    it('should handle errors and call onComplete with error', async () => {
      const sessionId = 'test-sid-7';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-7', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      const errorEvent = {
        type: 'error',
        sessionId: 'cs-7',
        message: 'Something went wrong',
        code: 'ERR_INTERNAL',
        timestamp: Date.now(),
      };
      wsInstance.__emitter.emit('event', errorEvent);

      await vi.waitFor(() => {
        expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
          message: 'Something went wrong',
        }));
      });
    });

    it('should update registry status', async () => {
      const sessionId = 'test-sid-8';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-8', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(registry.updateStatus).toHaveBeenCalledWith(sessionId, 'running');
    });

    it('should throw if session not found', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.sendPrompt('missing', 'Hi', vi.fn(), vi.fn())).rejects.toThrow('not found');
    });

    it('should throw if claudeSessionId missing', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'x', sdkType: 'claude', cwd: '/tmp', status: 'idle',
      });
      await expect(service.sendPrompt('x', 'Hi', vi.fn(), vi.fn())).rejects.toThrow('missing claudeSessionId');
    });
  });

  describe('abort', () => {
    let service: ClaudeChannelService;
    let wsInstance: WsMock;
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      wsInstance = findWsMock() as WsMock;

      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should send abort via WS client', async () => {
      const sessionId = 'abort-sid-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-abort-1', cwd: '/tmp', status: 'running',
      });

      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), onComplete);

      service.abort(sessionId);

      expect(wsInstance.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'abort',
        sessionId: 'cs-abort-1',
      }));
    });

    it('should resolve pending prompt with abort error', async () => {
      const sessionId = 'abort-sid-2';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-abort-2', cwd: '/tmp', status: 'running',
      });

      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), onComplete);

      service.abort(sessionId);

      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Aborted',
      }));
      expect(service.isRunning(sessionId)).toBe(false);
    });
  });

  describe('session lifecycle', () => {
    let service: ClaudeChannelService;
    let storeInstance: { initSession: ReturnType<typeof vi.fn>; getFilePath: ReturnType<typeof vi.fn> };
    let registry: { upsert: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      storeInstance = (ClaudeSessionStore as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof storeInstance;
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should create sessions with unique IDs', async () => {
      const s1 = await service.createSession('/tmp/a');
      const s2 = await service.createSession('/tmp/b');
      expect(s1.sessionId).not.toBe(s2.sessionId);
      expect(s1.claudeSessionId).not.toBe(s2.claudeSessionId);
    });

    it('should register sessions in registry', async () => {
      const { sessionId } = await service.createSession('/tmp/project');
      expect(registry.upsert).toHaveBeenCalledWith(expect.objectContaining({
        id: sessionId,
        sdkType: 'claude',
        cwd: '/tmp/project',
        status: 'idle',
      }));
    });

    it('should initialize JSONL file', async () => {
      const { sessionId, claudeSessionId } = await service.createSession('/tmp/project', 'sonnet');
      expect(storeInstance.initSession).toHaveBeenCalledWith(sessionId, claudeSessionId, '/tmp/project', 'sonnet');
    });
  });

  describe('pinning', () => {
    let service: ClaudeChannelService;

    beforeEach(async () => {
      service = createService();
      await service.start();
    });

    it('should pin sessions', () => {
      const sid = 'pin-1';
      service['sessionsWithHistory'].add(sid);
      expect(service.pinSession(sid)).toBe(true);
      expect(service.isSessionPinned(sid)).toBe(true);
    });

    it('should unpin sessions', () => {
      const sid = 'pin-2';
      service['sessionsWithHistory'].add(sid);
      service.pinSession(sid);
      expect(service.unpinSession(sid)).toBe(true);
      expect(service.isSessionPinned(sid)).toBe(false);
    });

    it('should enforce max pinned limit', () => {
      for (let i = 0; i < 3; i++) {
        service['sessionsWithHistory'].add(`pin-${i}`);
        service.pinSession(`pin-${i}`);
      }
      expect(service.isSessionPinned('pin-0')).toBe(true);
      expect(service.isSessionPinned('pin-1')).toBe(true);
      expect(service.isSessionPinned('pin-2')).toBe(false);
    });

    it('should not pin unknown sessions', () => {
      expect(service.pinSession('unknown')).toBe(false);
    });
  });

  describe('stop', () => {
    it('should disconnect WS client and stop process manager', async () => {
      const service = createService();
      await service.start();

      const pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const wsInstance = findWsMock();

      await service.stop();

      expect(wsInstance?.disconnect).toHaveBeenCalled();
      expect(pmInstance.stop).toHaveBeenCalled();
    });

    it('should resolve pending prompts with shutdown error', async () => {
      const service = createService();
      await service.start();

      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      const registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sid', sdkType: 'claude', claudeSessionId: 'cs-1', cwd: '/tmp', status: 'idle',
      });

      const onComplete = vi.fn();
      await service.sendPrompt('sid', 'Hello', vi.fn(), onComplete);
      await service.stop();

      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Service shutting down',
      }));
    });
  });

  describe('health', () => {
    it('should report healthy when all components are up', async () => {
      const service = createService();
      await service.start();
      const pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      (pmInstance.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(await service.isHealthy()).toBe(true);
    });

    it('should report unhealthy when not started', async () => {
      const service = createService();
      expect(await service.isHealthy()).toBe(false);
    });
  });

  describe('auth', () => {
    it('should return ok auth status when logged in', async () => {
      (execSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({
        loggedIn: true,
        email: 'test@example.com',
        subscriptionType: 'pro',
      }));
      const service = createService();
      const status = await service.validateAuth();
      expect(status.ok).toBe(true);
      expect(status.email).toBe('test@example.com');
    });

    it('should return not ok when not logged in', async () => {
      (execSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({ loggedIn: false }));
      const service = createService();
      const status = await service.validateAuth();
      expect(status.ok).toBe(false);
    });

    it('should return not ok when claude not installed', async () => {
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('not found'); });
      const service = createService();
      const status = await service.validateAuth();
      expect(status.ok).toBe(false);
    });

    it('should return true for isAvailable when claude exists', async () => {
      (execSync as ReturnType<typeof vi.fn>).mockReturnValue('/usr/bin/claude');
      const service = createService();
      expect(await service.isAvailable()).toBe(true);
    });

    it('should return false for isAvailable when claude missing', async () => {
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('not found'); });
      const service = createService();
      expect(await service.isAvailable()).toBe(false);
    });
  });

  describe('permission relay', () => {
    it('should send permission response via WS client', async () => {
      const service = createService();
      await service.start();
      const wsInstance = findWsMock();

      service.sendPermissionResponse('sid', 'req-1', true);
      expect(wsInstance?.send).toHaveBeenCalledWith({
        type: 'permission_response',
        requestId: 'req-1',
        allowed: true,
      });
    });
  });

  describe('history and info', () => {
    let service: ClaudeChannelService;
    let storeInstance: { loadHistory: ReturnType<typeof vi.fn> };
    let registry: { get: ReturnType<typeof vi.fn>; listBySdkType: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      storeInstance = (ClaudeSessionStore as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof storeInstance;
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should load session history', async () => {
      (storeInstance.loadHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { type: 'user', content: 'hi', timestamp: 1 },
      ]);
      const history = await service.loadSessionHistory('sid');
      expect(history).toHaveLength(1);
    });

    it('should set model', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sid', sdkType: 'claude', claudeSessionId: 'cs-1', cwd: '/tmp', status: 'idle',
      });
      const result = await service.setModel('sid', 'opus');
      expect(result).toBe('opus');
    });

    it('should get session', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sid' });
      const session = await service.getSession('sid');
      expect(session).toEqual({ id: 'sid' });
    });

    it('should list sessions', async () => {
      (registry.listBySdkType as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: '1' }, { id: '2' }]);
      const sessions = await service.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should return null stats for unknown session', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const stats = await service.getSessionStats('unknown');
      expect(stats).toBeNull();
    });

    it('should return stats with token counts', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sid', sdkType: 'claude', cwd: '/tmp', model: 'sonnet', path: '/tmp/sid.jsonl',
      });
      (storeInstance.loadHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { type: 'user' },
        { type: 'assistant' },
        { type: 'tool' },
        { type: 'tool_result' },
        { type: 'meta', usage: { input_tokens: 100, output_tokens: 50 } },
      ]);
      const stats = await service.getSessionStats('sid');
      expect(stats).not.toBeNull();
      if (stats) {
        expect(stats.userMessages).toBe(1);
        expect(stats.assistantMessages).toBe(1);
        expect(stats.toolCalls).toBe(1);
        expect(stats.toolResults).toBe(1);
        expect(stats.tokens.input).toBe(100);
        expect(stats.tokens.output).toBe(50);
        expect(stats.tokens.total).toBe(150);
        expect(stats.sessionFile).toBe('/tmp/sid.jsonl');
      }
    });

    it('should return null context usage when no session in registry', async () => {
      const ctx = await service.getContextUsage('sid');
      expect(ctx).toBeNull();
    });
  });
});
