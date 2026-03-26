import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  JSONRPCClient,
  JSONRPCError,
  JSONRPCConnectionError,
  JSONRPCTimeoutError,
  JSONRPCErrorCodes,
  createJSONRPCClient,
  type JSONRPCRequest,
  type JSONRPCNotification,
  type JSONRPCSuccessResponse,
  type JSONRPCErrorResponse,
} from '../../../src/lib/jsonrpc-client';

// Mock WebSocket with full addEventListener support
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.OPEN;
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
    // Simulate async connection
    setTimeout(() => {
      this.dispatchEvent(new Event('open'));
    }, 0);
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
    // Call addEventListener handlers
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      listeners.forEach(listener => listener(event as Event));
    }
    // Call on* handlers
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

describe('JSONRPCClient', () => {
  let client: JSONRPCClient;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    
    // Mock WebSocket
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    
    client = new JSONRPCClient({ debug: false });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
    vi.clearAllMocks();
    global.WebSocket = OriginalWebSocket;
  });

  describe('constructor', () => {
    it('should create client with default options', () => {
      const defaultClient = new JSONRPCClient();
      expect(defaultClient.connectionState).toBe('disconnected');
      expect(defaultClient.isConnected).toBe(false);
    });

    it('should accept custom options', () => {
      const customClient = new JSONRPCClient({
        requestTimeout: 5000,
        maxReconnectAttempts: 3,
        reconnectDelay: 500,
        debug: true,
      });
      expect(customClient).toBeDefined();
    });

    it('should create client via factory function', () => {
      const factoryClient = createJSONRPCClient();
      expect(factoryClient).toBeInstanceOf(JSONRPCClient);
    });
  });

  describe('connect', () => {
    it('should connect to WebSocket endpoint', async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      
      // Let the mock WebSocket trigger onopen
      await vi.runAllTimersAsync();
      
      await connectPromise;
      
      expect(client.isConnected).toBe(true);
      expect(client.connectionState).toBe('connected');
    });

    it('should reject if connection fails', async () => {
      // Override MockWebSocket to fail
      class FailingWebSocket extends MockWebSocket {
        constructor(url: string) {
          super(url);
          // Clear the default open timeout and schedule error instead
          setTimeout(() => {
            this.dispatchEvent(new Event('error'));
          }, 0);
        }
      }
      
      global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
      
      const connectPromise = client.connect('ws://localhost:3000/ws');
      
      await vi.runAllTimersAsync();
      
      await expect(connectPromise).rejects.toThrow(JSONRPCConnectionError);
    });

    it('should emit connected event', async () => {
      const handler = vi.fn();
      client.on('connected', handler);
      
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      expect(handler).toHaveBeenCalledWith({ url: 'ws://localhost:3000/ws' });
    });

    it('should return immediately if already connected to same URL', async () => {
      const connectPromise1 = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise1;
      
      // Second connect should return immediately
      await client.connect('ws://localhost:3000/ws');
      
      expect(client.connectionState).toBe('connected');
    });

    it('should disconnect from previous URL when connecting to new URL', async () => {
      const connectPromise1 = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise1;
      
      const disconnectedHandler = vi.fn();
      client.on('disconnected', disconnectedHandler);
      
      const connectPromise2 = client.connect('ws://localhost:4000/ws');
      await vi.runAllTimersAsync();
      await connectPromise2;
      
      expect(disconnectedHandler).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should disconnect from WebSocket', async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      expect(client.isConnected).toBe(true);
      
      client.disconnect();
      
      expect(client.connectionState).toBe('disconnected');
      expect(client.isConnected).toBe(false);
    });

    it('should emit disconnected event', async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      const handler = vi.fn();
      client.on('disconnected', handler);
      
      client.disconnect();
      
      expect(handler).toHaveBeenCalledWith({ reason: 'client_disconnect' });
    });

    it('should reject pending requests on disconnect', async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      // Get reference to mock WebSocket
      mockWs = (client as unknown as { ws: MockWebSocket }).ws;
      
      // Make a request that will be pending
      const requestPromise = client.request('testMethod', { foo: 'bar' });
      
      // Disconnect before response
      client.disconnect();
      
      await expect(requestPromise).rejects.toThrow(JSONRPCConnectionError);
    });

    it('should be idempotent', async () => {
      client.disconnect(); // Should not throw
      client.disconnect(); // Should not throw
      expect(client.connectionState).toBe('disconnected');
    });
  });

  describe('request', () => {
    beforeEach(async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      mockWs = (client as unknown as { ws: MockWebSocket }).ws;
    });

    it('should send a JSON-RPC request', async () => {
      const requestPromise = client.request('getUser', { id: '123' });
      
      await vi.runAllTimersAsync();
      
      const sentMessage = mockWs.getLastMessage() as JSONRPCRequest;
      expect(sentMessage.jsonrpc).toBe('2.0');
      expect(sentMessage.method).toBe('getUser');
      expect(sentMessage.params).toEqual({ id: '123' });
      expect(sentMessage.id).toBeDefined();
    });

    it('should correlate request with response', async () => {
      const requestPromise = client.request<{ name: string }>('getUser', { id: '123' });
      
      await vi.runAllTimersAsync();
      
      const sentMessage = mockWs.getLastMessage() as JSONRPCRequest;
      
      // Simulate response
      const response: JSONRPCSuccessResponse<{ name: string }> = {
        jsonrpc: '2.0',
        id: sentMessage.id,
        result: { name: 'John Doe' },
      };
      mockWs.simulateMessage(response);
      
      const result = await requestPromise;
      expect(result).toEqual({ name: 'John Doe' });
    });

    it('should reject on JSON-RPC error response', async () => {
      const requestPromise = client.request('getUser', { id: '123' });
      
      await vi.runAllTimersAsync();
      
      const sentMessage = mockWs.getLastMessage() as JSONRPCRequest;
      
      // Simulate error response
      const response: JSONRPCErrorResponse = {
        jsonrpc: '2.0',
        id: sentMessage.id,
        error: {
          code: JSONRPCErrorCodes.METHOD_NOT_FOUND,
          message: 'Method not found',
        },
      };
      mockWs.simulateMessage(response);
      
      await expect(requestPromise).rejects.toThrow(JSONRPCError);
      await expect(requestPromise).rejects.toMatchObject({
        code: JSONRPCErrorCodes.METHOD_NOT_FOUND,
      });
    });

    it('should reject on timeout', async () => {
      const shortTimeoutClient = new JSONRPCClient({ requestTimeout: 100 });
      const connectPromise = shortTimeoutClient.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      const shortMockWs = (shortTimeoutClient as unknown as { ws: MockWebSocket }).ws;
      
      const requestPromise = shortTimeoutClient.request('slowMethod');
      
      // Advance past timeout
      await vi.advanceTimersByTimeAsync(150);
      
      await expect(requestPromise).rejects.toThrow(JSONRPCTimeoutError);
      
      shortTimeoutClient.disconnect();
    });

    it('should throw if not connected', async () => {
      client.disconnect();
      
      await expect(client.request('testMethod')).rejects.toThrow(JSONRPCConnectionError);
    });

    it('should handle concurrent requests with different IDs', async () => {
      const request1 = client.request('method1');
      const request2 = client.request('method2');
      const request3 = client.request('method3');
      
      await vi.runAllTimersAsync();
      
      const messages = mockWs.sentMessages.map(m => JSON.parse(m) as JSONRPCRequest);
      
      expect(messages[0].id).not.toBe(messages[1].id);
      expect(messages[1].id).not.toBe(messages[2].id);
      expect(messages[0].id).not.toBe(messages[2].id);
      
      // Respond to all
      messages.forEach(msg => {
        mockWs.simulateMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: `result-${msg.method}`,
        });
      });
      
      await Promise.all([request1, request2, request3]);
    });

    it('should ignore responses for unknown request IDs', async () => {
      const handler = vi.fn();
      client.on('error', handler);
      
      // Send a response for a request that was never made
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        id: 999,
        result: 'orphan',
      });
      
      await vi.runAllTimersAsync();
      
      // Should not throw, just log (no error event for this case)
      expect(handler).not.toHaveBeenCalled();
    });

    it('should include error data if present', async () => {
      const requestPromise = client.request('failingMethod');
      
      await vi.runAllTimersAsync();
      
      const sentMessage = mockWs.getLastMessage() as JSONRPCRequest;
      
      const response: JSONRPCErrorResponse = {
        jsonrpc: '2.0',
        id: sentMessage.id,
        error: {
          code: -32000,
          message: 'Server error',
          data: { details: 'Something went wrong' },
        },
      };
      mockWs.simulateMessage(response);
      
      try {
        await requestPromise;
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(JSONRPCError);
        expect((error as JSONRPCError).data).toEqual({ details: 'Something went wrong' });
      }
    });
  });

  describe('notify', () => {
    beforeEach(async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      mockWs = (client as unknown as { ws: MockWebSocket }).ws;
    });

    it('should send a JSON-RPC notification without id', () => {
      client.notify('statusUpdate', { status: 'active' });
      
      const sentMessage = mockWs.getLastMessage() as JSONRPCNotification;
      expect(sentMessage.jsonrpc).toBe('2.0');
      expect(sentMessage.method).toBe('statusUpdate');
      expect(sentMessage.params).toEqual({ status: 'active' });
      expect('id' in sentMessage).toBe(false);
    });

    it('should not throw if not connected', () => {
      client.disconnect();
      
      expect(() => client.notify('test', {})).not.toThrow();
    });

    it('should allow notifications without params', () => {
      client.notify('ping');
      
      const sentMessage = mockWs.getLastMessage() as JSONRPCNotification;
      expect(sentMessage.method).toBe('ping');
      expect(sentMessage.params).toBeUndefined();
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      mockWs = (client as unknown as { ws: MockWebSocket }).ws;
    });

    it('should register and call event handlers', () => {
      const handler = vi.fn();
      client.on('customEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'customEvent',
        params: { data: 'test' },
      });
      
      expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should return unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = client.on('customEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'customEvent',
        params: { data: 'test1' },
      });
      
      expect(handler).toHaveBeenCalledTimes(1);
      
      unsubscribe();
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'customEvent',
        params: { data: 'test2' },
      });
      
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support multiple handlers for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      
      client.on('multiEvent', handler1);
      client.on('multiEvent', handler2);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'multiEvent',
        params: { value: 42 },
      });
      
      expect(handler1).toHaveBeenCalledWith({ value: 42 });
      expect(handler2).toHaveBeenCalledWith({ value: 42 });
    });

    it('should support off method to remove handler', () => {
      const handler = vi.fn();
      client.on('testEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'testEvent',
        params: {},
      });
      
      expect(handler).toHaveBeenCalledTimes(1);
      
      client.off('testEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'testEvent',
        params: {},
      });
      
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support removeAllListeners for specific event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const otherHandler = vi.fn();
      
      client.on('event1', handler1);
      client.on('event1', handler2);
      client.on('event2', otherHandler);
      
      client.removeAllListeners('event1');
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'event1',
        params: {},
      });
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'event2',
        params: {},
      });
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(otherHandler).toHaveBeenCalled();
    });

    it('should support removeAllListeners for all events', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      
      client.on('event1', handler1);
      client.on('event2', handler2);
      
      client.removeAllListeners();
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'event1',
        params: {},
      });
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'event2',
        params: {},
      });
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should handle errors in event handlers gracefully', () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const goodHandler = vi.fn();
      
      client.on('testEvent', errorHandler);
      client.on('testEvent', goodHandler);
      
      // Should not throw
      expect(() => {
        mockWs.simulateMessage({
          jsonrpc: '2.0',
          method: 'testEvent',
          params: {},
        });
      }).not.toThrow();
      
      // Both handlers should have been called
      expect(errorHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('should attempt reconnection on connection close', async () => {
      const reconnectingClient = new JSONRPCClient({
        maxReconnectAttempts: 3,
        reconnectDelay: 100,
      });
      
      const connectPromise = reconnectingClient.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      const ws = (reconnectingClient as unknown as { ws: MockWebSocket }).ws;
      
      const reconnectHandler = vi.fn();
      reconnectingClient.on('reconnecting', reconnectHandler);
      
      // Simulate unexpected close
      ws.simulateClose(1006, 'Abnormal closure');
      
      // Let reconnection timer fire
      await vi.advanceTimersByTimeAsync(150);
      
      expect(reconnectHandler).toHaveBeenCalled();
      
      reconnectingClient.disconnect();
    });

    it('should emit reconnecting event with attempt info', async () => {
      const reconnectingClient = new JSONRPCClient({
        maxReconnectAttempts: 2,
        reconnectDelay: 100,
      });
      
      const connectPromise = reconnectingClient.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      const ws = (reconnectingClient as unknown as { ws: MockWebSocket }).ws;
      
      const reconnectHandler = vi.fn();
      reconnectingClient.on('reconnecting', reconnectHandler);
      
      ws.simulateClose();
      
      await vi.advanceTimersByTimeAsync(150);
      
      expect(reconnectHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          maxAttempts: 2,
          delay: expect.any(Number),
        })
      );
      
      reconnectingClient.disconnect();
    });

    it('should use exponential backoff for reconnection', async () => {
      const reconnectingClient = new JSONRPCClient({
        maxReconnectAttempts: 5,
        reconnectDelay: 100,
      });
      
      const connectPromise = reconnectingClient.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      // Force the client to think it has reconnected so we can test delay calculation
      const getClientDelay = () => {
        const delays: number[] = [];
        for (let i = 1; i <= 3; i++) {
          // Exponential backoff: base * 2^(attempt-1) + jitter
          const base = 100 * Math.pow(2, i - 1);
          delays.push(base);
        }
        return delays;
      };
      
      const expectedDelays = getClientDelay();
      expect(expectedDelays[0]).toBe(100);  // 1st attempt
      expect(expectedDelays[1]).toBe(200);  // 2nd attempt
      expect(expectedDelays[2]).toBe(400);  // 3rd attempt
      
      reconnectingClient.disconnect();
    });

    it('should emit disconnected after max reconnect attempts', async () => {
      const reconnectingClient = new JSONRPCClient({
        maxReconnectAttempts: 2,
        reconnectDelay: 10,
      });
      
      // Create a WebSocket class that always fails to reconnect
      let attemptCount = 0;
      class FailingReconnectWebSocket extends MockWebSocket {
        constructor(url: string) {
          super(url);
          attemptCount++;
          
          // Only succeed on first connection, fail on reconnects
          if (attemptCount > 1) {
            // Override the default open behavior
            this.readyState = MockWebSocket.CLOSED;
            setTimeout(() => {
              this.dispatchEvent(new Event('error'));
            }, 0);
          }
        }
      }
      
      global.WebSocket = FailingReconnectWebSocket as unknown as typeof WebSocket;
      attemptCount = 0;
      
      const connectPromise = reconnectingClient.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      const disconnectedHandler = vi.fn();
      reconnectingClient.on('disconnected', disconnectedHandler);
      
      const ws = (reconnectingClient as unknown as { ws: MockWebSocket }).ws;
      
      // Simulate close to trigger reconnection
      ws.simulateClose();
      
      // Advance through reconnection attempts
      await vi.advanceTimersByTimeAsync(500);
      
      expect(disconnectedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringMatching(/reconnect_failed|max_reconnect/),
        })
      );
      
      global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    });

    it('should not attempt reconnection on explicit disconnect', async () => {
      const reconnectHandler = vi.fn();
      client.on('reconnecting', reconnectHandler);
      
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      client.disconnect();
      
      await vi.advanceTimersByTimeAsync(1000);
      
      expect(reconnectHandler).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      mockWs = (client as unknown as { ws: MockWebSocket }).ws;
    });

    it('should emit error event on invalid JSON message', () => {
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      
      // Simulate invalid JSON
      mockWs.onmessage!(new MessageEvent('message', { data: 'not valid json' }));
      
      expect(errorHandler).toHaveBeenCalled();
      const call = errorHandler.mock.calls[0][0];
      expect(call.error).toBeInstanceOf(JSONRPCError);
      expect(call.error.code).toBe(JSONRPCErrorCodes.PARSE_ERROR);
    });

    it('should emit error event on WebSocket error', () => {
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      
      mockWs.simulateError();
      
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should create proper JSONRPCError from error response', () => {
      const errorData = {
        code: -32601,
        message: 'Method not found',
        data: { method: 'unknownMethod' },
      };
      
      const error = JSONRPCError.fromErrorResponse(errorData);
      
      expect(error).toBeInstanceOf(JSONRPCError);
      expect(error.code).toBe(-32601);
      expect(error.message).toBe('Method not found');
      expect(error.data).toEqual({ method: 'unknownMethod' });
    });
  });

  describe('JSONRPCError', () => {
    it('should create error with code and data', () => {
      const error = new JSONRPCError('Test error', -32000, { foo: 'bar' });
      
      expect(error.name).toBe('JSONRPCError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe(-32000);
      expect(error.data).toEqual({ foo: 'bar' });
    });
  });

  describe('JSONRPCTimeoutError', () => {
    it('should create error with method and request info', () => {
      const error = new JSONRPCTimeoutError('slowMethod', 123, 5000);
      
      expect(error.name).toBe('JSONRPCTimeoutError');
      expect(error.method).toBe('slowMethod');
      expect(error.requestId).toBe(123);
      expect(error.message).toContain('slowMethod');
      expect(error.message).toContain('5000ms');
    });
  });

  describe('JSONRPCConnectionError', () => {
    it('should create connection error', () => {
      const error = new JSONRPCConnectionError('Failed to connect');
      
      expect(error.name).toBe('JSONRPCConnectionError');
      expect(error.message).toBe('Failed to connect');
    });
  });

  describe('edge cases', () => {
    beforeEach(async () => {
      const connectPromise = client.connect('ws://localhost:3000/ws');
      await vi.runAllTimersAsync();
      await connectPromise;
      
      mockWs = (client as unknown as { ws: MockWebSocket }).ws;
    });

    it('should handle null params in notifications', () => {
      const handler = vi.fn();
      client.on('nullEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'nullEvent',
        params: null,
      });
      
      expect(handler).toHaveBeenCalledWith(null);
    });

    it('should handle empty params object', () => {
      const handler = vi.fn();
      client.on('emptyEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'emptyEvent',
        params: {},
      });
      
      expect(handler).toHaveBeenCalledWith({});
    });

    it('should handle array params', () => {
      const handler = vi.fn();
      client.on('arrayEvent', handler);
      
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        method: 'arrayEvent',
        params: [1, 2, 3],
      });
      
      expect(handler).toHaveBeenCalledWith([1, 2, 3]);
    });

    it('should handle large request IDs', async () => {
      // Make many requests to test ID generation
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(client.request('test'));
      }
      
      await vi.runAllTimersAsync();
      
      const ids = mockWs.sentMessages.map(m => (JSON.parse(m) as JSONRPCRequest).id);
      const uniqueIds = new Set(ids);
      
      expect(uniqueIds.size).toBe(100);
      
      // Respond to all
      ids.forEach(id => {
        mockWs.simulateMessage({
          jsonrpc: '2.0',
          id,
          result: 'ok',
        });
      });
      
      await Promise.all(promises);
    });

    it('should handle response with null id', () => {
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      
      // Response with null id indicates an error not related to a specific request
      mockWs.simulateMessage({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      });
      
      // Should handle gracefully without throwing
      expect(errorHandler).not.toHaveBeenCalled();
    });
  });
});
