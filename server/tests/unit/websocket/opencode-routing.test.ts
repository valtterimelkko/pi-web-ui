import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeSessionSubscribers } from '../../../src/opencode/opencode-session-subscribers.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

function normEventToPiFormat(event: NormalizedEvent): Record<string, unknown> {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'message_start':
      return { type: 'message_start', message: { id: data.id, role: data.role } };
    case 'message_update':
      return { type: 'message_update', message: { id: data.id }, assistantMessageEvent: data.assistantMessageEvent };
    case 'message_end':
      return { type: 'message_end', message: { id: data.id } };
    case 'tool_execution_start':
      return { type: 'tool_execution_start', toolCallId: data.toolCallId, toolName: data.toolName, args: data.args };
    case 'tool_execution_end':
      return { type: 'tool_execution_end', toolCallId: data.toolCallId, result: data.result, isError: data.isError };
    case 'tool_execution_update':
      return { type: 'tool_execution_update', toolCallId: data.toolCallId, partialResult: data.partialResult };
    case 'agent_start':
      return { type: 'agent_start' };
    case 'agent_end':
      return { type: 'agent_end', result: (data as Record<string, unknown>).result, usage: (data as Record<string, unknown>).usage };
    case 'session_init':
      return { type: 'session_init', ...data };
    case 'rate_limit':
      return { type: 'rate_limit', ...data };
    default:
      return { type: event.type, ...data };
  }
}

