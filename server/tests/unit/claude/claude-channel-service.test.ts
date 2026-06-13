import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../src/claude/claude-channel-process-manager.js', async () => {
  const { EventEmitter: MockEventEmitter } = await import('events');
  const ClaudeChannelProcessManager = vi.fn().mockImplementation(() => {
    const emitter = new MockEventEmitter();
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
      healthCheck: vi.fn().mockResolvedValue(true),
      getState: vi.fn().mockReturnValue({ process: null, status: 'running', startedAt: Date.now() }),
      switchModel: vi.fn().mockReturnValue(false),
      setThinkingLevel: vi.fn().mockReturnValue(false),
      markPromptSent: vi.fn(),
      markPromptComplete: vi.fn(),
      isBusy: vi.fn().mockReturnValue(false),
      waitForIdle: vi.fn().mockResolvedValue(true),
      getLastBusyAt: vi.fn().mockReturnValue(null),
      sendInterrupt: vi.fn(),
      clearContext: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: () => void) => emitter.on(event, handler)),
      __emitter: emitter,
    };
  });
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
    patchSessionMeta: vi.fn().mockResolvedValue(undefined),
  })),
  getSessionRegistry: vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    listBySdkType: vi.fn().mockResolvedValue([]),
    patchSessionMeta: vi.fn().mockResolvedValue(undefined),
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

    it('should reset orphaned running Claude registry sessions on startup', async () => {
      const service = createService();
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      const registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as {
        listBySdkType: ReturnType<typeof vi.fn>;
        updateStatus: ReturnType<typeof vi.fn>;
      };
      registry.listBySdkType.mockResolvedValue([
        { id: 'running-1', sdkType: 'claude', status: 'running' },
        { id: 'idle-1', sdkType: 'claude', status: 'idle' },
      ]);

      await service.start();

      expect(registry.updateStatus).toHaveBeenCalledWith('running-1', 'idle');
      expect(registry.updateStatus).not.toHaveBeenCalledWith('idle-1', 'idle');
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

    it('should persist string tool_result output from channel send_event', async () => {
      const sessionId = 'test-sid-tool-result-string';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tool-result-string', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      wsInstance.__emitter.emit('event', {
        type: 'tool_result',
        sessionId: 'cs-tool-result-string',
        toolCallId: 'tc-string',
        result: 'Read 3 files successfully',
        timestamp: Date.now(),
      });

      await vi.waitFor(() => {
        expect(storeInstance.appendEntry).toHaveBeenCalledWith(sessionId, expect.objectContaining({
          type: 'tool_result',
          toolCallId: 'tc-string',
          toolOutput: 'Read 3 files successfully',
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

    it('should ignore unknown native Claude session events instead of persisting orphan Web UI sessions', async () => {
      const nativeEvent = {
        type: 'tool_execution_end',
        sessionId: 'native-claude-session-id',
        toolCallId: 'native-tool',
        result: 'done',
        timestamp: Date.now(),
      };

      wsInstance.__emitter.emit('event', nativeEvent);

      await vi.advanceTimersByTimeAsync(0);

      expect(storeInstance.appendEntry).not.toHaveBeenCalledWith(
        'native-claude-session-id',
        expect.anything(),
      );
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

  describe('turn correlation and busy state', () => {
    let service: ClaudeChannelService;
    let wsInstance: WsMock;
    let pmInstance: { markPromptSent: ReturnType<typeof vi.fn>; markPromptComplete: ReturnType<typeof vi.fn>; isBusy: ReturnType<typeof vi.fn>; __emitter: EventEmitter };
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      wsInstance = findWsMock() as WsMock;
      pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof pmInstance;
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('rejects a second prompt while one is already in flight', async () => {
      const sessionId = 'tc-busy-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tc-1', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'first', vi.fn(), vi.fn());

      await expect(
        service.sendPrompt(sessionId, 'second', vi.fn(), vi.fn()),
      ).rejects.toThrow(/already in progress/);
    });

    it('tells the process manager a prompt was dispatched', async () => {
      const sessionId = 'tc-mark-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tc-mark-1', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(pmInstance.markPromptSent).toHaveBeenCalled();
    });

    it('tags agent_start with a promptId for turn correlation', async () => {
      const sessionId = 'tc-pid-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tc-pid-1', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, vi.fn());

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent_start',
        data: expect.objectContaining({ promptId: expect.any(String) }),
      }));
    });

    it('isRunning is true while a turn is pending and false after agent_end', async () => {
      const sessionId = 'tc-run-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tc-run-1', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());
      expect(service.isRunning(sessionId)).toBe(true);

      wsInstance.__emitter.emit('event', {
        type: 'agent_end', sessionId: 'cs-tc-run-1', result: 'ok', timestamp: Date.now(),
      });

      await vi.waitFor(() => {
        expect(service.isRunning(sessionId)).toBe(false);
      });
      expect(pmInstance.markPromptComplete).toHaveBeenCalled();
    });

    it('isRunning reflects real PTY busy state even after the pending prompt clears', async () => {
      const sessionId = 'tc-run-2';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tc-run-2', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());
      // Force-complete via timeout so the pending prompt is gone but the PTY
      // may still show Claude working.
      service.abort(sessionId);
      expect(service.isRunning(sessionId)).toBe(false);

      pmInstance.isBusy.mockReturnValue(true);
      expect(service.isRunning(sessionId)).toBe(true);
    });

    it('forwards PTY activity as a stream_activity event to the in-flight turn', async () => {
      const sessionId = 'tc-act-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-tc-act-1', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, vi.fn());
      onEvent.mockClear();

      pmInstance.__emitter.emit('activity');

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'stream_activity',
        sessionId,
      }));
    });
  });

  describe('abort', () => {
    let service: ClaudeChannelService;
    let wsInstance: WsMock;
    let pmInstance: Record<string, ReturnType<typeof vi.fn>> & { __emitter: EventEmitter };
    let wsEmitter: EventEmitter;
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      wsInstance = findWsMock() as WsMock;
      wsEmitter = wsInstance.__emitter;
      pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof pmInstance;

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

    it('should send Escape to PTY on abort', async () => {
      const sessionId = 'abort-sid-escape';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-abort-escape', cwd: '/tmp', status: 'running',
      });

      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), onComplete);

      service.abort(sessionId);

      expect(pmInstance.sendInterrupt).toHaveBeenCalled();
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

    it('should mark session as aborted to suppress late events', async () => {
      const sessionId = 'abort-sid-3';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-abort-3', cwd: '/tmp', status: 'running',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      service.abort(sessionId);

      // Simulate a late message_update from Claude's dying response.
      // This should be suppressed (not forwarded to the client).
      const lateEvent = {
        type: 'message_update',
        sessionId: 'cs-abort-3',
        message: { id: 'msg-1' },
        assistantMessageEvent: { type: 'text_delta', delta: 'Still working...' },
      };
      wsEmitter.emit('event', lateEvent);

      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message_update' }),
      );
    });

    it('should clear abort flag when new prompt is sent', async () => {
      const sessionId = 'abort-sid-4';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-abort-4', cwd: '/tmp', status: 'running',
      });

      const onEvent1 = vi.fn();
      const onComplete1 = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent1, onComplete1);
      service.abort(sessionId);

      const onEvent2 = vi.fn();
      const onComplete2 = vi.fn();
      await service.sendPrompt(sessionId, 'New prompt', onEvent2, onComplete2);

      // After new prompt, events should flow again.
      const normalEvent = {
        type: 'message_start',
        sessionId: 'cs-abort-4',
        message: { id: 'msg-2', role: 'assistant' },
      };
      wsEmitter.emit('event', normalEvent);

      expect(onEvent2).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message_start' }),
      );
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

  describe('prompt timeout', () => {
    let service: ClaudeChannelService;
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should force-complete prompt after timeout', async () => {
      const sessionId = 'timeout-sid-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-timeout-1', cwd: '/tmp', status: 'idle',
      });

      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), onComplete);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('timed out'),
      }));
      expect(service.isRunning(sessionId)).toBe(false);
    });

    it('should emit error and agent_end events when a prompt times out', async () => {
      const sessionId = 'timeout-sid-events';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-timeout-events', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        sessionId,
        data: expect.objectContaining({ code: 'CLAUDE_PROMPT_TIMEOUT' }),
      }));
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent_end',
        sessionId,
        data: expect.objectContaining({ reason: 'prompt_timeout' }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        code: 'CLAUDE_PROMPT_TIMEOUT',
        sessionEventAlreadyEmitted: true,
      }));
    });

    it('should update registry status to idle on timeout', async () => {
      const sessionId = 'timeout-sid-2';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-timeout-2', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(registry.updateStatus).toHaveBeenCalledWith(sessionId, 'idle');
    });

    it('should forward late replies that arrive after timeout', async () => {
      const sessionId = 'timeout-sid-late';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-timeout-late', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, vi.fn());
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      onEvent.mockClear();

      const channelEvent = {
        type: 'message_update',
        sessionId: 'cs-timeout-late',
        assistantMessageEvent: { type: 'text_delta', delta: 'Late answer' },
        timestamp: Date.now(),
      };
      const wsInstance = findWsMock() as WsMock;
      wsInstance.__emitter.emit('event', channelEvent);

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message_update',
        sessionId: 'cs-timeout-late',
      }));
    });

    it('should clear stale late-listener state when a new prompt starts', async () => {
      const sessionId = 'timeout-sid-clear-late';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-timeout-clear-late', cwd: '/tmp', status: 'idle',
      });

      const oldOnEvent = vi.fn();
      await service.sendPrompt(sessionId, 'First prompt', oldOnEvent, vi.fn());
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      oldOnEvent.mockClear();

      const newOnEvent = vi.fn();
      await service.sendPrompt(sessionId, 'Second prompt', newOnEvent, vi.fn());
      const wsInstance = findWsMock() as WsMock;
      wsInstance.__emitter.emit('event', {
        type: 'agent_end',
        sessionId: 'cs-timeout-clear-late',
        timestamp: Date.now(),
      });
      newOnEvent.mockClear();

      wsInstance.__emitter.emit('event', {
        type: 'message_update',
        sessionId: 'cs-timeout-clear-late',
        assistantMessageEvent: { type: 'text_delta', delta: 'Stale late answer' },
        timestamp: Date.now(),
      });

      expect(oldOnEvent).not.toHaveBeenCalled();
      expect(newOnEvent).not.toHaveBeenCalled();
    });
  });

  describe('PTY idle handler', () => {
    let service: ClaudeChannelService;
    let pmInstance: { __emitter: EventEmitter };
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof pmInstance;
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should force-complete pending prompt on PTY idle', async () => {
      const sessionId = 'idle-sid-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-idle-1', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      // Advance past the IDLE_EVENT_SILENCE_MS (60s) so the idle handler
      // treats the prompt as truly silent (no channel events for 60+ seconds).
      vi.advanceTimersByTime(61_000);

      pmInstance.__emitter.emit('idle');

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent_end',
        sessionId,
      }));
      expect(onComplete).toHaveBeenCalledWith();
      expect(service.isRunning(sessionId)).toBe(false);
    });

    it('should not force-complete prompt within grace period', async () => {
      const sessionId = 'idle-sid-2';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-idle-2', cwd: '/tmp', status: 'idle',
      });

      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), onComplete);

      pmInstance.__emitter.emit('idle');

      expect(onComplete).not.toHaveBeenCalled();
      expect(service.isRunning(sessionId)).toBe(true);
    });

    it('should handle idle with no pending prompts', () => {
      expect(() => pmInstance.__emitter.emit('idle')).not.toThrow();
    });

    it('should surface Claude auth expiry from PTY as reauthentication error', async () => {
      const sessionId = 'auth-expired-sid';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-auth-expired', cwd: '/tmp', status: 'idle',
      });

      const onEvent = vi.fn();
      const onComplete = vi.fn();
      await service.sendPrompt(sessionId, 'Hello', onEvent, onComplete);

      pmInstance.__emitter.emit('auth_error', { message: 'Claude Code authentication expired. Please run /login.' });

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        sessionId,
        data: expect.objectContaining({
          code: 'CLAUDE_AUTH_EXPIRED',
          reauthRequired: true,
        }),
      }));
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent_end',
        sessionId,
        data: expect.objectContaining({ reason: 'auth_expired' }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('authentication expired'),
        code: 'CLAUDE_AUTH_EXPIRED',
        sessionEventAlreadyEmitted: true,
      }));
      expect(service.isRunning(sessionId)).toBe(false);
      expect(registry.updateStatus).toHaveBeenCalledWith(sessionId, 'error');
    });
  });

  describe('history and info', () => {
    let service: ClaudeChannelService;
    let storeInstance: { loadHistory: ReturnType<typeof vi.fn> };
    let registry: { get: ReturnType<typeof vi.fn>; listBySdkType: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; patchSessionMeta: ReturnType<typeof vi.fn> };

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

    it('should persist model via patchSessionMeta (not upsert)', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sid', sdkType: 'claude', claudeSessionId: 'cs-1', cwd: '/tmp', status: 'idle',
      });
      await service.setModel('sid', 'opus');

      expect(registry.patchSessionMeta).toHaveBeenCalledWith('sid', { model: 'opus' });
      expect(registry.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sid', model: 'opus' }),
      );
    });

    it('setThinkingLevel should persist via patchSessionMeta (not upsert)', async () => {
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sid', sdkType: 'claude', claudeSessionId: 'cs-1', cwd: '/tmp', status: 'idle',
      });
      service.setThinkingLevel('sid', 'xhigh');

      expect(registry.patchSessionMeta).toHaveBeenCalledWith('sid', { thinkingLevel: 'xhigh' });
      expect(registry.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sid', thinkingLevel: 'xhigh' }),
      );
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
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const ctx = await service.getContextUsage('sid');
      expect(ctx).toBeNull();
    });
  });

  describe('context isolation (session clearing)', () => {
    let service: ClaudeChannelService;
    let pmInstance: { clearContext: ReturnType<typeof vi.fn>; markPromptSent: ReturnType<typeof vi.fn>; markPromptComplete: ReturnType<typeof vi.fn>; isBusy: ReturnType<typeof vi.fn>; __emitter: EventEmitter };
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof pmInstance;
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should clear context on first prompt of a new session', async () => {
      const sessionId = 'iso-new-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-iso-1', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(pmInstance.clearContext).toHaveBeenCalledTimes(1);
    });

    it('should NOT clear context on follow-up prompts in the same session', async () => {
      const sessionId = 'iso-follow-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-iso-follow-1', cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      // Complete the turn so sessionsWithHistory is populated
      const wsInstance = findWsMock() as WsMock;
      wsInstance.__emitter.emit('event', {
        type: 'agent_end', sessionId: 'cs-iso-follow-1', result: 'ok', timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(service.isRunning(sessionId)).toBe(false);
      });

      // Advance past the post-turn settle window so the next sendPrompt
      // doesn't wait for it.
      await vi.advanceTimersByTimeAsync(5_000);

      pmInstance.clearContext.mockClear();

      await service.sendPrompt(sessionId, 'Follow-up', vi.fn(), vi.fn());

      expect(pmInstance.clearContext).not.toHaveBeenCalled();
    });

    it('should clear context when switching to a different session', async () => {
      const sessionA = 'iso-switch-a';
      const sessionB = 'iso-switch-b';
      (registry.get as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
        if (id === sessionA) return { id: sessionA, sdkType: 'claude', claudeSessionId: 'cs-switch-a', cwd: '/tmp', status: 'idle' };
        if (id === sessionB) return { id: sessionB, sdkType: 'claude', claudeSessionId: 'cs-switch-b', cwd: '/tmp', status: 'idle' };
        return null;
      });

      await service.sendPrompt(sessionA, 'Hello A', vi.fn(), vi.fn());

      expect(pmInstance.clearContext).toHaveBeenCalledTimes(1);

      // Complete the turn
      const wsInstance = findWsMock() as WsMock;
      wsInstance.__emitter.emit('event', {
        type: 'agent_end', sessionId: 'cs-switch-a', result: 'ok', timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(service.isRunning(sessionA)).toBe(false);
      });

      // Advance past the post-turn settle window
      await vi.advanceTimersByTimeAsync(5_000);

      pmInstance.clearContext.mockClear();

      // Now send first prompt from session B — should clear again
      await service.sendPrompt(sessionB, 'Hello B', vi.fn(), vi.fn());

      expect(pmInstance.clearContext).toHaveBeenCalledTimes(1);
    });

    it('should NOT clear when the same session re-sends after context was already established', async () => {
      const sessionId = 'iso-reentrant-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-reentrant-1', cwd: '/tmp', status: 'idle',
      });

      // First prompt clears
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      // Complete the turn
      const wsInstance = findWsMock() as WsMock;
      wsInstance.__emitter.emit('event', {
        type: 'agent_end', sessionId: 'cs-reentrant-1', result: 'ok', timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(service.isRunning(sessionId)).toBe(false);
      });

      // Advance past the post-turn settle window
      await vi.advanceTimersByTimeAsync(5_000);

      pmInstance.clearContext.mockClear();

      // Second prompt in same session — should NOT clear
      await service.sendPrompt(sessionId, 'Follow-up', vi.fn(), vi.fn());

      expect(pmInstance.clearContext).not.toHaveBeenCalled();
    });
  });

  describe('model and thinking-level restoration on sendPrompt', () => {
    let service: ClaudeChannelService;
    let pmInstance: { switchModel: ReturnType<typeof vi.fn>; setThinkingLevel: ReturnType<typeof vi.fn>; clearContext: ReturnType<typeof vi.fn>; markPromptSent: ReturnType<typeof vi.fn>; markPromptComplete: ReturnType<typeof vi.fn>; isBusy: ReturnType<typeof vi.fn>; __emitter: EventEmitter };
    let registry: { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn>; patchSessionMeta: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      service = createService();
      await service.start();
      pmInstance = (ClaudeChannelProcessManager as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as typeof pmInstance;
      const registryFn = getSessionRegistry as ReturnType<typeof vi.fn>;
      registry = registryFn.mock.results[registryFn.mock.results.length - 1]?.value as typeof registry;
    });

    it('should restore the session model on the shared PTY before dispatching', async () => {
      const sessionId = 'restore-model-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-restore-model-1',
        cwd: '/tmp', status: 'idle', model: 'opus', thinkingLevel: 'high',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(pmInstance.switchModel).toHaveBeenCalledWith('opus');
    });

    it('should restore the session thinking level on the shared PTY before dispatching', async () => {
      const sessionId = 'restore-tl-1';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-restore-tl-1',
        cwd: '/tmp', status: 'idle', model: 'sonnet', thinkingLevel: 'xhigh',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(pmInstance.setThinkingLevel).toHaveBeenCalledWith('xhigh');
    });

    it('should restore model and thinking level when another session changed them', async () => {
      const sessionA = 'restore-a';
      const sessionB = 'restore-b';
      (registry.get as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
        if (id === sessionA) return { id: sessionA, sdkType: 'claude', claudeSessionId: 'cs-a', cwd: '/tmp', status: 'idle', model: 'opus', thinkingLevel: 'high' };
        if (id === sessionB) return { id: sessionB, sdkType: 'claude', claudeSessionId: 'cs-b', cwd: '/tmp', status: 'idle', model: 'haiku', thinkingLevel: 'low' };
        return null;
      });

      await service.sendPrompt(sessionA, 'Hello A', vi.fn(), vi.fn());

      const wsInstance = findWsMock() as WsMock;
      wsInstance.__emitter.emit('event', {
        type: 'agent_end', sessionId: 'cs-a', result: 'ok', timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(service.isRunning(sessionA)).toBe(false);
      });

      // Advance past the post-turn settle window
      await vi.advanceTimersByTimeAsync(5_000);

      pmInstance.switchModel.mockClear();
      pmInstance.setThinkingLevel.mockClear();

      await service.sendPrompt(sessionB, 'Hello B', vi.fn(), vi.fn());

      expect(pmInstance.switchModel).toHaveBeenCalledWith('haiku');
      expect(pmInstance.setThinkingLevel).toHaveBeenCalledWith('low');
    });

    it('should default to sonnet and medium when model/thinkingLevel are unset', async () => {
      const sessionId = 'restore-defaults';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-defaults',
        cwd: '/tmp', status: 'idle',
      });

      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      expect(pmInstance.switchModel).toHaveBeenCalledWith('sonnet');
      expect(pmInstance.setThinkingLevel).toHaveBeenCalledWith('medium');
    });

    it('should delay before dispatching when the model actually changed', async () => {
      const sessionId = 'restore-delay';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-delay',
        cwd: '/tmp', status: 'idle', model: 'opus', thinkingLevel: 'high',
      });

      // switchModel returns true → model changed → delay should fire
      pmInstance.switchModel.mockReturnValue(true);
      pmInstance.setThinkingLevel.mockReturnValue(false);

      const wsInstance = findWsMock() as WsMock;
      const sendPromise = service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      // The prompt should NOT have been sent yet (delay is in progress)
      await vi.advanceTimersByTimeAsync(500);
      expect(wsInstance.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }));

      // After the full delay, the prompt should be dispatched
      await vi.advanceTimersByTimeAsync(500);
      await sendPromise;

      expect(wsInstance.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'prompt',
        sessionId: 'cs-delay',
      }));
    });

    it('should wait for PTY settle after a recent agent_end before slash commands', async () => {
      const sessionId = 'settle-test';
      (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: sessionId, sdkType: 'claude', claudeSessionId: 'cs-settle',
        cwd: '/tmp', status: 'idle', model: 'opus', thinkingLevel: 'high',
      });

      pmInstance.switchModel.mockReturnValue(false);
      pmInstance.setThinkingLevel.mockReturnValue(false);

      const wsInstance = findWsMock() as WsMock;

      // First prompt — establishes the session
      await service.sendPrompt(sessionId, 'Hello', vi.fn(), vi.fn());

      // Complete the turn — this sets lastAgentEndAt
      wsInstance.__emitter.emit('event', {
        type: 'agent_end', sessionId: 'cs-settle', result: 'ok', timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(service.isRunning(sessionId)).toBe(false);
      });

      // For the second prompt, switchModel returns true → model changed + delay
      pmInstance.switchModel.mockReturnValue(true);
      pmInstance.setThinkingLevel.mockReturnValue(false);
      pmInstance.switchModel.mockClear();

      const sendPromise = service.sendPrompt(sessionId, 'Follow-up', vi.fn(), vi.fn());

      // After 2s: settle still in progress (3s window), model NOT switched yet
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pmInstance.switchModel).not.toHaveBeenCalled();

      // After 1s more (3s total): settle done, model switch fires, 1s delay starts
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pmInstance.switchModel).toHaveBeenCalledWith('opus');

      // After 1s more (4s total): delay done, prompt dispatched
      await vi.advanceTimersByTimeAsync(1_000);
      await sendPromise;

      expect(wsInstance.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'prompt',
        content: 'Follow-up',
      }));
    });
  });
});
