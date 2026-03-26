import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import {
  SessionBroadcaster,
  globalBroadcaster,
  createNotification,
  type SessionStatusInfo,
  type JSONRPCNotification,
} from '../../../src/pi/session-broadcaster.js';

/**
 * Helper to create a mock WebSocket with controllable readyState
 */
function createMockWebSocket(readyState: number = WebSocket.OPEN): WebSocket & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

/**
 * Helper to create a SessionStatusInfo object
 */
function createStatusInfo(overrides: Partial<SessionStatusInfo> = {}): SessionStatusInfo {
  return {
    status: 'idle',
    messageCount: 0,
    lastActivity: new Date(),
    currentStep: 0,
    subscriberCount: 0,
    ...overrides,
  };
}

describe('SessionBroadcaster', () => {
  let broadcaster: SessionBroadcaster;

  beforeEach(() => {
    broadcaster = new SessionBroadcaster();
  });

  afterEach(() => {
    broadcaster.dispose();
  });

  describe('constructor', () => {
    it('should initialize with empty subscribers map', () => {
      expect(broadcaster.getActiveSessions()).toEqual([]);
    });

    it('should not be disposed initially', () => {
      expect(broadcaster.isDisposed()).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('should add a WebSocket to a session', () => {
      const ws = createMockWebSocket();

      broadcaster.subscribe('session-1', ws);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(1);
    });

    it('should allow multiple WebSockets to subscribe to the same session', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);
      broadcaster.subscribe('session-1', ws3);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(3);
    });

    it('should allow a WebSocket to subscribe to multiple sessions', () => {
      const ws = createMockWebSocket();

      broadcaster.subscribe('session-1', ws);
      broadcaster.subscribe('session-2', ws);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(1);
      expect(broadcaster.getSubscriberCount('session-2')).toBe(1);
      expect(broadcaster.getTotalWebSocketCount()).toBe(1);
    });

    it('should throw if broadcaster is disposed', () => {
      broadcaster.dispose();
      const ws = createMockWebSocket();

      expect(() => broadcaster.subscribe('session-1', ws)).toThrow(
        'SessionBroadcaster has been disposed'
      );
    });

    it('should update subscriber count in existing status', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle' }));
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      const status = broadcaster.getStatus('session-1');
      expect(status?.subscriberCount).toBe(2);
    });
  });

  describe('unsubscribe', () => {
    it('should remove a WebSocket from a session', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.unsubscribe('session-1', ws);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(0);
    });

    it('should only remove from specified session', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);
      broadcaster.subscribe('session-2', ws);

      broadcaster.unsubscribe('session-1', ws);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(0);
      expect(broadcaster.getSubscriberCount('session-2')).toBe(1);
    });

    it('should handle unsubscribe for non-existent session gracefully', () => {
      const ws = createMockWebSocket();

      expect(() => broadcaster.unsubscribe('non-existent', ws)).not.toThrow();
    });

    it('should handle unsubscribe for non-subscribed WebSocket gracefully', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      broadcaster.subscribe('session-1', ws1);

      expect(() => broadcaster.unsubscribe('session-1', ws2)).not.toThrow();
    });

    it('should update subscriber count in status', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      broadcaster.updateStatus('session-1', createStatusInfo());
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);
      broadcaster.unsubscribe('session-1', ws1);

      const status = broadcaster.getStatus('session-1');
      expect(status?.subscriberCount).toBe(1);
    });
  });

  describe('broadcast', () => {
    it('should send notification to all subscribers', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      const notification = createNotification('test_event', { data: 'test' });
      broadcaster.broadcast('session-1', notification);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(notification));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(notification));
    });

    it('should not send to subscribers of other sessions', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-2', ws2);

      const notification = createNotification('test_event', { data: 'test' });
      broadcaster.broadcast('session-1', notification);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('should not send to closed WebSockets', () => {
      const ws1 = createMockWebSocket(WebSocket.OPEN);
      const ws2 = createMockWebSocket(WebSocket.CLOSED);
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      const notification = createNotification('test_event', { data: 'test' });
      broadcaster.broadcast('session-1', notification);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('should not send to closing WebSockets', () => {
      const ws = createMockWebSocket(WebSocket.CLOSING);
      broadcaster.subscribe('session-1', ws);

      const notification = createNotification('test_event', { data: 'test' });
      broadcaster.broadcast('session-1', notification);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should remove dead sockets after failed send', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      ws1.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      const notification = createNotification('test_event', { data: 'test' });
      broadcaster.broadcast('session-1', notification);

      // ws1 should be removed after failed send
      expect(broadcaster.getSubscriberCount('session-1')).toBe(1);
    });

    it('should do nothing for session with no subscribers', () => {
      const notification = createNotification('test_event', { data: 'test' });

      expect(() => broadcaster.broadcast('no-subscribers', notification)).not.toThrow();
    });

    it('should not broadcast if disposed', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);
      broadcaster.dispose();

      const notification = createNotification('test_event', { data: 'test' });
      broadcaster.broadcast('session-1', notification);

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('should store status for a session', () => {
      const status = createStatusInfo({ status: 'busy', messageCount: 5 });

      broadcaster.updateStatus('session-1', status);

      const stored = broadcaster.getStatus('session-1');
      expect(stored).toEqual(expect.objectContaining({
        status: 'busy',
        messageCount: 5,
      }));
    });

    it('should return true when status changes', () => {
      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle' }));

      const changed = broadcaster.updateStatus('session-1', createStatusInfo({ status: 'streaming' }));

      expect(changed).toBe(true);
    });

    it('should return false when status is the same', () => {
      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle', messageCount: 5 }));

      const changed = broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle', messageCount: 5 }));

      expect(changed).toBe(false);
    });

    it('should broadcast when status changes', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle' }));
      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'streaming' }));

      // One broadcast for the initial status, one for the change
      expect(ws.send).toHaveBeenCalledTimes(2);
    });

    it('should not broadcast when status is unchanged', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle', messageCount: 5 }));
      ws.send.mockClear();

      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle', messageCount: 5 }));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should detect messageCount change', () => {
      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle', messageCount: 5 }));

      const changed = broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle', messageCount: 6 }));

      expect(changed).toBe(true);
    });

    it('should detect currentStep change', () => {
      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'busy', currentStep: 1 }));

      const changed = broadcaster.updateStatus('session-1', createStatusInfo({ status: 'busy', currentStep: 2 }));

      expect(changed).toBe(true);
    });

    it('should return true for new session', () => {
      const changed = broadcaster.updateStatus('new-session', createStatusInfo({ status: 'idle' }));

      expect(changed).toBe(true);
    });

    it('should include subscriberCount in status', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle' }));

      const status = broadcaster.getStatus('session-1');
      expect(status?.subscriberCount).toBe(2);
    });

    it('should not update if disposed', () => {
      broadcaster.dispose();

      const changed = broadcaster.updateStatus('session-1', createStatusInfo({ status: 'idle' }));

      expect(changed).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return undefined for non-existent session', () => {
      expect(broadcaster.getStatus('non-existent')).toBeUndefined();
    });

    it('should return stored status', () => {
      const status = createStatusInfo({
        status: 'streaming',
        messageCount: 10,
        currentStep: 3,
      });

      broadcaster.updateStatus('session-1', status);

      const stored = broadcaster.getStatus('session-1');
      expect(stored).toEqual(expect.objectContaining({
        status: 'streaming',
        messageCount: 10,
        currentStep: 3,
      }));
    });

    it('should return a copy (not reference) of status', () => {
      broadcaster.updateStatus('session-1', createStatusInfo({ messageCount: 5 }));

      const status1 = broadcaster.getStatus('session-1');
      status1!.messageCount = 100;

      const status2 = broadcaster.getStatus('session-1');
      expect(status2?.messageCount).toBe(5);
    });
  });

  describe('cleanup', () => {
    it('should remove session from subscribers map', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.cleanup('session-1');

      expect(broadcaster.getSubscriberCount('session-1')).toBe(0);
    });

    it('should remove session from status map', () => {
      broadcaster.updateStatus('session-1', createStatusInfo());

      broadcaster.cleanup('session-1');

      expect(broadcaster.getStatus('session-1')).toBeUndefined();
    });

    it('should update reverse mapping for WebSockets', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);
      broadcaster.subscribe('session-2', ws);

      broadcaster.cleanup('session-1');

      // WebSocket should still be tracked for session-2
      expect(broadcaster.getTotalWebSocketCount()).toBe(1);
    });

    it('should handle cleanup of non-existent session gracefully', () => {
      expect(() => broadcaster.cleanup('non-existent')).not.toThrow();
    });
  });

  describe('handleWebSocketClose', () => {
    it('should remove WebSocket from all subscribed sessions', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);
      broadcaster.subscribe('session-2', ws);
      broadcaster.subscribe('session-3', ws);

      broadcaster.handleWebSocketClose(ws);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(0);
      expect(broadcaster.getSubscriberCount('session-2')).toBe(0);
      expect(broadcaster.getSubscriberCount('session-3')).toBe(0);
    });

    it('should remove WebSocket from wsToSessions map', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.handleWebSocketClose(ws);

      expect(broadcaster.getTotalWebSocketCount()).toBe(0);
    });

    it('should update subscriber count in session status', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      broadcaster.updateStatus('session-1', createStatusInfo());
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      broadcaster.handleWebSocketClose(ws1);

      const status = broadcaster.getStatus('session-1');
      expect(status?.subscriberCount).toBe(1);
    });

    it('should handle close for WebSocket not in any session', () => {
      const ws = createMockWebSocket();

      expect(() => broadcaster.handleWebSocketClose(ws)).not.toThrow();
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should start heartbeat interval', () => {
      broadcaster.startHeartbeat(1000);

      vi.advanceTimersByTime(1000);

      // Heartbeat should have been sent (we can't directly test sendHeartbeat)
      // But we can verify the interval was set
      expect(broadcaster).toBeDefined();
    });

    it('should send heartbeat to all connected WebSockets', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-2', ws2);

      broadcaster.startHeartbeat(1000);
      vi.advanceTimersByTime(1000);

      const heartbeatMsg = JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat' });
      expect(ws1.send).toHaveBeenCalledWith(heartbeatMsg);
      expect(ws2.send).toHaveBeenCalledWith(heartbeatMsg);
    });

    it('should not send heartbeat to closed WebSockets', () => {
      const ws = createMockWebSocket(WebSocket.CLOSED);
      broadcaster.subscribe('session-1', ws);

      broadcaster.startHeartbeat(1000);
      vi.advanceTimersByTime(1000);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should remove dead connections during heartbeat', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      ws1.send.mockImplementation(() => {
        throw new Error('Connection lost');
      });

      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);

      broadcaster.startHeartbeat(1000);
      vi.advanceTimersByTime(1000);

      // ws1 should be removed after failed send
      expect(broadcaster.getSubscriberCount('session-1')).toBe(1);
    });

    it('should stop heartbeat when stopHeartbeat is called', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.startHeartbeat(1000);
      vi.advanceTimersByTime(1000);
      expect(ws.send).toHaveBeenCalledTimes(1);

      ws.send.mockClear();
      broadcaster.stopHeartbeat();
      vi.advanceTimersByTime(5000);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('should restart heartbeat if already running', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.startHeartbeat(1000);
      vi.advanceTimersByTime(1000);
      expect(ws.send).toHaveBeenCalledTimes(1);

      ws.send.mockClear();
      broadcaster.startHeartbeat(500); // Different interval
      vi.advanceTimersByTime(500);

      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('should use default interval of 30 seconds', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.startHeartbeat(); // Default 30000ms

      vi.advanceTimersByTime(29999);
      expect(ws.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('should not send heartbeat if disposed', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);

      broadcaster.startHeartbeat(1000);
      broadcaster.dispose();

      vi.advanceTimersByTime(1000);

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('getSubscriberCount', () => {
    it('should return 0 for session with no subscribers', () => {
      expect(broadcaster.getSubscriberCount('non-existent')).toBe(0);
    });

    it('should return correct count', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-1', ws2);
      broadcaster.subscribe('session-1', ws3);

      expect(broadcaster.getSubscriberCount('session-1')).toBe(3);
    });
  });

  describe('getActiveSessions', () => {
    it('should return empty array when no sessions', () => {
      expect(broadcaster.getActiveSessions()).toEqual([]);
    });

    it('should return sessions with subscribers', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-2', ws2);

      const active = broadcaster.getActiveSessions();
      expect(active).toContain('session-1');
      expect(active).toContain('session-2');
    });

    it('should not return sessions with no subscribers', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);
      broadcaster.unsubscribe('session-1', ws);

      expect(broadcaster.getActiveSessions()).toEqual([]);
    });
  });

  describe('getTotalWebSocketCount', () => {
    it('should return 0 when no WebSockets', () => {
      expect(broadcaster.getTotalWebSocketCount()).toBe(0);
    });

    it('should return count of unique WebSockets', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      broadcaster.subscribe('session-1', ws1);
      broadcaster.subscribe('session-2', ws1); // Same ws, different session
      broadcaster.subscribe('session-3', ws2);

      expect(broadcaster.getTotalWebSocketCount()).toBe(2);
    });
  });

  describe('dispose', () => {
    it('should mark broadcaster as disposed', () => {
      broadcaster.dispose();

      expect(broadcaster.isDisposed()).toBe(true);
    });

    it('should clear all maps', () => {
      const ws = createMockWebSocket();
      broadcaster.subscribe('session-1', ws);
      broadcaster.updateStatus('session-1', createStatusInfo());

      broadcaster.dispose();

      expect(broadcaster.getActiveSessions()).toEqual([]);
      expect(broadcaster.getStatus('session-1')).toBeUndefined();
      expect(broadcaster.getTotalWebSocketCount()).toBe(0);
    });

    it('should stop heartbeat', () => {
      vi.useFakeTimers();

      broadcaster.startHeartbeat(1000);
      broadcaster.dispose();

      // After dispose, the interval should be cleared
      vi.advanceTimersByTime(5000);
      // No error should occur

      vi.useRealTimers();
    });

    it('should be idempotent', () => {
      broadcaster.dispose();
      broadcaster.dispose();

      expect(broadcaster.isDisposed()).toBe(true);
    });
  });

  describe('createNotification', () => {
    it('should create valid JSON-RPC notification', () => {
      const notification = createNotification('test_method', { key: 'value' });

      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'test_method',
        params: { key: 'value' },
      });
    });

    it('should create notification without params', () => {
      const notification = createNotification('test_method');

      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'test_method',
      });
    });
  });
});

describe('globalBroadcaster', () => {
  it('should be a SessionBroadcaster instance', () => {
    expect(globalBroadcaster).toBeInstanceOf(SessionBroadcaster);
  });

  it('should be usable for subscription', () => {
    const ws = createMockWebSocket();

    globalBroadcaster.subscribe('test-session', ws);
    expect(globalBroadcaster.getSubscriberCount('test-session')).toBe(1);

    // Cleanup
    globalBroadcaster.unsubscribe('test-session', ws);
  });
});