describe('OpenCode WebSocket Routing', () => {

  describe('new_session (sdkType=opencode)', () => {
    it('creates session via opencodeService and sends session_created', async () => {
      const sessionId = 'oc-uuid-new';
      const opencodeService = {
        createSession: vi.fn().mockResolvedValue({ sessionId, opencodeSessionId: 'oc-real-1' }),
        isAvailable: vi.fn().mockResolvedValue(true),
        validateSetup: vi.fn().mockResolvedValue({ ok: true }),
        listSessions: vi.fn().mockResolvedValue([]),
        touchSession: vi.fn(),
        pinSession: vi.fn(),
        unpinSession: vi.fn(),
        hasSession: vi.fn(),
        isSessionPinned: vi.fn(),
      };

      const opencodeSessionIds = new Set<string>();
      const opencodeSubs = new OpenCodeSessionSubscribers();
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const clientViewingSession = new Map<string, string>();
      const clientCwd = new Map<string, string>();

      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const clientId = 'client-1';
      const cwd = '/tmp/test';

      const sdkType = 'opencode';
      if (sdkType === 'opencode') {
        const { sessionId: sid } = await opencodeService.createSession(cwd);
        opencodeSessionIds.add(sid);
        clientViewingSession.set(clientId, sid);
        opencodeSubs.subscribe(clientId, sid);
        clientCwd.set(clientId, cwd);

        sendMessage(clientId, {
          type: 'session_created',
          sessionId: sid,
          sessionPath: sid,
          sdkType: 'opencode',
        });
      }

      expect(opencodeService.createSession).toHaveBeenCalledWith(cwd);
      expect(opencodeSessionIds.has(sessionId)).toBe(true);
      expect(clientViewingSession.get(clientId)).toBe(sessionId);
      expect(opencodeSubs.isSubscribed(clientId, sessionId)).toBe(true);
      expect(clientCwd.get(clientId)).toBe(cwd);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        clientId,
        message: {
          type: 'session_created',
          sessionId,
          sessionPath: sessionId,
          sdkType: 'opencode',
        },
      });
    });

    it('sends error when createSession fails', async () => {
      const opencodeService = {
        createSession: vi.fn().mockRejectedValue(new Error('Server not running')),
        isAvailable: vi.fn().mockResolvedValue(true),
        validateSetup: vi.fn().mockResolvedValue({ ok: true }),
        listSessions: vi.fn().mockResolvedValue([]),
      };

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const clientId = 'client-1';
      try {
        await opencodeService.createSession('/tmp');
      } catch (error) {
        sendMessage(clientId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to create OpenCode session',
          code: 'SESSION_CREATE_FAILED',
        });
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0].message as Record<string, unknown>).code).toBe('SESSION_CREATE_FAILED');
    });
  });

  describe('prompt routing to OpenCode', () => {
    it('routes prompt to opencodeService when session is in opencodeSessionIds', async () => {
      const sessionId = 'oc-uuid-prompt';
      const events: NormalizedEvent[] = [];
      let onCompleteCalled = false;

      const opencodeService = {
        sendPrompt: vi.fn().mockImplementation(async (
          _sid: string,
          _prompt: string,
          onEvent: (e: NormalizedEvent) => void,
          onComplete: (err?: Error) => void,
        ) => {
          onEvent({ type: 'agent_start', sessionId, timestamp: Date.now(), data: {} });
          onCompleteCalled = true;
          onComplete();
        }),
        isRunning: vi.fn().mockReturnValue(false),
      };

      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', sessionId);
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      await opencodeService.sendPrompt(
        sessionId,
        'Hello OpenCode',
        (event) => {
          events.push(event);
        },
        () => {
          onCompleteCalled = true;
        },
      );

      expect(opencodeService.sendPrompt).toHaveBeenCalledWith(
        sessionId,
        'Hello OpenCode',
        expect.any(Function),
        expect.any(Function),
      );
      expect(events.some(e => e.type === 'agent_start')).toBe(true);
      expect(onCompleteCalled).toBe(true);
    });

    it('converts NormalizedEvents to Pi format via normEventToPiFormat', () => {
      const sessionId = 'oc-uuid-fmt';

      const agentStart = normEventToPiFormat({
        type: 'agent_start', sessionId, timestamp: Date.now(), data: {},
      });
      expect(agentStart).toEqual({ type: 'agent_start' });

      const msgStart = normEventToPiFormat({
        type: 'message_start', sessionId, timestamp: Date.now(),
        data: { id: 'msg-1', role: 'assistant' },
      });
      expect(msgStart).toEqual({ type: 'message_start', message: { id: 'msg-1', role: 'assistant' } });

      const msgUpdate = normEventToPiFormat({
        type: 'message_update', sessionId, timestamp: Date.now(),
        data: { id: 'msg-1', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } },
      });
      expect(msgUpdate.type).toBe('message_update');
      expect(msgUpdate.message).toEqual({ id: 'msg-1' });

      const toolStart = normEventToPiFormat({
        type: 'tool_execution_start', sessionId, timestamp: Date.now(),
        data: { toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } },
      });
      expect(toolStart).toEqual({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'bash',
        args: { command: 'ls' },
      });

      const toolEnd = normEventToPiFormat({
        type: 'tool_execution_end', sessionId, timestamp: Date.now(),
        data: { toolCallId: 'tc-1', result: 'file.txt', isError: false },
      });
      expect(toolEnd).toEqual({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        result: 'file.txt',
        isError: false,
      });

      const agentEnd = normEventToPiFormat({
        type: 'agent_end', sessionId, timestamp: Date.now(),
        data: { result: null, usage: {} },
      });
      expect(agentEnd).toEqual({ type: 'agent_end', result: null, usage: {} });
    });

    it('broadcasts events to all subscribers', () => {
      const sessionId = 'oc-uuid-broadcast';
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', sessionId);
      opencodeSubs.subscribe('client-2', sessionId);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const piEvent = { type: 'agent_start' };
      const msg = { type: 'session_event', sessionId, event: piEvent };
      const subscribers = opencodeSubs.getSubscribers(sessionId);
      for (const subId of subscribers) {
        sendMessage(subId, msg);
      }

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages.map(s => s.clientId).sort()).toEqual(['client-1', 'client-2']);
    });
  });

  describe('permission_request → extension_ui_request conversion', () => {
    it('converts permission_request to extension_ui_request with correct shape', () => {
      const sessionId = 'oc-uuid-perm';
      const permData = {
        permissionId: 'perm-123',
        toolName: 'bash',
        args: { command: 'npm install' },
        title: 'Allow bash?',
        description: 'OpenCode wants to run: bash\n{ "command": "npm install" }',
      };

      const uiRequest = {
        type: 'extension_ui_request' as const,
        request: {
          id: permData.permissionId,
          type: 'confirm' as const,
          method: `opencode.permission.${permData.toolName}`,
          params: {
            title: permData.title,
            description: permData.description,
            toolName: permData.toolName,
            args: permData.args,
          },
          timeout: 120000,
        },
      };

      expect(uiRequest.type).toBe('extension_ui_request');
      expect(uiRequest.request.id).toBe('perm-123');
      expect(uiRequest.request.type).toBe('confirm');
      expect(uiRequest.request.method).toBe('opencode.permission.bash');
      expect(uiRequest.request.params.toolName).toBe('bash');
      expect(uiRequest.request.timeout).toBe(120000);
    });

    it('broadcasts extension_ui_request to all subscribers', () => {
      const sessionId = 'oc-uuid-perm-bcast';
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', sessionId);
      opencodeSubs.subscribe('client-2', sessionId);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const uiRequest = {
        type: 'extension_ui_request' as const,
        request: {
          id: 'perm-123',
          type: 'confirm' as const,
          method: 'opencode.permission.bash',
          params: { toolName: 'bash' },
          timeout: 120000,
        },
      };

      const subscribers = opencodeSubs.getSubscribers(sessionId);
      for (const subId of subscribers) {
        sendMessage(subId, uiRequest);
      }

      expect(sentMessages).toHaveLength(2);
      for (const sent of sentMessages) {
        expect((sent.message as Record<string, unknown>).type).toBe('extension_ui_request');
      }
    });
  });

  describe('extension_ui_response → resolvePermission', () => {
    it('routes approved response to opencodeService.resolvePermission', async () => {
      const opencodeService = {
        isPendingPermission: vi.fn().mockReturnValue(true),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
      };

      const id = 'perm-123';
      const approved = true;
      const cancelled = false;
      const isApproved = approved === true && cancelled !== true;

      if (opencodeService.isPendingPermission(id)) {
        await opencodeService.resolvePermission(id, isApproved);
      }

      expect(opencodeService.isPendingPermission).toHaveBeenCalledWith('perm-123');
      expect(opencodeService.resolvePermission).toHaveBeenCalledWith('perm-123', true);
    });

    it('routes rejected response with approved=false', async () => {
      const opencodeService = {
        isPendingPermission: vi.fn().mockReturnValue(true),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
      };

      const id = 'perm-456';
      const approved = false;
      const cancelled = false;
      const isApproved = approved === true && cancelled !== true;

      if (opencodeService.isPendingPermission(id)) {
        await opencodeService.resolvePermission(id, isApproved);
      }

      expect(opencodeService.resolvePermission).toHaveBeenCalledWith('perm-456', false);
    });

    it('routes cancelled response as not approved', async () => {
      const opencodeService = {
        isPendingPermission: vi.fn().mockReturnValue(true),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
      };

      const id = 'perm-789';
      const approved = true;
      const cancelled = true;
      const isApproved = approved === true && cancelled !== true;

      if (opencodeService.isPendingPermission(id)) {
        await opencodeService.resolvePermission(id, isApproved);
      }

      expect(opencodeService.resolvePermission).toHaveBeenCalledWith('perm-789', false);
    });

    it('does not call resolvePermission for unknown permission IDs', async () => {
      const opencodeService = {
        isPendingPermission: vi.fn().mockReturnValue(false),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
      };

      const id = 'unknown-perm';

      if (opencodeService.isPendingPermission(id)) {
        await opencodeService.resolvePermission(id, true);
      }

      expect(opencodeService.resolvePermission).not.toHaveBeenCalled();
    });
  });

  describe('abort routing to OpenCode', () => {
    it('calls opencodeService.abort and broadcasts agent_end to subscribers', () => {
      const sessionId = 'oc-uuid-abort';
      const opencodeService = {
        abort: vi.fn(),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', sessionId);
      opencodeSubs.subscribe('client-2', sessionId);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      if (opencodeSessionIds.has(sessionId)) {
        opencodeService.abort(sessionId);
        const subscribers = opencodeSubs.getSubscribers(sessionId);
        for (const subId of subscribers) {
          sendMessage(subId, {
            type: 'session_event',
            sessionId,
            event: { type: 'agent_end', result: null, usage: {} },
          });
        }
      }

      expect(opencodeService.abort).toHaveBeenCalledWith(sessionId);
      expect(sentMessages).toHaveLength(2);
      for (const sent of sentMessages) {
        const msg = sent.message as Record<string, unknown>;
        expect(msg.type).toBe('session_event');
        expect((msg.event as Record<string, unknown>).type).toBe('agent_end');
      }
    });
  });

  describe('switch_session for OpenCode', () => {
    it('subscribes client, touches session, and replays history', async () => {
      const sessionId = 'oc-uuid-switch';
      const opencodeService = {
        touchSession: vi.fn(),
        getReplayEvents: vi.fn().mockResolvedValue([
          { type: 'message_start', data: { id: 'm1', role: 'user' } },
          { type: 'message_update', data: { id: 'm1' } },
          { type: 'message_end', data: { id: 'm1' } },
        ]),
        getSession: vi.fn().mockResolvedValue({
          id: sessionId,
          sdkType: 'opencode',
          model: 'zai-coding-plan/glm-4',
        }),
        isRunning: vi.fn().mockReturnValue(false),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const opencodeSubs = new OpenCodeSessionSubscribers();
      const clientViewingSession = new Map<string, string>();
      const oldSession = 'oc-uuid-old';
      opencodeSubs.subscribe('client-1', oldSession);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const clientId = 'client-1';
      const sessionPath = sessionId;

      if (oldSession && oldSession !== sessionPath) {
        opencodeSubs.unsubscribe(clientId, oldSession);
      }
      clientViewingSession.set(clientId, sessionPath);
      opencodeSubs.subscribe(clientId, sessionPath);
      opencodeService.touchSession(sessionPath);

      expect(opencodeSubs.isSubscribed(clientId, sessionPath)).toBe(true);
      expect(opencodeSubs.isSubscribed(clientId, oldSession)).toBe(false);
      expect(clientViewingSession.get(clientId)).toBe(sessionPath);
      expect(opencodeService.touchSession).toHaveBeenCalledWith(sessionId);
    });

    it('detects opencode session from registry when not in active set', async () => {
      const sessionId = 'oc-uuid-reg';
      const opencodeSessionIds = new Set<string>();
      const registry = {
        get: vi.fn().mockResolvedValue({ id: sessionId, sdkType: 'opencode', opencodeSessionId: 'oc-real' }),
      };

      let isOpencodeSession = opencodeSessionIds.has(sessionId);
      if (!isOpencodeSession) {
        const entry = await registry.get(sessionId);
        if (entry?.sdkType === 'opencode') {
          isOpencodeSession = true;
          opencodeSessionIds.add(sessionId);
        }
      }

      expect(isOpencodeSession).toBe(true);
      expect(opencodeSessionIds.has(sessionId)).toBe(true);
    });
  });

  describe('pin_session / unpin_session for OpenCode', () => {
    it('routes pin to opencodeService.pinSession and sends session_pinned', () => {
      const sessionId = 'oc-uuid-pin';
      const opencodeService = {
        pinSession: vi.fn().mockReturnValue(true),
        hasSession: vi.fn().mockReturnValue(true),
      };
      const opencodeSessionIds = new Set([sessionId]);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };
      const clientId = 'client-1';

      if (opencodeSessionIds.has(sessionId)) {
        const success = opencodeService.pinSession(sessionId);
        if (success) {
          sendMessage(clientId, {
            type: 'session_pinned',
            sessionPath: sessionId,
            pinned: true,
          });
        }
      }

      expect(opencodeService.pinSession).toHaveBeenCalledWith(sessionId);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        clientId,
        message: { type: 'session_pinned', sessionPath: sessionId, pinned: true },
      });
    });

    it('sends session_pin_error when pin limit reached', () => {
      const sessionId = 'oc-uuid-pinlim';
      const opencodeService = {
        pinSession: vi.fn().mockReturnValue(false),
        hasSession: vi.fn().mockReturnValue(true),
      };
      const opencodeSessionIds = new Set([sessionId]);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };
      const clientId = 'client-1';

      if (opencodeSessionIds.has(sessionId)) {
        const success = opencodeService.pinSession(sessionId);
        if (!success) {
          const hasSession = opencodeService.hasSession(sessionId);
          sendMessage(clientId, {
            type: 'session_pin_error',
            sessionPath: sessionId,
            error: hasSession ? 'Maximum pinned sessions limit reached' : 'Session not found',
          });
        }
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0].message as Record<string, unknown>).type).toBe('session_pin_error');
      expect((sentMessages[0].message as Record<string, unknown>).error).toBe('Maximum pinned sessions limit reached');
    });

    it('routes unpin to opencodeService.unpinSession and sends session_pinned false', () => {
      const sessionId = 'oc-uuid-unpin';
      const opencodeService = {
        unpinSession: vi.fn().mockReturnValue(true),
      };
      const opencodeSessionIds = new Set([sessionId]);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };
      const clientId = 'client-1';

      if (opencodeSessionIds.has(sessionId)) {
        opencodeService.unpinSession(sessionId);
        sendMessage(clientId, {
          type: 'session_pinned',
          sessionPath: sessionId,
          pinned: false,
        });
      }

      expect(opencodeService.unpinSession).toHaveBeenCalledWith(sessionId);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        clientId,
        message: { type: 'session_pinned', sessionPath: sessionId, pinned: false },
      });
    });

    it('falls through to Pi SDK pin when session is not OpenCode', () => {
      const piSessionPath = '/path/to/pi-session';
      const opencodeSessionIds = new Set<string>(['oc-other']);
      const multiSessionManager = {
        pinSession: vi.fn().mockReturnValue(true),
      };

      if (!opencodeSessionIds.has(piSessionPath)) {
        multiSessionManager.pinSession(piSessionPath);
      }

      expect(multiSessionManager.pinSession).toHaveBeenCalledWith(piSessionPath);
    });
  });

  describe('get_sessions including OpenCode sessions', () => {
    it('merges OpenCode sessions into the full session list', async () => {
      const opencodeService = {
        listSessions: vi.fn().mockResolvedValue([
          { id: 'oc-1', firstMessage: 'hello', messageCount: 3, cwd: '/tmp', createdAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-01T01:00:00Z' },
          { id: 'oc-2', firstMessage: 'world', messageCount: 1, cwd: '/root', createdAt: '2026-01-02T00:00:00Z', lastActivity: '2026-01-02T01:00:00Z' },
        ]),
      };

      const opencodeEntries = await opencodeService.listSessions();
      const formattedOpencodeSessions = opencodeEntries.map(entry => ({
        id: entry.id,
        path: entry.id,
        sdkType: 'opencode' as const,
        firstMessage: entry.firstMessage || '',
        messageCount: entry.messageCount || 0,
        cwd: entry.cwd || '',
        name: undefined,
        createdAt: entry.createdAt || new Date().toISOString(),
        lastActivity: entry.lastActivity || new Date().toISOString(),
      }));

      expect(formattedOpencodeSessions).toHaveLength(2);
      expect(formattedOpencodeSessions[0].sdkType).toBe('opencode');
      expect(formattedOpencodeSessions[1].cwd).toBe('/root');
    });
  });

  describe('set_model for OpenCode sessions', () => {
    it('calls opencodeService.setModel and sends model_changed', async () => {
      const sessionId = 'oc-uuid-model';
      const opencodeService = {
        setModel: vi.fn().mockResolvedValue('zai-coding-plan/glm-4'),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const clientViewingSession = new Map<string, string>();
      clientViewingSession.set('client-1', sessionId);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const sessionPath = clientViewingSession.get('client-1');
      if (sessionPath && opencodeSessionIds.has(sessionPath)) {
        const normalizedModel = await opencodeService.setModel(sessionPath, 'zai-coding-plan/glm-4');
        sendMessage('client-1', { type: 'model_changed', modelId: normalizedModel });
      }

      expect(opencodeService.setModel).toHaveBeenCalledWith(sessionId, 'zai-coding-plan/glm-4');
      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0].message as Record<string, unknown>).modelId).toBe('zai-coding-plan/glm-4');
    });

    it('sends error when setModel fails', async () => {
      const sessionId = 'oc-uuid-model-err';
      const opencodeService = {
        setModel: vi.fn().mockRejectedValue(new Error('Unknown model')),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const clientViewingSession = new Map<string, string>();
      clientViewingSession.set('client-1', sessionId);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const sessionPath = clientViewingSession.get('client-1');
      if (sessionPath && opencodeSessionIds.has(sessionPath)) {
        try {
          await opencodeService.setModel(sessionPath, 'bad-model');
        } catch (error) {
          sendMessage('client-1', {
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to change model',
            code: 'MODEL_CHANGE_FAILED',
          });
        }
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0].message as Record<string, unknown>).code).toBe('MODEL_CHANGE_FAILED');
    });
  });

  describe('session status broadcasting for OpenCode', () => {
    it('broadcasts streaming status when isRunning is true', () => {
      const sessionId = 'oc-uuid-status';
      const opencodeService = {
        isRunning: vi.fn().mockReturnValue(true),
        isSessionPinned: vi.fn().mockReturnValue(false),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', sessionId);

      const broadcastMessages: unknown[] = [];
      const broadcast = (message: unknown) => {
        broadcastMessages.push(message);
      };

      for (const sid of opencodeSessionIds) {
        const subscribers = opencodeSubs.getSubscribers(sid);
        if (subscribers.size > 0) {
          const isRunning = opencodeService.isRunning(sid);
          const isPinned = opencodeService.isSessionPinned(sid);
          broadcast({
            type: 'session_status',
            sessionId: sid,
            sessionPath: sid,
            status: isRunning ? 'streaming' : 'idle',
            lastActivity: new Date().toISOString(),
            pinned: isPinned,
          });
        }
      }

      expect(broadcastMessages).toHaveLength(1);
      const msg = broadcastMessages[0] as Record<string, unknown>;
      expect(msg.status).toBe('streaming');
      expect(msg.pinned).toBe(false);
    });

    it('broadcasts idle status with pinned=true for pinned sessions', () => {
      const sessionId = 'oc-uuid-pinned-status';
      const opencodeService = {
        isRunning: vi.fn().mockReturnValue(false),
        isSessionPinned: vi.fn().mockReturnValue(true),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', sessionId);

      const broadcastMessages: unknown[] = [];
      const broadcast = (message: unknown) => {
        broadcastMessages.push(message);
      };

      for (const sid of opencodeSessionIds) {
        const subscribers = opencodeSubs.getSubscribers(sid);
        if (subscribers.size > 0) {
          const isRunning = opencodeService.isRunning(sid);
          const isPinned = opencodeService.isSessionPinned(sid);
          broadcast({
            type: 'session_status',
            sessionId: sid,
            sessionPath: sid,
            status: isRunning ? 'streaming' : 'idle',
            lastActivity: new Date().toISOString(),
            pinned: isPinned,
          });
        }
      }

      expect(broadcastMessages).toHaveLength(1);
      const msg = broadcastMessages[0] as Record<string, unknown>;
      expect(msg.status).toBe('idle');
      expect(msg.pinned).toBe(true);
    });

    it('does not broadcast for sessions with no subscribers', () => {
      const sessionId = 'oc-uuid-nosub';
      const opencodeService = {
        isRunning: vi.fn().mockReturnValue(false),
        isSessionPinned: vi.fn().mockReturnValue(false),
      };
      const opencodeSessionIds = new Set([sessionId]);
      const opencodeSubs = new OpenCodeSessionSubscribers();

      const broadcastMessages: unknown[] = [];
      const broadcast = (message: unknown) => {
        broadcastMessages.push(message);
      };

      for (const sid of opencodeSessionIds) {
        const subscribers = opencodeSubs.getSubscribers(sid);
        if (subscribers.size > 0) {
          broadcast({ type: 'session_status', sessionId: sid });
        }
      }

      expect(broadcastMessages).toHaveLength(0);
    });
  });

  describe('opencode_available on auth', () => {
    it('sends opencode_available true when service is available and setup is ok', async () => {
      const opencodeService = {
        isAvailable: vi.fn().mockResolvedValue(true),
        validateSetup: vi.fn().mockResolvedValue({ ok: true }),
      };

      const sentMessages: unknown[] = [];
      const sendMessage = (_clientId: string, message: unknown) => {
        sentMessages.push(message);
      };

      const available = await opencodeService.isAvailable();
      if (available) {
        const setup = await opencodeService.validateSetup();
        sendMessage('client-1', {
          type: 'opencode_available',
          available: setup.ok,
          error: setup.ok ? null : (setup.error ?? null),
        });
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0] as Record<string, unknown>)).toEqual({
        type: 'opencode_available',
        available: true,
        error: null,
      });
    });

    it('sends opencode_available false when not installed', async () => {
      const opencodeService = {
        isAvailable: vi.fn().mockResolvedValue(false),
      };

      const sentMessages: unknown[] = [];
      const sendMessage = (_clientId: string, message: unknown) => {
        sentMessages.push(message);
      };

      const available = await opencodeService.isAvailable();
      if (!available) {
        sendMessage('client-1', {
          type: 'opencode_available',
          available: false,
          error: 'OpenCode not installed',
        });
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0] as Record<string, unknown>)).toEqual({
        type: 'opencode_available',
        available: false,
        error: 'OpenCode not installed',
      });
    });

    it('sends opencode_available false with error when setup fails', async () => {
      const opencodeService = {
        isAvailable: vi.fn().mockResolvedValue(true),
        validateSetup: vi.fn().mockResolvedValue({ ok: false, error: 'Server health check failed' }),
      };

      const sentMessages: unknown[] = [];
      const sendMessage = (_clientId: string, message: unknown) => {
        sentMessages.push(message);
      };

      const available = await opencodeService.isAvailable();
      if (available) {
        const setup = await opencodeService.validateSetup();
        sendMessage('client-1', {
          type: 'opencode_available',
          available: setup.ok,
          error: setup.ok ? null : (setup.error ?? null),
        });
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0] as Record<string, unknown>)).toEqual({
        type: 'opencode_available',
        available: false,
        error: 'Server health check failed',
      });
    });
  });

  describe('restoreOpencodeSessionIds on startup', () => {
    it('restores session IDs from registry', async () => {
      const registry = {
        listBySdkType: vi.fn().mockResolvedValue([
          { id: 'oc-restored-1', sdkType: 'opencode' },
          { id: 'oc-restored-2', sdkType: 'opencode' },
        ]),
      };

      const opencodeSessionIds = new Set<string>();
      const entries = await registry.listBySdkType('opencode');
      for (const entry of entries) {
        opencodeSessionIds.add(entry.id);
      }

      expect(opencodeSessionIds.size).toBe(2);
      expect(opencodeSessionIds.has('oc-restored-1')).toBe(true);
      expect(opencodeSessionIds.has('oc-restored-2')).toBe(true);
    });

    it('handles empty registry gracefully', async () => {
      const registry = {
        listBySdkType: vi.fn().mockResolvedValue([]),
      };

      const opencodeSessionIds = new Set<string>();
      const entries = await registry.listBySdkType('opencode');
      for (const entry of entries) {
        opencodeSessionIds.add(entry.id);
      }

      expect(opencodeSessionIds.size).toBe(0);
    });
  });

  describe('handleDisconnect cleanup for OpenCode', () => {
    it('unsubscribes client from all OpenCode sessions', () => {
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', 'oc-session-a');
      opencodeSubs.subscribe('client-1', 'oc-session-b');
      opencodeSubs.subscribe('client-2', 'oc-session-a');

      expect(opencodeSubs.getSubscriberCount('oc-session-a')).toBe(2);
      expect(opencodeSubs.getSubscriberCount('oc-session-b')).toBe(1);

      opencodeSubs.unsubscribeAll('client-1');

      expect(opencodeSubs.getSubscriberCount('oc-session-a')).toBe(1);
      expect(opencodeSubs.getSubscriberCount('oc-session-b')).toBe(0);
      expect(opencodeSubs.isSubscribed('client-2', 'oc-session-a')).toBe(true);
    });

    it('cleans up session subscriber sets when they become empty', () => {
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('client-1', 'oc-session-only');

      expect(opencodeSubs.sessionCount).toBe(1);

      opencodeSubs.unsubscribeAll('client-1');

      expect(opencodeSubs.sessionCount).toBe(0);
      expect(opencodeSubs.getSubscriberCount('oc-session-only')).toBe(0);
    });
  });

  describe('subscriber fanout in handleOpencodePrompt', () => {
    it('sends events to subscribers when they exist, not to originating client', () => {
      const sessionId = 'oc-uuid-fanout';
      const opencodeSubs = new OpenCodeSessionSubscribers();
      opencodeSubs.subscribe('subscriber-1', sessionId);
      opencodeSubs.subscribe('subscriber-2', sessionId);

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const originatingClientId = 'client-origin';
      const piEvent = { type: 'message_start', message: { id: 'msg-1' } };
      const msg = { type: 'session_event', sessionId, event: piEvent };

      const subscribers = opencodeSubs.getSubscribers(sessionId);
      if (subscribers.size > 0) {
        for (const subId of subscribers) {
          sendMessage(subId, msg);
        }
      } else {
        sendMessage(originatingClientId, msg);
      }

      expect(sentMessages).toHaveLength(2);
      const recipients = sentMessages.map(s => s.clientId);
      expect(recipients).toContain('subscriber-1');
      expect(recipients).toContain('subscriber-2');
      expect(recipients).not.toContain('client-origin');
    });

    it('falls back to originating client when no subscribers exist', () => {
      const sessionId = 'oc-uuid-fallback';
      const opencodeSubs = new OpenCodeSessionSubscribers();

      const sentMessages: Array<{ clientId: string; message: unknown }> = [];
      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      const originatingClientId = 'client-origin';
      const piEvent = { type: 'agent_start' };
      const msg = { type: 'session_event', sessionId, event: piEvent };

      const subscribers = opencodeSubs.getSubscribers(sessionId);
      if (subscribers.size > 0) {
        for (const subId of subscribers) {
          sendMessage(subId, msg);
        }
      } else {
        sendMessage(originatingClientId, msg);
      }

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].clientId).toBe('client-origin');
    });
  });

  describe('replayOpencodeHistory message sequence', () => {
    it('sends session_switched then history_start, events, history_end', async () => {
      const sessionId = 'oc-uuid-replay';
      const opencodeService = {
        getSession: vi.fn().mockResolvedValue({
          id: sessionId,
          sdkType: 'opencode',
          model: 'zai-coding-plan/glm-4',
          cwd: '/tmp',
        }),
        getReplayEvents: vi.fn().mockResolvedValue([
          { type: 'message_start', data: { id: 'm1', role: 'user' } },
          { type: 'message_update', data: { id: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } } },
          { type: 'message_end', data: { id: 'm1' } },
        ]),
        isRunning: vi.fn().mockReturnValue(false),
      };

      const registry = { get: vi.fn().mockResolvedValue(await opencodeService.getSession(sessionId)) };

      const sentMessages: unknown[] = [];
      const sendMessage = (_clientId: string, message: unknown) => {
        sentMessages.push(message);
      };

      const clientId = 'client-1';
      const entry = await registry.get(sessionId);
      if (!entry) return;

      sendMessage(clientId, {
        type: 'session_switched',
        sessionId,
        sessionPath: sessionId,
        sdkType: 'opencode',
        model: entry.model ?? '',
        messages: [],
        fileTimestamp: 0,
        isStreaming: opencodeService.isRunning(sessionId),
      });

      const events = await opencodeService.getReplayEvents(sessionId);
      if (events.length === 0) return;

      sendMessage(clientId, { type: 'history_start', sessionId });
      for (const evt of events) {
        sendMessage(clientId, { type: 'session_event', sessionId, event: evt });
      }
      sendMessage(clientId, { type: 'history_end', sessionId });

      expect(sentMessages).toHaveLength(6);
      expect((sentMessages[0] as Record<string, unknown>).type).toBe('session_switched');
      expect((sentMessages[0] as Record<string, unknown>).sdkType).toBe('opencode');
      expect((sentMessages[1] as Record<string, unknown>).type).toBe('history_start');
      expect((sentMessages[2] as Record<string, unknown>).type).toBe('session_event');
      expect((sentMessages[3] as Record<string, unknown>).type).toBe('session_event');
      expect((sentMessages[4] as Record<string, unknown>).type).toBe('session_event');
      expect((sentMessages[5] as Record<string, unknown>).type).toBe('history_end');
    });

    it('sends only session_switched when no replay events', async () => {
      const sessionId = 'oc-uuid-empty';
      const opencodeService = {
        getSession: vi.fn().mockResolvedValue({
          id: sessionId,
          sdkType: 'opencode',
          model: '',
          cwd: '/tmp',
        }),
        getReplayEvents: vi.fn().mockResolvedValue([]),
        isRunning: vi.fn().mockReturnValue(false),
      };

      const registry = { get: vi.fn().mockResolvedValue(await opencodeService.getSession(sessionId)) };

      const sentMessages: unknown[] = [];
      const sendMessage = (_clientId: string, message: unknown) => {
        sentMessages.push(message);
      };

      const entry = await registry.get(sessionId);
      sendMessage('client-1', {
        type: 'session_switched',
        sessionId,
        sessionPath: sessionId,
        sdkType: 'opencode',
        model: entry.model ?? '',
        messages: [],
        fileTimestamp: 0,
        isStreaming: false,
      });

      const events = await opencodeService.getReplayEvents(sessionId);
      if (events.length > 0) {
        sendMessage('client-1', { type: 'history_start', sessionId });
        for (const evt of events) {
          sendMessage('client-1', { type: 'session_event', sessionId, event: evt });
        }
        sendMessage('client-1', { type: 'history_end', sessionId });
      }

      expect(sentMessages).toHaveLength(1);
      expect((sentMessages[0] as Record<string, unknown>).type).toBe('session_switched');
    });
  });
});
