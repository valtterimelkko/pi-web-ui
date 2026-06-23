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

});
