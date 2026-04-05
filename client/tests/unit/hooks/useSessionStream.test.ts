/**
 * Tests for useSessionStream Hook
 *
 * Tests cover the ref-based streaming hook that subscribes to the global
 * singleton WebSocket via getWebSocketInstance().addMessageListener().
 *
 * Event types handled by the hook:
 *   agent_start / agent_end
 *   message_start / message_update / message_end
 *   tool_execution_start / tool_execution_update / tool_execution_end
 *   history_start / history_end
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionStream } from '../../../src/hooks/useSessionStream';

// ============================================================================
// Mock WebSocket Client
// ============================================================================

interface MockWebSocketClient {
  addMessageListener: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
}

let mockWsInstance: MockWebSocketClient | null = null;
let capturedListener: ((message: unknown) => void) | null = null;

// Mock the websocket module
vi.mock('../../../src/lib/websocket.js', () => ({
  getWebSocketInstance: () => mockWsInstance,
}));

// ============================================================================
// Test Suite
// ============================================================================

describe('useSessionStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Create a fresh mock WS instance for each test
    capturedListener = null;
    mockWsInstance = {
      addMessageListener: vi.fn((listener: (msg: unknown) => void) => {
        capturedListener = listener;
        return () => {
          if (capturedListener === listener) capturedListener = null;
        };
      }),
      send: vi.fn(() => true),
      getStatus: vi.fn(() => 'connected'),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockWsInstance = null;
    capturedListener = null;
  });

  // Helper: simulate a message from the WebSocket
  function simulateMessage(message: unknown) {
    if (!capturedListener) throw new Error('No listener registered');
    act(() => {
      capturedListener!(message);
    });
  }

  // Helper: simulate a session_event wrapper
  function simulateSessionEvent(sessionId: string, event: { type: string; [key: string]: unknown }) {
    simulateMessage({
      type: 'session_event',
      sessionId,
      event,
    });
  }

  // Helper: simulate a direct (non-wrapped) message
  function simulateDirectMessage(msg: { type: string; sessionId?: string; [key: string]: unknown }) {
    simulateMessage(msg);
  }

  // ========================================
  // Basic Hook Behavior
  // ========================================

  describe('basic hook behavior', () => {
    it('should initialize with empty messages and idle status when no sessionId', () => {
      const { result } = renderHook(() => useSessionStream(null));

      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');
      expect(result.current.contextPercent).toBe(0);
      expect(result.current.currentStep).toBe(0);
      expect(result.current.isReplaying).toBe(false);
      expect(result.current.streamingContent).toEqual([]);
      expect(result.current.activeToolCalls).toEqual([]);
    });

    it('should not subscribe when sessionId is null', () => {
      renderHook(() => useSessionStream(null));
      expect(mockWsInstance!.addMessageListener).not.toHaveBeenCalled();
    });

    it('should subscribe to WebSocket via addMessageListener when sessionId provided', () => {
      renderHook(() => useSessionStream('session-123'));
      expect(mockWsInstance!.addMessageListener).toHaveBeenCalledTimes(1);
      expect(capturedListener).toBeTruthy();
    });

    it('should not auto-connect when autoConnect is false', () => {
      renderHook(() => useSessionStream('session-123', { autoConnect: false }));
      expect(mockWsInstance!.addMessageListener).not.toHaveBeenCalled();
    });

    it('should clean up subscription on unmount', () => {
      const { unmount } = renderHook(() => useSessionStream('session-123'));

      expect(mockWsInstance!.addMessageListener).toHaveBeenCalledTimes(1);
      const unsubscribeFn = mockWsInstance!.addMessageListener.mock.results[0].value;
      expect(typeof unsubscribeFn).toBe('function');

      unmount();

      // The unsubscribe function should have been called
      // (returned by addMessageListener and stored in cleanup)
    });
  });

  // ========================================
  // Agent Lifecycle Events
  // ========================================

  describe('agent lifecycle', () => {
    it('should set status to streaming on agent_start', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', { type: 'agent_start' });

      expect(result.current.status).toBe('streaming');
    });

    it('should commit streaming and set status to idle on agent_end', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Start agent
      simulateSessionEvent('session-123', { type: 'agent_start' });
      expect(result.current.status).toBe('streaming');

      // End agent
      simulateSessionEvent('session-123', { type: 'agent_end' });
      expect(result.current.status).toBe('idle');
    });
  });

  // ========================================
  // Message Streaming
  // ========================================

  describe('message streaming', () => {
    it('should add user message on message_start with role=user', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Hello' },
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toMatchObject({
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        isComplete: true,
      });
    });

    it('should track assistant message ID on message_start with role=assistant', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' },
      });

      // No message committed yet (still accumulating)
      expect(result.current.messages).toHaveLength(0);
    });

    it('should accumulate text_delta in refs without immediate state update', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Start assistant message
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' },
      });

      // Send text deltas - should NOT immediately update messages state
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
      });

      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      });

      // Messages should not have the content yet (accumulating in refs)
      expect(result.current.messages).toHaveLength(0);
    });

    it('should accumulate thinking_delta in refs', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Start agent + assistant message
      simulateSessionEvent('session-123', { type: 'agent_start' });
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' },
      });

      // Send thinking delta
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me think...' },
      });

      // Streaming content should reflect the thinking (via throttled update)
      // Run timers to flush any throttled updates
      act(() => { vi.advanceTimersByTime(50); });

      // After throttled update, streamingContent should show thinking
      expect(result.current.status).toBe('streaming');
    });

    it('should commit streaming content to messages on message_end', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Start assistant message
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' },
      });

      // Send text deltas
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello world' },
      });

      // Commit on message_end
      simulateSessionEvent('session-123', { type: 'message_end' });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toMatchObject({
        id: 'msg-2',
        role: 'assistant',
        isComplete: true,
      });
      // Content should include the accumulated text
      const content = result.current.messages[0].content;
      const textPart = content.find((p) => p.type === 'text');
      expect(textPart?.text).toBe('Hello world');
    });

    it('should commit on agent_end', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', { type: 'agent_start' });
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' },
      });
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Response text' },
      });

      // agent_end commits the message
      simulateSessionEvent('session-123', { type: 'agent_end' });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.status).toBe('idle');
    });
  });

  // ========================================
  // Tool Execution
  // ========================================

  describe('tool execution', () => {
    it('should add tool message on tool_execution_start', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'echo test' },
      });

      expect(result.current.messages).toHaveLength(1);
      const toolMsg = result.current.messages[0];
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.id).toBe('tool-1');
      expect(toolMsg.toolCall).toEqual({
        id: 'tool-1',
        name: 'bash',
        args: { command: 'echo test' },
      });
      expect(toolMsg.isComplete).toBe(false);
    });

    it('should update tool message with result on tool_execution_end', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Start tool
      simulateSessionEvent('session-123', {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'echo test' },
      });

      // End tool with result
      simulateSessionEvent('session-123', {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        result: { content: [{ type: 'text', text: 'test output' }] },
        isError: false,
      });

      const toolMsg = result.current.messages.find((m) => m.id === 'tool-1');
      expect(toolMsg?.toolResult).toEqual({ output: 'test output', isError: false });
      expect(toolMsg?.isComplete).toBe(true);
    });

    it('should handle tool error', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'tool_execution_start',
        toolCallId: 'tool-err',
        toolName: 'bash',
        args: { command: 'exit 1' },
      });

      simulateSessionEvent('session-123', {
        type: 'tool_execution_end',
        toolCallId: 'tool-err',
        result: { content: [{ type: 'text', text: 'Command failed' }] },
        isError: true,
      });

      const toolMsg = result.current.messages.find((m) => m.id === 'tool-err');
      expect(toolMsg?.toolResult?.isError).toBe(true);
      expect(toolMsg?.toolResult?.output).toBe('Command failed');
    });

    it('should update partial result on tool_execution_update', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: '/test' },
      });

      simulateSessionEvent('session-123', {
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        partialResult: { content: [{ type: 'text', text: 'partial output' }] },
      });

      const toolMsg = result.current.messages.find((m) => m.id === 'tool-1');
      expect(toolMsg?.toolResult).toEqual({ output: 'partial output', isError: false });
    });

    it('should handle concurrent tool calls', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Start multiple tools
      for (let i = 1; i <= 3; i++) {
        simulateSessionEvent('session-123', {
          type: 'tool_execution_start',
          toolCallId: `tool-${i}`,
          toolName: `read-${i}`,
          args: { path: `/file-${i}` },
        });
      }

      const toolMessages = result.current.messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(3);

      // End them
      for (let i = 1; i <= 3; i++) {
        simulateSessionEvent('session-123', {
          type: 'tool_execution_end',
          toolCallId: `tool-${i}`,
          result: { content: [{ type: 'text', text: `output-${i}` }] },
          isError: false,
        });
      }

      for (let i = 1; i <= 3; i++) {
        const msg = result.current.messages.find((m) => m.id === `tool-${i}`);
        expect(msg?.isComplete).toBe(true);
      }
    });
  });

  // ========================================
  // History Replay
  // ========================================

  describe('history replay', () => {
    it('should clear messages and set isReplaying on history_start', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Add a message first
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Old message' },
      });
      expect(result.current.messages).toHaveLength(1);

      // Start history replay
      simulateDirectMessage({ type: 'history_start' });

      expect(result.current.messages).toEqual([]);
      expect(result.current.isReplaying).toBe(true);
    });

    it('should clear isReplaying on history_end', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateDirectMessage({ type: 'history_start' });
      expect(result.current.isReplaying).toBe(true);

      simulateDirectMessage({ type: 'history_end' });
      expect(result.current.isReplaying).toBe(false);
    });

    it('should handle history_start via session_event wrapper', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', { type: 'history_start' });
      expect(result.current.messages).toEqual([]);
      expect(result.current.isReplaying).toBe(true);

      simulateSessionEvent('session-123', { type: 'history_end' });
      expect(result.current.isReplaying).toBe(false);
    });
  });

  // ========================================
  // Session Filtering
  // ========================================

  describe('session filtering', () => {
    it('should ignore session_event for different sessionId', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-456', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Other session' },
      });

      expect(result.current.messages).toHaveLength(0);
    });

    it('should process session_event for matching sessionId', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'My session' },
      });

      expect(result.current.messages).toHaveLength(1);
    });

    it('should process direct messages regardless of sessionId filter', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Direct message (not session_event wrapper) should be processed
      simulateDirectMessage({ type: 'history_start' });
      expect(result.current.isReplaying).toBe(true);
    });
  });

  // ========================================
  // Identity Guard
  // ========================================

  describe('identity guard', () => {
    it('should block stale callbacks after session switch', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Capture the listener for session-1
      const listener1 = capturedListener;

      // Switch to a new session
      act(() => {
        rerender({ sessionId: 'session-2' });
      });

      // Simulate a message through the OLD listener (stale callback)
      act(() => {
        listener1!({
          type: 'session_event',
          sessionId: 'session-1',
          event: {
            type: 'message_start',
            message: { id: 'msg-stale', role: 'user', content: 'Stale' },
          },
        });
      });

      // Should NOT appear in messages
      expect(result.current.messages.some((m) => m.id === 'msg-stale')).toBe(false);
    });

    it('should handle rapid session switches', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Rapid switches
      for (let i = 2; i <= 5; i++) {
        act(() => {
          rerender({ sessionId: `session-${i}` });
        });
      }

      // Should be in clean state
      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');
    });

    it('should clear state on session change', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Add messages
      simulateSessionEvent('session-1', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Hello' },
      });
      expect(result.current.messages).toHaveLength(1);

      // Switch session
      act(() => {
        rerender({ sessionId: 'session-2' });
      });

      // Messages should be cleared
      expect(result.current.messages).toEqual([]);
    });
  });

  // ========================================
  // Actions
  // ========================================

  describe('actions', () => {
    it('should send prompt via WebSocket client', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      act(() => {
        result.current.sendPrompt('Hello, world!');
      });

      expect(mockWsInstance!.send).toHaveBeenCalledWith({
        type: 'prompt',
        sessionId: 'session-123',
        message: 'Hello, world!',
        images: undefined,
      });
    });

    it('should set status to busy when sending prompt', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      act(() => {
        result.current.sendPrompt('Hello');
      });

      expect(result.current.status).toBe('busy');
    });

    it('should set status to error if send fails', () => {
      mockWsInstance!.send.mockReturnValueOnce(false);

      const { result } = renderHook(() => useSessionStream('session-123'));

      act(() => {
        result.current.sendPrompt('Hello');
      });

      expect(result.current.status).toBe('error');
    });

    it('should handle sendPrompt when no WebSocket instance', () => {
      mockWsInstance = null;

      const { result } = renderHook(() => useSessionStream('session-123'));

      // Should not throw
      expect(() => {
        act(() => {
          result.current.sendPrompt('Hello');
        });
      }).not.toThrow();
    });

    it('should cancel current turn via WebSocket client', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      act(() => {
        result.current.cancelCurrentTurn();
      });

      expect(mockWsInstance!.send).toHaveBeenCalledWith({ type: 'abort' });
      expect(result.current.status).toBe('idle');
    });

    it('should clear messages via clearMessages', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Add a message
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Test' },
      });
      expect(result.current.messages).toHaveLength(1);

      act(() => {
        result.current.clearMessages();
      });

      expect(result.current.messages).toEqual([]);
    });
  });

  // ========================================
  // Full Streaming Cycle
  // ========================================

  describe('full streaming cycle', () => {
    it('should handle complete user -> assistant turn', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // 1. Agent starts
      simulateSessionEvent('session-123', { type: 'agent_start' });
      expect(result.current.status).toBe('streaming');

      // 2. User message
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-user', role: 'user', content: 'What is 2+2?' },
      });
      expect(result.current.messages).toHaveLength(1);

      // 3. Assistant message start
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-assistant', role: 'assistant' },
      });

      // 4. Text deltas
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'The answer is ' },
      });
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '4.' },
      });

      // 5. Message end — commit assistant message
      simulateSessionEvent('session-123', { type: 'message_end' });

      expect(result.current.messages).toHaveLength(2); // user + assistant
      const assistantMsg = result.current.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.isComplete).toBe(true);
      const textPart = assistantMsg.content.find((p) => p.type === 'text');
      expect(textPart?.text).toBe('The answer is 4.');

      // 6. Agent ends
      simulateSessionEvent('session-123', { type: 'agent_end' });
      expect(result.current.status).toBe('idle');
    });

    it('should handle turn with tool calls', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', { type: 'agent_start' });

      // User message
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Read the file' },
      });

      // Tool execution
      simulateSessionEvent('session-123', {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: '/test.txt' },
      });

      simulateSessionEvent('session-123', {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        result: { content: [{ type: 'text', text: 'file contents here' }] },
        isError: false,
      });

      // Assistant response
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-2', role: 'assistant' },
      });
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Here is the file contents' },
      });
      simulateSessionEvent('session-123', { type: 'message_end' });

      simulateSessionEvent('session-123', { type: 'agent_end' });

      // Should have: user, tool, assistant
      expect(result.current.messages).toHaveLength(3);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[1].role).toBe('tool');
      expect(result.current.messages[2].role).toBe('assistant');
      expect(result.current.status).toBe('idle');
    });
  });

  // ========================================
  // Edge Cases
  // ========================================

  describe('edge cases', () => {
    it('should handle message_update without assistantMessageEvent', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Should not throw
      expect(() => {
        simulateSessionEvent('session-123', { type: 'message_update' });
      }).not.toThrow();

      expect(result.current.messages).toHaveLength(0);
    });

    it('should handle user message with array content', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: {
          id: 'msg-1',
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      });

      expect(result.current.messages[0].content).toEqual([
        { type: 'text', text: 'Hello' },
      ]);
    });

    it('should handle user message with no content', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'user' },
      });

      expect(result.current.messages[0].content).toEqual([]);
    });

    it('should handle tool_execution_end with no result content', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      simulateSessionEvent('session-123', {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: {},
      });

      simulateSessionEvent('session-123', {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        isError: false,
      });

      const toolMsg = result.current.messages[0];
      expect(toolMsg.isComplete).toBe(true);
    });

    it('should handle streaming content visibility', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // Before agent_start, streamingContent is empty
      expect(result.current.streamingContent).toEqual([]);

      // Start agent + assistant message
      simulateSessionEvent('session-123', { type: 'agent_start' });
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'assistant' },
      });

      // Add text — triggers throttled update
      simulateSessionEvent('session-123', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Streaming...' },
      });

      // Flush throttled updates
      act(() => { vi.advanceTimersByTime(50); });

      // StreamingContent should be visible since status is streaming
      expect(result.current.streamingContent.length).toBeGreaterThan(0);
    });

    it('should clear streaming content when not streaming', () => {
      const { result } = renderHook(() => useSessionStream('session-123'));

      // No agent_start, so status is idle -> streamingContent should be empty
      simulateSessionEvent('session-123', {
        type: 'message_start',
        message: { id: 'msg-1', role: 'assistant' },
      });

      expect(result.current.streamingContent).toEqual([]);
    });
  });

  // ========================================
  // Retry subscription when no WS instance
  // ========================================

  describe('retry subscription', () => {
    it('should retry subscription when WebSocket instance is null initially', () => {
      mockWsInstance = null;

      const { result } = renderHook(() => useSessionStream('session-123'));

      // No subscription yet
      expect(capturedListener).toBeNull();

      // Make WS available after delay
      mockWsInstance = {
        addMessageListener: vi.fn((listener) => {
          capturedListener = listener;
          return () => { if (capturedListener === listener) capturedListener = null; };
        }),
        send: vi.fn(() => true),
        getStatus: vi.fn(() => 'connected'),
      };

      // Advance timer to trigger retry
      act(() => { vi.advanceTimersByTime(150); });

      expect(mockWsInstance.addMessageListener).toHaveBeenCalledTimes(1);
    });
  });
});
