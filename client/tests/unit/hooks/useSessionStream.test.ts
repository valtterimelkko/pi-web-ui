/**
 * Tests for useSessionStream Hook
 *
 * Tests cover:
 * - Ref accumulation without re-renders
 * - Identity guard effectiveness
 * - Atomic teardown
 * - History replay handling
 * - Rapid session switching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionStream } from '../../../src/hooks/useSessionStream';
import type { LiveMessage, ContentPart } from '../../../src/hooks/useSessionStream';

// ============================================================================
// Mock WebSocket
// ============================================================================

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
    if (event.type === 'message' && this.onmessage)
      this.onmessage(event as MessageEvent);
  }

  send(data: string): void {
    this.sentMessages.push(data);
    // Behave like a real server: auto-respond to JSON-RPC *requests* (messages
    // that carry an `id`, e.g. 'initialize' and 'prompt') with a success result
    // so the hook's awaited client.request(...) calls resolve. Notifications
    // (no `id`, e.g. 'cancel') are left unanswered.
    try {
      const parsed = JSON.parse(data) as { id?: string | number; method?: string };
      if (parsed && parsed.id !== undefined && parsed.method) {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }),
          })
        );
      }
    } catch {
      // Non-JSON payload; nothing to auto-respond to.
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? '';
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent('close', { code: this.closeCode, reason: this.closeReason })
    );
  }

  // Test helpers
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(data) })
    );
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

// ============================================================================
// Test Suite
// ============================================================================

describe('useSessionStream', () => {
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

  // ========================================
  // Basic Hook Behavior
  // ========================================

  describe('basic hook behavior', () => {
    it('should initialize with empty state when no sessionId', () => {
      const { result } = renderHook(() => useSessionStream(null));

      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');
      expect(result.current.contextPercent).toBe(0);
      expect(result.current.isReplaying).toBe(false);
      expect(result.current.streamingContent).toEqual([]);
      expect(result.current.activeToolCalls).toEqual([]);
    });

    it('should start connecting when sessionId is provided', async () => {
      const { result } = renderHook(() =>
        useSessionStream('session-123', { autoConnect: true })
      );

      // Let WebSocket open and initialize
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should have sent initialize request
      const ws = mockWsInstances[mockWsInstances.length - 1];
      expect(ws).toBeDefined();
    });

    it('should not auto-connect when autoConnect is false', async () => {
      const { result } = renderHook(() =>
        useSessionStream('session-123', { autoConnect: false })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // No WebSocket should be created
      expect(mockWsInstances.length).toBe(0);
    });

    it('should disconnect when sessionId becomes null', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-123' as string | null } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockWsInstances.length).toBeGreaterThan(0);

      // Switch to null session
      await act(async () => {
        rerender({ sessionId: null });
      });

      // WebSocket should be closed
      const ws = mockWsInstances[mockWsInstances.length - 1];
      expect(ws?.closeCode).not.toBeNull();
    });
  });

  // ========================================
  // Ref Accumulation Without Re-renders
  // ========================================

  describe('ref accumulation without re-renders', () => {
    it('should accumulate text content without triggering re-renders on every delta', async () => {
      let renderCount = 0;

      const { result } = renderHook(() => {
        renderCount++;
        return useSessionStream('session-123');
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const initialRenderCount = renderCount;

      // Simulate multiple content deltas
      const ws = mockWsInstances[mockWsInstances.length - 1];

      // First, simulate turnBegin
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      // Send multiple text deltas
      for (let i = 0; i < 10; i++) {
        ws.simulateMessage({
          jsonrpc: '2.0',
          method: 'contentPart',
          params: {
            type: 'text',
            content: `chunk-${i} `,
            isDelta: true,
          },
        });

        // Small delay to allow batching
        await vi.advanceTimersByTimeAsync(5);
      }

      // Should not have re-rendered on every delta (throttled updates)
      // The exact count depends on throttling, but should be less than 10
      expect(renderCount).toBeLessThan(initialRenderCount + 10);
    });

    it('should accumulate thinking content in refs', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Simulate thinking content
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'thinking',
          content: 'Let me think about this...',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should have streaming content
      expect(result.current.streamingContent.length).toBeGreaterThan(0);
      expect(result.current.streamingContent[0].type).toBe('thinking');
    });

    it('should accumulate tool calls in refs', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Simulate tool call
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'toolCall',
        params: {
          id: 'tool-1',
          name: 'read',
          args: { path: '/test/file.ts' },
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Tool call should be in messages
      expect(result.current.messages.length).toBeGreaterThan(0);
      const toolMessage = result.current.messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.toolCall?.name).toBe('read');
    });
  });

  // ========================================
  // Identity Guard Effectiveness
  // ========================================

  describe('identity guard effectiveness', () => {
    it('should block stale callbacks after session switch', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Capture the first WebSocket
      const ws1 = mockWsInstances[0];
      expect(ws1).toBeDefined();

      // Switch to new session before content arrives
      await act(async () => {
        rerender({ sessionId: 'session-2' });
        await vi.runAllTimersAsync();
      });

      // Now simulate content from old session
      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'This should be ignored',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Messages should not contain the stale content
      const hasStaleContent = result.current.messages.some((m) =>
        m.content.some((p) => p.text?.includes('This should be ignored'))
      );
      expect(hasStaleContent).toBe(false);
    });

    it('should invalidate identity on disconnect', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Disconnect
      act(() => {
        result.current.cancelCurrentTurn();
      });

      // Try to send content after disconnect
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'After disconnect',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Content should not appear
      expect(result.current.messages.length).toBe(0);
    });

    it('should handle rapid session switches without stale state', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Rapid switches without waiting for connection
      for (let i = 2; i <= 5; i++) {
        await act(async () => {
          rerender({ sessionId: `session-${i}` });
          // Small delay but not enough to complete connection
          await vi.advanceTimersByTimeAsync(1);
        });
      }

      // Now let everything settle
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should be in a clean state
      expect(result.current.status).toBe('idle');
    });
  });

  // ========================================
  // Atomic Teardown
  // ========================================

  describe('atomic teardown', () => {
    it('should clear all refs on unmount', async () => {
      const { result, unmount } = renderHook(() =>
        useSessionStream('session-123')
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Add some content
      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Test content',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Unmount
      unmount();

      // State should be cleared (we can't check refs directly, but we can verify behavior)
      expect(result.current.messages).toEqual([]);
    });

    it('should clear all state on session change', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Add some messages
      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Test',
          isDelta: false,
        },
      });
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.messages.length).toBeGreaterThan(0);

      // Switch session
      await act(async () => {
        rerender({ sessionId: 'session-2' });
        await vi.runAllTimersAsync();
      });

      // Messages should be cleared
      expect(result.current.messages).toEqual([]);
    });

    it('should prevent stale updates after cleanup', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws1 = mockWsInstances[0];

      // Switch session
      await act(async () => {
        rerender({ sessionId: 'session-2' });
        await vi.runAllTimersAsync();
      });

      // Send message to old WebSocket
      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-stale' },
      });
      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-stale' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should not have added stale messages
      const hasStaleTurn = result.current.messages.some(
        (m) => m.id.includes('turn-stale')
      );
      expect(hasStaleTurn).toBe(false);
    });
  });

  // ========================================
  // History Replay Handling
  // ========================================

  describe('history replay handling', () => {
    it('should set isReplaying on replay_start', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isReplaying).toBe(false);

      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'replay_start',
        params: {},
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isReplaying).toBe(true);
    });

    it('should clear isReplaying on replay_complete', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Start replay
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'replay_start',
        params: {},
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isReplaying).toBe(true);

      // Complete replay
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'replay_complete',
        params: {},
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.isReplaying).toBe(false);
    });

    it('should handle replayed messages', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Simulate replay
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'replay_start',
        params: {},
      });

      // Replay some messages
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-replay-1' },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Replayed message',
          isDelta: false,
        },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-replay-1' },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'replay_complete',
        params: {},
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should have the replayed message
      expect(result.current.messages.length).toBeGreaterThan(0);
      expect(result.current.isReplaying).toBe(false);
    });
  });

  // ========================================
  // Rapid Session Switching
  // ========================================

  describe('rapid session switching', () => {
    it('should handle rapid session switches without memory leaks', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Rapid switches
      for (let i = 2; i <= 10; i++) {
        await act(async () => {
          rerender({ sessionId: `session-${i}` });
          await vi.advanceTimersByTimeAsync(1);
        });
      }

      // Let everything settle
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should have created multiple WebSockets
      expect(mockWsInstances.length).toBeGreaterThan(1);

      // All but the last should be closed
      const closedCount = mockWsInstances.filter(
        (ws) => ws.readyState === MockWebSocket.CLOSED
      ).length;
      expect(closedCount).toBe(mockWsInstances.length - 1);
    });

    it('should not accumulate stale messages on rapid switches', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Add message to first session
      const ws1 = mockWsInstances[0];
      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });
      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Rapid switch
      for (let i = 2; i <= 5; i++) {
        await act(async () => {
          rerender({ sessionId: `session-${i}` });
          await vi.runAllTimersAsync();
        });
      }

      // Messages should be empty (cleared on each switch)
      expect(result.current.messages).toEqual([]);
    });

    it('should handle session switch during streaming', async () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws1 = mockWsInstances[0];

      // Start streaming
      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      ws1.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Streaming...',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(result.current.status).toBe('streaming');

      // Switch session mid-stream
      await act(async () => {
        rerender({ sessionId: 'session-2' });
        await vi.runAllTimersAsync();
      });

      // Status should reset
      expect(result.current.status).toBe('idle');
      expect(result.current.streamingContent).toEqual([]);
    });
  });

  // ========================================
  // Tool Execution
  // ========================================

  describe('tool execution', () => {
    it('should handle tool call start', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'toolCall',
        params: {
          id: 'tool-1',
          name: 'bash',
          args: { command: 'echo test' },
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const toolMessage = result.current.messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.toolCall?.name).toBe('bash');
      expect(toolMessage?.toolCall?.args).toEqual({ command: 'echo test' });
    });

    it('should handle tool result', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Start tool
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'toolCall',
        params: {
          id: 'tool-1',
          name: 'bash',
          args: { command: 'echo test' },
        },
      });

      // End tool with result
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'toolResult',
        params: {
          id: 'tool-1',
          result: 'test output',
          isError: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const toolMessage = result.current.messages.find((m) => m.id === 'tool-1');
      expect(toolMessage?.toolResult).toBeDefined();
      expect(toolMessage?.toolResult?.output).toBe('test output');
      expect(toolMessage?.toolResult?.isError).toBe(false);
    });

    it('should handle tool error', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'toolCall',
        params: {
          id: 'tool-1',
          name: 'bash',
          args: { command: 'exit 1' },
        },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'toolResult',
        params: {
          id: 'tool-1',
          result: 'Command failed',
          isError: true,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const toolMessage = result.current.messages.find((m) => m.id === 'tool-1');
      expect(toolMessage?.toolResult?.isError).toBe(true);
    });
  });

  // ========================================
  // Actions
  // ========================================

  describe('actions', () => {
    it('should send prompt', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.clearMessages();

      await act(async () => {
        await result.current.sendPrompt('Hello, world!');
      });

      const lastMessage = ws.getLastMessage();
      expect(lastMessage).toMatchObject({
        jsonrpc: '2.0',
        method: 'prompt',
        params: {
          content: 'Hello, world!',
        },
      });
    });

    it('should send prompt with attachments', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.clearMessages();

      const attachments = [
        {
          name: 'test.txt',
          mimeType: 'text/plain',
          data: 'SGVsbG8=', // Base64 "Hello"
        },
      ];

      await act(async () => {
        await result.current.sendPrompt('Check this file', attachments);
      });

      const lastMessage = ws.getLastMessage();
      expect(lastMessage).toMatchObject({
        method: 'prompt',
        params: {
          content: 'Check this file',
          attachments,
        },
      });
    });

    it('should cancel current turn', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.clearMessages();

      act(() => {
        result.current.cancelCurrentTurn();
      });

      const lastMessage = ws.getLastMessage();
      expect(lastMessage).toMatchObject({
        jsonrpc: '2.0',
        method: 'cancel',
      });

      expect(result.current.status).toBe('idle');
    });

    it('should clear messages', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Add a message
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.messages.length).toBeGreaterThan(0);

      // Clear
      act(() => {
        result.current.clearMessages();
      });

      expect(result.current.messages).toEqual([]);
    });
  });

  // ========================================
  // Status Handling
  // ========================================

  describe('status handling', () => {
    it('should update status on status event', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.status).toBe('idle');

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'status',
        params: {
          status: 'busy',
          message: 'Processing...',
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.status).toBe('busy');
    });

    it('should set status to streaming on turnBegin', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.status).toBe('streaming');
    });

    it('should set status to idle on turnEnd', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.status).toBe('streaming');

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.status).toBe('idle');
    });
  });

  // ========================================
  // Context Tracking
  // ========================================

  describe('context tracking', () => {
    it('should update context percent', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.contextPercent).toBe(0);

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'context',
        params: {
          percent: 75,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.contextPercent).toBe(75);
    });

    it('should update current step', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.currentStep).toBe(0);

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'context',
        params: {
          step: 3,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.currentStep).toBe(3);
    });
  });

  // ========================================
  // Edge Cases
  // ========================================

  describe('edge cases', () => {
    it('should handle sendPrompt when not connected', async () => {
      const { result } = renderHook(() =>
        useSessionStream('session-123', { autoConnect: false })
      );

      // Should not throw
      await expect(
        result.current.sendPrompt('Hello')
      ).resolves.toBeUndefined();
    });

    it('should handle cancelCurrentTurn when not connected', () => {
      const { result } = renderHook(() =>
        useSessionStream('session-123', { autoConnect: false })
      );

      // Should not throw
      expect(() => result.current.cancelCurrentTurn()).not.toThrow();
    });

    it('should handle multiple turnBegin/turnEnd cycles', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Multiple turns
      for (let i = 1; i <= 3; i++) {
        ws.simulateMessage({
          jsonrpc: '2.0',
          method: 'turnBegin',
          params: { turnId: `turn-${i}` },
        });

        ws.simulateMessage({
          jsonrpc: '2.0',
          method: 'contentPart',
          params: {
            type: 'text',
            content: `Message ${i}`,
            isDelta: false,
          },
        });

        ws.simulateMessage({
          jsonrpc: '2.0',
          method: 'turnEnd',
          params: { turnId: `turn-${i}` },
        });

        await act(async () => {
          await vi.runAllTimersAsync();
        });
      }

      // Should have 3 assistant messages
      const assistantMessages = result.current.messages.filter(
        (m) => m.role === 'assistant'
      );
      expect(assistantMessages.length).toBe(3);
    });

    it('should handle concurrent tool calls', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Multiple concurrent tool calls
      for (let i = 1; i <= 3; i++) {
        ws.simulateMessage({
          jsonrpc: '2.0',
          method: 'toolCall',
          params: {
            id: `tool-${i}`,
            name: `read-${i}`,
            args: { path: `/file-${i}` },
          },
        });
      }

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const toolMessages = result.current.messages.filter(
        (m) => m.role === 'tool'
      );
      expect(toolMessages.length).toBe(3);
    });

    it('should handle empty content', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      // Empty content
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: '',
          isDelta: false,
        },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should have created a message even with empty content
      expect(result.current.messages.length).toBeGreaterThan(0);
    });
  });

  // ========================================
  // Streaming Content Display
  // ========================================

  describe('streaming content display', () => {
    it('should show streaming content during streaming', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      // Start turn
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      // Add text
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Streaming text',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.status).toBe('streaming');
      expect(result.current.streamingContent.length).toBeGreaterThan(0);
    });

    it('should clear streaming content after turnEnd', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Streaming text',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.streamingContent.length).toBeGreaterThan(0);

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnEnd',
        params: { turnId: 'turn-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.streamingContent).toEqual([]);
    });

    it('should show thinking content before text content', async () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const ws = mockWsInstances[mockWsInstances.length - 1];

      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'turnBegin',
        params: { turnId: 'turn-1' },
      });

      // Add thinking first
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'thinking',
          content: 'Thinking...',
          isDelta: false,
        },
      });

      // Then add text
      ws.simulateMessage({
        jsonrpc: '2.0',
        method: 'contentPart',
        params: {
          type: 'text',
          content: 'Response',
          isDelta: false,
        },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Thinking should come first in content array
      expect(result.current.streamingContent[0].type).toBe('thinking');
      expect(result.current.streamingContent[1].type).toBe('text');
    });
  });
});
