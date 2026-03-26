import { describe, it, expect, beforeEach } from 'vitest';
import { RPCProtocolBridge } from '../../../src/workers/rpc-protocol-bridge.js';
import type { RPCEvent } from '../../../src/workers/types.js';

describe('RPCProtocolBridge', () => {
  let bridge: RPCProtocolBridge;

  beforeEach(() => {
    bridge = new RPCProtocolBridge();
  });

  describe('parseRPCLine', () => {
    it('should parse valid JSON lines', () => {
      const event = bridge.parseRPCLine('{"type":"message_start","id":"msg-1"}');
      expect(event).toEqual({ type: 'message_start', id: 'msg-1' });
    });

    it('should return null for empty lines', () => {
      expect(bridge.parseRPCLine('')).toBeNull();
      expect(bridge.parseRPCLine('   ')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      expect(bridge.parseRPCLine('not json')).toBeNull();
    });
  });

  describe('formatRPCCommand', () => {
    it('should format prompt commands', () => {
      const line = bridge.formatRPCCommand({ type: 'prompt', message: 'Hello' });
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe('prompt');
      expect(parsed.message).toBe('Hello');
      expect(parsed.id).toBeDefined();
    });

    it('should format abort commands', () => {
      const line = bridge.formatRPCCommand({ type: 'abort' });
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe('abort');
    });
  });

  describe('normalizeEvent', () => {
    it('should add timestamp and session ID', () => {
      const rpcEvent: RPCEvent = { type: 'message_start', id: 'msg-1', role: 'assistant' };
      const normalized = bridge.normalizeEvent(rpcEvent, 'session-123');
      expect(normalized.type).toBe('message_start');
      expect(normalized.sessionId).toBe('session-123');
      expect(normalized.timestamp).toBeGreaterThan(0);
      expect(normalized.data).toEqual(rpcEvent);
    });
  });

  describe('extension UI', () => {
    it('should detect extension UI requests', () => {
      const uiEvent: RPCEvent = { type: 'extension_ui_request', id: 'ui-1', method: 'confirm' };
      expect(bridge.isExtensionUIRequest(uiEvent)).toBe(true);
      
      const msgEvent: RPCEvent = { type: 'message_start', id: 'msg-1', role: 'assistant' };
      expect(bridge.isExtensionUIRequest(msgEvent)).toBe(false);
    });

    it('should format extension UI responses', () => {
      const line = bridge.formatExtensionUIResponse('ui-1', 'selected value');
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe('extension_ui_response');
      expect(parsed.id).toBe('ui-1');
      expect(parsed.value).toBe('selected value');
    });
  });

  describe('subscribe', () => {
    it('should subscribe to events', () => {
      const events: RPCEvent[] = [];
      bridge.subscribe((e) => events.push(e));
      
      const event = bridge.parseRPCLine('{"type":"message_start","id":"msg-1"}');
      if (event) bridge['emit'](event);
      
      expect(events).toHaveLength(1);
    });
  });
});
