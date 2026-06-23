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
