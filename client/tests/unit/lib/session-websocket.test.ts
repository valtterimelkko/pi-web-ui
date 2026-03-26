import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionWebSocket, isIdentityValid, createIdentityGuard } from '../../../src/lib/session-websocket';
import type { JSONRPCRequest, JSONRPCNotification } from '../../../src/lib/jsonrpc-client';

// Mock WebSocket with full addEventListener support
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;

  private eventListeners: Map<string, Set<EventListener>> = new Map();

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  sentMessages: string[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    this.eventListeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  private dispatchEvent(event: Event | CloseEvent | MessageEvent): void {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      listeners.forEach((listener) => listener(event as Event));
    }
    if (event.type === 'open' && this.onopen) this.onopen(event as Event);
    if (event.type === 'close' && this.onclose) this.onclose(event as CloseEvent);
    if (event.type === 'error' && this.onerror) this.onerror(event as Event);
    if (event.type === 'message' && this.onmessage) this.onmessage(event as MessageEvent);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? '';
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: this.closeCode, reason: this.closeReason }));
  }

  // Test helpers
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateError(): void {
    this.dispatchEvent(new Event('error'));
  }

  simulateClose(code: number = 1000, reason: string = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  getLastMessage(): unknown {
    const last = this.sentMessages[this.sentMessages.length - 1];
    return last ? JSON.parse(last) : null;
  }

  clearMessages(): void {
    this.sentMessages = [];
  }
}

// Store original WebSocket
const OriginalWebSocket = global.WebSocket;

