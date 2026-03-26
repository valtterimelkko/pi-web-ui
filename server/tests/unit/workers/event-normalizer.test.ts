import { describe, it, expect, beforeEach } from 'vitest';
import { EventNormalizer } from '../../../src/workers/event-normalizer.js';
import type { RPCEvent } from '../../../src/workers/types.js';

describe('EventNormalizer', () => {
  let normalizer: EventNormalizer;

  beforeEach(() => {
    normalizer = new EventNormalizer();
  });

  describe('normalize', () => {
    it('should normalize message_start events', () => {
      const event: RPCEvent = { type: 'message_start', id: 'msg-1', role: 'assistant' };
      const result = normalizer.normalize(event, 'session-1');
      
      expect(result.type).toBe('message_start');
      expect(result.sessionId).toBe('session-1');
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.data).toEqual({ id: 'msg-1', role: 'assistant' });
    });

    it('should normalize message_update events', () => {
      const event: RPCEvent = { type: 'message_update', id: 'msg-1', delta: 'Hello' };
      const result = normalizer.normalize(event);
      
      expect(result.type).toBe('message_update');
      expect(result.data).toEqual({ id: 'msg-1', delta: 'Hello' });
    });

    it('should normalize tool_execution_start events', () => {
      const event: RPCEvent = { 
        type: 'tool_execution_start', 
        id: 'tool-1', 
        name: 'read',
        input: { path: '/tmp/test.txt' }
      };
      const result = normalizer.normalize(event);
      
      expect(result.type).toBe('tool_execution_start');
      expect(result.data).toEqual({
        id: 'tool-1',
        name: 'read',
        input: { path: '/tmp/test.txt' },
      });
    });

    it('should normalize error events', () => {
      const event: RPCEvent = { type: 'error', message: 'Something went wrong' };
      const result = normalizer.normalize(event);
      
      expect(result.type).toBe('error');
      expect(result.data).toEqual({ message: 'Something went wrong' });
    });

    it('should preserve unknown event types', () => {
      const event: RPCEvent = { type: 'custom_event', custom: 'data' } as any;
      const result = normalizer.normalize(event);
      
      expect(result.type).toBe('custom_event');
      expect((result.data as any).custom).toBe('data');
    });
  });

  describe('shouldFilter', () => {
    it('should filter skill content injections', () => {
      const event: RPCEvent = { 
        type: 'message_start', 
        id: 'msg-1',
        content: '<skill name="test">content</skill>'
      } as any;
      
      expect(normalizer.shouldFilter(event)).toBe(true);
    });

    it('should not filter regular messages', () => {
      const event: RPCEvent = { type: 'message_start', id: 'msg-1', role: 'user' };
      
      expect(normalizer.shouldFilter(event)).toBe(false);
    });
  });

  describe('isExtensionUIRequest', () => {
    it('should detect extension UI requests', () => {
      const event: RPCEvent = { type: 'extension_ui_request', id: 'ui-1', method: 'confirm' };
      expect(normalizer.isExtensionUIRequest(event)).toBe(true);
    });

    it('should not detect other events', () => {
      const event: RPCEvent = { type: 'message_start', id: 'msg-1', role: 'assistant' };
      expect(normalizer.isExtensionUIRequest(event)).toBe(false);
    });
  });

  describe('isStreamingEvent', () => {
    it('should detect streaming_started', () => {
      const event: RPCEvent = { type: 'streaming_started' };
      expect(normalizer.isStreamingEvent(event)).toBe(true);
    });

    it('should detect streaming_ended', () => {
      const event: RPCEvent = { type: 'streaming_ended' };
      expect(normalizer.isStreamingEvent(event)).toBe(true);
    });

    it('should not detect other events', () => {
      const event: RPCEvent = { type: 'message_start', id: 'msg-1', role: 'assistant' };
      expect(normalizer.isStreamingEvent(event)).toBe(false);
    });
  });

  describe('isErrorEvent', () => {
    it('should detect error events', () => {
      const event: RPCEvent = { type: 'error', message: 'Error' };
      expect(normalizer.isErrorEvent(event)).toBe(true);
    });
  });
});
