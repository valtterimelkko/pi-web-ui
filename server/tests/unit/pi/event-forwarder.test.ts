/**
 * Tests for EventForwarder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventForwarder, type ForwardedEvent, type PiEvent } from '../../../src/pi/event-forwarder.js';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { JSONRPCNotification } from '@pi-web-ui/shared';

describe('EventForwarder', () => {
  let forwarder: EventForwarder;
  let mockSender: ReturnType<typeof vi.fn>;
  let sentMessages: unknown[];

  beforeEach(() => {
    sentMessages = [];
    mockSender = vi.fn((clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message });
    });
    forwarder = new EventForwarder(mockSender);
  });

  describe('constructor', () => {
    it('should create an instance with a WebSocket sender', () => {
      expect(forwarder).toBeInstanceOf(EventForwarder);
    });
  });

  describe('forwardEvent', () => {
    it('should forward agent_start event', () => {
      const event: AgentSessionEvent = { type: 'agent_start' };
      forwarder.forwardEvent('client-1', event);

      expect(mockSender).toHaveBeenCalledTimes(1);
      expect(mockSender).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'agent_start',
        timestamp: expect.any(Number),
      }));
    });

    it('should forward agent_end event with messages', () => {
      const event: AgentSessionEvent = {
        type: 'agent_end',
        messages: [],
      };
      forwarder.forwardEvent('client-1', event);

      expect(mockSender).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'agent_end',
        messages: [],
      }));
    });

    it('should wrap event in session envelope when sessionId provided', () => {
      const event: AgentSessionEvent = { type: 'agent_start' };
      forwarder.forwardEvent('client-1', event, 'session-123');

      expect(mockSender).toHaveBeenCalledWith('client-1', {
        type: 'session_event',
        sessionId: 'session-123',
        event: expect.objectContaining({
          type: 'agent_start',
        }),
      });
    });

    it('should forward tool_execution_start event', () => {
      const event: AgentSessionEvent = {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: '/test/file.ts' },
      };
      forwarder.forwardEvent('client-1', event);

      expect(mockSender).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: '/test/file.ts' },
      }));
    });

    it('should forward message_start event with generated ID', () => {
      const event: AgentSessionEvent = {
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      };
      forwarder.forwardEvent('client-1', event);

      const call = mockSender.mock.calls[0];
      const payload = call[1] as ForwardedEvent;
      expect(payload.type).toBe('message_start');
      expect(payload.message).toHaveProperty('id');
      expect((payload.message as { id: string }).id).toMatch(/^msg_/);
    });
  });

  describe('JSON-RPC Envelope Wrapping', () => {
    describe('forwardEventAsJSONRPC', () => {
      it('should wrap event as JSON-RPC notification', () => {
        const event: AgentSessionEvent = { type: 'agent_start' };
        forwarder.forwardEventAsJSONRPC('client-1', event);

        expect(mockSender).toHaveBeenCalledWith('client-1', expect.objectContaining({
          jsonrpc: '2.0',
          method: 'agentStart',
          params: expect.objectContaining({
            type: 'agent_start',
          }),
        }));
      });

      it('should wrap tool_execution_start with correct method name', () => {
        const event: AgentSessionEvent = {
          type: 'tool_execution_start',
          toolCallId: 'tool-1',
          toolName: 'read',
          args: {},
        };
        forwarder.forwardEventAsJSONRPC('client-1', event);

        expect(mockSender).toHaveBeenCalledWith('client-1', expect.objectContaining({
          jsonrpc: '2.0',
          method: 'toolExecutionStart',
        }));
      });

      it('should wrap event in session envelope when sessionId provided', () => {
        const event: AgentSessionEvent = { type: 'agent_start' };
        forwarder.forwardEventAsJSONRPC('client-1', event, 'session-456');

        expect(mockSender).toHaveBeenCalledWith('client-1', {
          type: 'session_event',
          sessionId: 'session-456',
          event: expect.objectContaining({
            jsonrpc: '2.0',
            method: 'agentStart',
          }),
        });
      });

      it('should not send filtered messages', () => {
        // Skill content should be filtered/transformed
        const event: AgentSessionEvent = {
          type: 'message_start',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<skill name="test-skill">content</skill>' }],
          },
        };
        forwarder.forwardEventAsJSONRPC('client-1', event);

        // Should still send but with transformed content
        expect(mockSender).toHaveBeenCalled();
        const call = mockSender.mock.calls[0];
        const notification = call[1] as JSONRPCNotification;
        expect(notification.jsonrpc).toBe('2.0');
      });
    });

    describe('mapEventToMethod', () => {
      it('should map content_part to contentPart', () => {
        const event: AgentSessionEvent = { type: 'message_start', message: { role: 'assistant', content: [] } };
        forwarder.forwardEventAsJSONRPC('client-1', event);

        const call = mockSender.mock.calls[0];
        const notification = call[1] as JSONRPCNotification;
        expect(notification.method).toBe('messageStart');
      });

      it('should map tool_execution_end to toolExecutionEnd', () => {
        const event: AgentSessionEvent = {
          type: 'tool_execution_end',
          toolCallId: 'tool-1',
          toolName: 'read',
          result: { content: [] },
          isError: false,
        };
        forwarder.forwardEventAsJSONRPC('client-1', event);

        const call = mockSender.mock.calls[0];
        const notification = call[1] as JSONRPCNotification;
        expect(notification.method).toBe('toolExecutionEnd');
      });

      it('should fallback to original event type for unknown types', () => {
        // Unknown event types fall back to the original type
        const event = { type: 'custom_event', customData: 'test' } as AgentSessionEvent;
        forwarder.forwardEventAsJSONRPC('client-1', event);

        const call = mockSender.mock.calls[0];
        const notification = call[1] as JSONRPCNotification;
        expect(notification.method).toBe('custom_event');
      });
    });
  });

  describe('Request ID Tracking', () => {
    describe('setRequestCorrelation', () => {
      it('should set correlation between event ID and request ID', () => {
        forwarder.setRequestCorrelation('event-1', 'request-123');
        expect(forwarder.getRequestId('event-1')).toBe('request-123');
      });

      it('should allow overwriting existing correlation', () => {
        forwarder.setRequestCorrelation('event-1', 'request-123');
        forwarder.setRequestCorrelation('event-1', 'request-456');
        expect(forwarder.getRequestId('event-1')).toBe('request-456');
      });
    });

    describe('getRequestId', () => {
      it('should return undefined for unknown event ID', () => {
        expect(forwarder.getRequestId('unknown-event')).toBeUndefined();
      });

      it('should return the correlated request ID', () => {
        forwarder.setRequestCorrelation('event-2', 'request-789');
        expect(forwarder.getRequestId('event-2')).toBe('request-789');
      });
    });

    describe('clearRequestCorrelation', () => {
      it('should clear correlation for an event ID', () => {
        forwarder.setRequestCorrelation('event-1', 'request-123');
        forwarder.clearRequestCorrelation('event-1');
        expect(forwarder.getRequestId('event-1')).toBeUndefined();
      });

      it('should be idempotent for unknown event IDs', () => {
        forwarder.clearRequestCorrelation('unknown-event');
        // Should not throw
      });
    });
  });

  describe('Event Buffering for Replay', () => {
    describe('startReplayBuffering', () => {
      it('should start buffering mode', () => {
        expect(forwarder.isInReplayMode()).toBe(false);
        forwarder.startReplayBuffering();
        expect(forwarder.isInReplayMode()).toBe(true);
      });

      it('should clear existing buffer when starting', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEvent('client-1', { type: 'agent_start' });
        expect(forwarder.getReplayBuffer()).toHaveLength(1);

        forwarder.startReplayBuffering();
        expect(forwarder.getReplayBuffer()).toHaveLength(0);
      });
    });

    describe('flushReplayBuffer', () => {
      it('should return buffered events and stop buffering', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEvent('client-1', { type: 'agent_start' });
        forwarder.forwardEvent('client-1', { type: 'agent_end', messages: [] });

        const events = forwarder.flushReplayBuffer();

        expect(events).toHaveLength(2);
        expect(events[0].type).toBe('agent_start');
        expect(events[1].type).toBe('agent_end');
        expect(forwarder.isInReplayMode()).toBe(false);
        expect(forwarder.getReplayBuffer()).toHaveLength(0);
      });

      it('should return empty array when no events buffered', () => {
        forwarder.startReplayBuffering();
        const events = forwarder.flushReplayBuffer();
        expect(events).toHaveLength(0);
      });
    });

    describe('getReplayBuffer', () => {
      it('should return copy of buffer without clearing', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEvent('client-1', { type: 'agent_start' });

        const buffer1 = forwarder.getReplayBuffer();
        const buffer2 = forwarder.getReplayBuffer();

        expect(buffer1).toHaveLength(1);
        expect(buffer2).toHaveLength(1);
        expect(forwarder.isInReplayMode()).toBe(true);
      });
    });

    describe('isInReplayMode', () => {
      it('should return false initially', () => {
        expect(forwarder.isInReplayMode()).toBe(false);
      });

      it('should return true after startReplayBuffering', () => {
        forwarder.startReplayBuffering();
        expect(forwarder.isInReplayMode()).toBe(true);
      });

      it('should return false after flushReplayBuffer', () => {
        forwarder.startReplayBuffering();
        forwarder.flushReplayBuffer();
        expect(forwarder.isInReplayMode()).toBe(false);
      });

      it('should return false after stopReplayBuffering', () => {
        forwarder.startReplayBuffering();
        forwarder.stopReplayBuffering();
        expect(forwarder.isInReplayMode()).toBe(false);
      });
    });

    describe('stopReplayBuffering', () => {
      it('should stop buffering and clear buffer', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEvent('client-1', { type: 'agent_start' });
        forwarder.stopReplayBuffering();

        expect(forwarder.isInReplayMode()).toBe(false);
        expect(forwarder.getReplayBuffer()).toHaveLength(0);
      });
    });

    describe('buffering behavior', () => {
      it('should buffer events during replay mode', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEvent('client-1', { type: 'agent_start' });
        forwarder.forwardEvent('client-1', { type: 'agent_end', messages: [] });

        const buffer = forwarder.getReplayBuffer();
        expect(buffer).toHaveLength(2);
      });

      it('should not buffer events when not in replay mode', () => {
        // Not in replay mode
        forwarder.forwardEvent('client-1', { type: 'agent_start' });

        const buffer = forwarder.getReplayBuffer();
        expect(buffer).toHaveLength(0);
      });

      it('should buffer events from forwardEventAsJSONRPC', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEventAsJSONRPC('client-1', { type: 'agent_start' });

        const buffer = forwarder.getReplayBuffer();
        expect(buffer).toHaveLength(1);
      });

      it('should preserve event structure in buffer', () => {
        forwarder.startReplayBuffering();
        forwarder.forwardEvent('client-1', {
          type: 'tool_execution_start',
          toolCallId: 'tool-1',
          toolName: 'read',
          args: { path: '/test.ts' },
        });

        const buffer = forwarder.getReplayBuffer();
        expect(buffer[0]).toMatchObject({
          type: 'tool_execution_start',
          toolCallId: 'tool-1',
          toolName: 'read',
          args: { path: '/test.ts' },
        });
      });
    });
  });

  describe('createHandler', () => {
    it('should create a handler that forwards events', () => {
      const handler = forwarder.createHandler('client-1');
      const event: AgentSessionEvent = { type: 'agent_start' };

      handler(event);

      expect(mockSender).toHaveBeenCalledWith('client-1', expect.objectContaining({
        type: 'agent_start',
      }));
    });

    it('should create a handler with session ID', () => {
      const handler = forwarder.createHandler('client-1', 'session-789');
      const event: AgentSessionEvent = { type: 'agent_start' };

      handler(event);

      expect(mockSender).toHaveBeenCalledWith('client-1', {
        type: 'session_event',
        sessionId: 'session-789',
        event: expect.objectContaining({
          type: 'agent_start',
        }),
      });
    });
  });

  describe('Skill Content Filtering', () => {
    it('should transform skill content messages', () => {
      const event: AgentSessionEvent = {
        type: 'message_start',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<skill name="test-skill">Skill content here</skill>' }],
        },
      };
      forwarder.forwardEvent('client-1', event);

      expect(mockSender).toHaveBeenCalled();
      const call = mockSender.mock.calls[0];
      const payload = call[1] as ForwardedEvent;
      expect(payload.type).toBe('message_start');
      // Content should be transformed
      const content = (payload.message as { content?: Array<{ text?: string }> }).content;
      expect(content?.[0]?.text).toContain('Skill loaded: test-skill');
    });

    it('should not transform regular messages', () => {
      const event: AgentSessionEvent = {
        type: 'message_start',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };
      forwarder.forwardEvent('client-1', event);

      const call = mockSender.mock.calls[0];
      const payload = call[1] as ForwardedEvent;
      const content = (payload.message as { content?: Array<{ text?: string }> }).content;
      expect(content?.[0]?.text).toBe('Hello world');
    });
  });
});