describe('useSessionWebSocket', () => {
  let mockWsInstances: MockWebSocket[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstances = [];

    // Mock WebSocket that stores instances for testing
    global.WebSocket = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        mockWsInstances.push(this);
        // Simulate async connection
        setTimeout(() => {
          if (this.readyState === MockWebSocket.CONNECTING) {
            this.open();
          }
        }, 0);
      }
    } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    global.WebSocket = OriginalWebSocket;
    mockWsInstances = [];
  });

  describe('basic hook behavior', () => {
    it('should initialize with disconnected state when no sessionId', () => {
      const { result } = renderHook(() => useSessionWebSocket(null));

      expect(result.current.isConnected).toBe(false);
      expect(result.current.connectionState).toBe('disconnected');
      expect(result.current.client).toBeNull();
    });

    it('should start connecting when sessionId is provided', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', { autoConnect: true })
      );

      // Should immediately start connecting
      expect(result.current.connectionState).toBe('connecting');

      // Let WebSocket open
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.connectionState).toBe('connected');
    });

    it('should not auto-connect when autoConnect is false', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', { autoConnect: false })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.connectionState).toBe('disconnected');
    });

    it('should generate unique identity on connect', async () => {
      const { result } = renderHook(() => useSessionWebSocket('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.identity).toBeDefined();
      expect(result.current.identity).not.toBe('');
      expect(result.current.identity).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    });

    it('should disconnect when sessionId becomes null', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionWebSocket(sessionId),
        { initialProps: { sessionId: 'session-123' as string | null } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);

      // Switch to null session
      await act(async () => {
        rerender({ sessionId: null });
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.connectionState).toBe('disconnected');
    });
  });

  describe('identity guard pattern', () => {
    it('should change identity on session switch', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionWebSocket(sessionId),
        { initialProps: { sessionId: 'session-123' as string | null } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const firstIdentity = result.current.identity;
      expect(firstIdentity).toBeDefined();

      // Switch session
      await act(async () => {
        rerender({ sessionId: 'session-456' });
        await vi.runAllTimersAsync();
      });

      const secondIdentity = result.current.identity;
      expect(secondIdentity).toBeDefined();
      expect(secondIdentity).not.toBe(firstIdentity);
    });

    it('should generate new identity for each session', async () => {
      const identities: string[] = [];

      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionWebSocket(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      identities.push(result.current.identity);

      for (let i = 2; i <= 3; i++) {
        await act(async () => {
          rerender({ sessionId: `session-${i}` });
          await vi.runAllTimersAsync();
        });
        identities.push(result.current.identity);
      }

      // All identities should be unique
      const uniqueIdentities = new Set(identities);
      expect(uniqueIdentities.size).toBe(identities.length);
    });
  });

  describe('connection lifecycle', () => {
    it('should connect manually via connect()', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', { autoConnect: false })
      );

      expect(result.current.connectionState).toBe('disconnected');

      await act(async () => {
        await result.current.connect();
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);
    });

    it('should disconnect manually via disconnect()', async () => {
      const { result } = renderHook(() => useSessionWebSocket('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.connectionState).toBe('disconnected');
    });

    it('should reconnect via reconnect()', async () => {
      const onConnectionStateChange = vi.fn();

      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', {
          onConnectionStateChange,
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);

      const originalIdentity = result.current.identity;

      onConnectionStateChange.mockClear();

      await act(async () => {
        await result.current.reconnect();
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);
      // Should have new identity after reconnect
      expect(result.current.identity).not.toBe(originalIdentity);
    });
  });

  describe('atomic teardown', () => {
    it('should handle rapid session switches', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionWebSocket(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Rapid switches before connection completes
      for (let i = 2; i <= 5; i++) {
        await act(async () => {
          rerender({ sessionId: `session-${i}` });
          // Don't wait for connection
        });
      }

      // Now let everything settle
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should be connected to the last session
      expect(result.current.isConnected).toBe(true);
      expect(result.current.identity).toBeDefined();
    });
  });

  describe('heartbeat/watchdog', () => {
    it('should send periodic pings when connected', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', {
          heartbeatInterval: 100,
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);

      // Get the WebSocket instance
      const ws = mockWsInstances[mockWsInstances.length - 1];
      expect(ws).toBeDefined();

      // Clear any existing messages
      ws.clearMessages();

      // Advance past heartbeat interval
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      // Should have sent a ping
      const lastMessage = ws.getLastMessage();
      expect(lastMessage).toMatchObject({
        jsonrpc: '2.0',
        method: 'ping',
      });
    });

    it('should handle pong responses', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', {
          heartbeatInterval: 100,
          heartbeatTimeout: 500,
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Connection should remain connected
      expect(result.current.isConnected).toBe(true);

      // Advance past several heartbeat intervals
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // Still connected
      expect(result.current.isConnected).toBe(true);
    });
  });

  describe('reconnection with backoff', () => {
    it('should attempt reconnection on unexpected connection close', async () => {
      const onConnectionStateChange = vi.fn();

      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', {
          onConnectionStateChange,
          reconnectDelay: 50,
          maxReconnectAttempts: 3,
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);

      // Clear previous calls
      onConnectionStateChange.mockClear();

      // Simulate unexpected close
      const ws = mockWsInstances[mockWsInstances.length - 1];
      act(() => {
        ws.simulateClose(1006, 'Abnormal closure');
      });

      // Advance to trigger reconnection
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should have triggered reconnecting state
      expect(onConnectionStateChange).toHaveBeenCalledWith('reconnecting');
    });

    it('should stop after max reconnect attempts', async () => {
      const onError = vi.fn();

      // Override WebSocket to always close
      let attemptCount = 0;
      global.WebSocket = class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWsInstances.push(this);
          attemptCount++;
          // Close immediately after opening
          setTimeout(() => {
            this.open();
            setTimeout(() => {
              this.simulateClose(1006, 'Connection failed');
            }, 5);
          }, 0);
        }
      } as unknown as typeof WebSocket;

      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', {
          onError,
          reconnectDelay: 10,
          maxReconnectAttempts: 2,
        })
      );

      // Advance through multiple reconnection attempts
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // Should have stopped trying and be disconnected
      expect(result.current.connectionState).toBe('disconnected');

      global.WebSocket = OriginalWebSocket;
    });
  });

  describe('notification handling', () => {
    it('should be connected and have client available', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123')
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.client).not.toBeNull();
    });
  });

  describe('error handling', () => {
    it('should handle missing session gracefully', () => {
      const { result } = renderHook(() => useSessionWebSocket(null));

      expect(result.current.isConnected).toBe(false);
      expect(result.current.client).toBeNull();
    });

    it('should call onError on connection failure', async () => {
      const onError = vi.fn();

      // Override WebSocket to fail
      global.WebSocket = class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWsInstances.push(this);
          // Trigger error instead of opening
          setTimeout(() => {
            this.simulateError();
            this.simulateClose(1006, 'Connection failed');
          }, 0);
        }
      } as unknown as typeof WebSocket;

      renderHook(() =>
        useSessionWebSocket('session-123', {
          onError,
          reconnectDelay: 10,
          maxReconnectAttempts: 1,
        })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // Should have called onError at some point
      expect(onError).toHaveBeenCalled();

      global.WebSocket = OriginalWebSocket;
    });
  });

  describe('browser tab visibility', () => {
    it('should handle visibility change events', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', {
          heartbeatInterval: 100,
          heartbeatTimeout: 1000,
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isConnected).toBe(true);

      // Simulate tab hidden then visible
      await act(async () => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'hidden',
          writable: true,
          configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));

        await vi.advanceTimersByTimeAsync(100);

        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
          configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));

        await vi.advanceTimersByTimeAsync(100);
      });

      // Connection should still be active
      expect(result.current.isConnected).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle multiple connect/disconnect cycles', async () => {
      const { result } = renderHook(() => useSessionWebSocket('session-123'));

      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await vi.runAllTimersAsync();
        });

        expect(result.current.isConnected).toBe(true);

        act(() => {
          result.current.disconnect();
        });

        expect(result.current.isConnected).toBe(false);

        await act(async () => {
          await result.current.connect();
        });
      }
    });

    it('should handle connect called multiple times', async () => {
      const { result } = renderHook(() =>
        useSessionWebSocket('session-123', { autoConnect: false })
      );

      // Call connect multiple times rapidly
      const connectPromises = [
        result.current.connect(),
        result.current.connect(),
        result.current.connect(),
      ];

      await act(async () => {
        await Promise.all(connectPromises);
        await vi.runAllTimersAsync();
      });

      // Should only be connected once
      expect(result.current.isConnected).toBe(true);
    });

    it('should maintain stable callbacks across rerenders with same sessionId', async () => {
      const onConnectionStateChange = vi.fn();

      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useSessionWebSocket(sessionId, {
            onConnectionStateChange,
          }),
        { initialProps: { sessionId: 'session-123' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      onConnectionStateChange.mockClear();

      // Rerender with same sessionId
      await act(async () => {
        rerender({ sessionId: 'session-123' });
        await vi.runAllTimersAsync();
      });

      // Should not trigger reconnection (no additional state changes)
      // May have one call from initial connect, but should not have reconnecting
      const states = onConnectionStateChange.mock.calls.map(call => call[0]);
      expect(states).not.toContain('reconnecting');
    });
  });
});

describe('isIdentityValid', () => {
  it('should return true for matching identities', () => {
    expect(isIdentityValid('identity-123', 'identity-123')).toBe(true);
  });

  it('should return false for different identities', () => {
    expect(isIdentityValid('identity-123', 'identity-456')).toBe(false);
  });

  it('should return false for empty current identity', () => {
    expect(isIdentityValid('', 'identity-123')).toBe(false);
  });

  it('should return false for empty expected identity', () => {
    expect(isIdentityValid('identity-123', '')).toBe(false);
  });

  it('should return false for both empty', () => {
    expect(isIdentityValid('', '')).toBe(false);
  });
});

describe('createIdentityGuard', () => {
  it('should create a guard function', () => {
    const identityRef = { current: 'identity-123' };
    const guard = createIdentityGuard(identityRef as React.MutableRefObject<string>);

    expect(typeof guard).toBe('function');
  });

  it('should wrap callback with identity check', () => {
    const identityRef = { current: 'identity-123' };
    const guard = createIdentityGuard(identityRef as React.MutableRefObject<string>);

    const callback = vi.fn();
    const wrappedCallback = guard(callback);

    wrappedCallback('result');
    expect(callback).toHaveBeenCalledWith('result');
  });

  it('should skip callback if identity changed', () => {
    const identityRef = { current: 'identity-123' };
    const guard = createIdentityGuard(identityRef as React.MutableRefObject<string>);

    const callback = vi.fn();
    const wrappedCallback = guard(callback);

    // Change identity after creating guard
    identityRef.current = 'identity-456';

    wrappedCallback('result');
    expect(callback).not.toHaveBeenCalled();
  });

  it('should skip callback if identity is empty', () => {
    const identityRef = { current: 'identity-123' };
    const guard = createIdentityGuard(identityRef as React.MutableRefObject<string>);

    const callback = vi.fn();
    const wrappedCallback = guard(callback);

    // Clear identity
    identityRef.current = '';

    wrappedCallback('result');
    expect(callback).not.toHaveBeenCalled();
  });

  it('should create independent guards for different callbacks', () => {
    const identityRef = { current: 'identity-123' };
    const guard = createIdentityGuard(identityRef as React.MutableRefObject<string>);

    const callback1 = vi.fn();
    const callback2 = vi.fn();

    const wrapped1 = guard(callback1);
    const wrapped2 = guard(callback2);

    wrapped1('result1');
    wrapped2('result2');

    expect(callback1).toHaveBeenCalledWith('result1');
    expect(callback2).toHaveBeenCalledWith('result2');
  });

  it('should work in realistic async scenario', async () => {
    const identityRef = { current: 'identity-123' };
    const guard = createIdentityGuard(identityRef as React.MutableRefObject<string>);

    const results: string[] = [];

    // Simulate async operation
    const asyncOp = (id: string, delay: number): Promise<void> => {
      return new Promise((resolve) => {
        setTimeout(() => {
          guard((result: string) => {
            results.push(result);
          })(id);
          resolve();
        }, delay);
      });
    };

    // Start two async operations
    const op1 = asyncOp('first', 50);
    identityRef.current = 'identity-456'; // Identity changes
    const op2 = asyncOp('second', 100);

    await Promise.all([op1, op2]);

    // First callback should be skipped (identity changed)
    // Second callback should run (identity still matches)
    expect(results).toEqual(['second']);
  });
});
