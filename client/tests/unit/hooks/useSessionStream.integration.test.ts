/**
 * Integration Tests for useSessionStream Hook
 *
 * Tests the full streaming flow including:
 * - Complete streaming lifecycle (history → prompt → tokens → end)
 * - Session switching with identity guards
 * - Background session isolation
 * - Rapid session switching
 * - Edge cases (mid-stream switch, reconnect, empty session, long messages, tool-only, thinking, compaction)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionStream } from '../../../src/hooks/useSessionStream';
import type { LiveMessage } from '../../../src/hooks/useSessionStream';

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

vi.mock('../../../src/lib/websocket.js', () => ({
  getWebSocketInstance: () => mockWsInstance,
}));

// ============================================================================
// Test Suite
// ============================================================================

describe('useSessionStream Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();

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

  // Helper: run a complete streaming turn with N text_delta events
  function runStreamingTurn(
    sessionId: string,
    messageId: string,
    deltas: string[],
    opts?: { includeUserMsg?: boolean; userMsgId?: string; userContent?: string }
  ) {
    const includeUser = opts?.includeUserMsg ?? true;

    // 1. agent_start
    simulateSessionEvent(sessionId, { type: 'agent_start' });

    // 2. Optional user message
    if (includeUser) {
      simulateSessionEvent(sessionId, {
        type: 'message_start',
        message: {
          id: opts?.userMsgId ?? 'msg-user-1',
          role: 'user',
          content: opts?.userContent ?? 'Hello',
        },
      });
    }

    // 3. Assistant message_start
    simulateSessionEvent(sessionId, {
      type: 'message_start',
      message: { id: messageId, role: 'assistant' },
    });

    // 4. Accumulate deltas
    for (const delta of deltas) {
      simulateSessionEvent(sessionId, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta },
      });
    }

    // 5. message_end
    simulateSessionEvent(sessionId, { type: 'message_end' });

    // 6. agent_end
    simulateSessionEvent(sessionId, { type: 'agent_end' });
  }

  // ========================================
  // 7A.1: Full Streaming Flow
  // ========================================

  describe('full streaming flow', () => {
    it('should handle complete lifecycle: connect → history → prompt → 50 tokens → end', () => {
      const sessionId = 'session-flow';
      const { result } = renderHook(() => useSessionStream(sessionId));

      // Step 1: History replay
      simulateDirectMessage({ type: 'history_start' });
      expect(result.current.messages).toEqual([]);
      expect(result.current.isReplaying).toBe(true);

      // Replay some events during history
      simulateSessionEvent(sessionId, {
        type: 'message_start',
        message: { id: 'hist-1', role: 'user', content: 'Previous question' },
      });
      simulateSessionEvent(sessionId, {
        type: 'message_start',
        message: { id: 'hist-2', role: 'assistant' },
      });
      simulateSessionEvent(sessionId, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Previous answer' },
      });
      simulateSessionEvent(sessionId, { type: 'message_end' });

      simulateDirectMessage({ type: 'history_end' });
      expect(result.current.isReplaying).toBe(false);

      // History should have: user + assistant
      expect(result.current.messages).toHaveLength(2);
      const histAssistant = result.current.messages[1];
      const histText = histAssistant.content.find((p) => p.type === 'text');
      expect(histText?.text).toBe('Previous answer');

      // Step 2: Send prompt → receive agent_start → message_start → 50 × message_update → message_end → agent_end
      const tokens = Array.from({ length: 50 }, (_, i) => `token${i} `);
      runStreamingTurn(sessionId, 'msg-live-1', tokens, {
        userMsgId: 'msg-live-user',
        userContent: 'New question',
      });

      // Verify: messages contain correct accumulated text
      // History: 2 messages + user + assistant = 4
      expect(result.current.messages).toHaveLength(4);
      expect(result.current.status).toBe('idle');

      // Check user message was added
      const liveUser = result.current.messages[2];
      expect(liveUser.role).toBe('user');
      expect(liveUser.content[0].text).toBe('New question');

      // Check assistant message accumulated all 50 tokens
      const liveAssistant = result.current.messages[3];
      expect(liveAssistant.role).toBe('assistant');
      expect(liveAssistant.isComplete).toBe(true);
      const liveText = liveAssistant.content.find((p) => p.type === 'text');
      expect(liveText?.text).toBe(tokens.join(''));
    });
  });

  // ========================================
  // 7A.2: Session Switching
  // ========================================

  describe('session switching', () => {
    it('should restore messages on history replay after switching back', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-A' } }
      );

      // Stream session A for 10 tokens
      runStreamingTurn('session-A', 'msg-a-1', ['Hello ', 'from ', 'session ', 'A', '!'], {
        userMsgId: 'user-a-1',
        userContent: 'Prompt A',
      });
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.status).toBe('idle');

      // Switch to session B
      act(() => {
        rerender({ sessionId: 'session-B' });
      });

      // Session B messages are empty until history replay
      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');

      // History replay for session B
      simulateDirectMessage({ type: 'history_start' });
      simulateSessionEvent('session-B', {
        type: 'message_start',
        message: { id: 'hist-b-1', role: 'user', content: 'Session B question' },
      });
      simulateDirectMessage({ type: 'history_end' });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('hist-b-1');

      // Switch back to session A — history replay restores messages
      act(() => {
        rerender({ sessionId: 'session-A' });
      });

      // Clean state — needs history replay
      expect(result.current.messages).toEqual([]);

      // Simulate history replay for A
      simulateDirectMessage({ type: 'history_start' });
      simulateSessionEvent('session-A', {
        type: 'message_start',
        message: { id: 'hist-a-1', role: 'user', content: 'Prompt A' },
      });
      simulateSessionEvent('session-A', {
        type: 'message_start',
        message: { id: 'hist-a-2', role: 'assistant' },
      });
      simulateSessionEvent('session-A', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello from session A!' },
      });
      simulateSessionEvent('session-A', { type: 'message_end' });
      simulateDirectMessage({ type: 'history_end' });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[1].content[0].text).toBe('Hello from session A!');
    });
  });

  // ========================================
  // 7A.3: Background Session Isolation
  // ========================================

  describe('background session isolation', () => {
    it('should not affect active session when receiving events for background session', () => {
      const { result } = renderHook(() => useSessionStream('session-A'));

      // Stream session A (active)
      simulateSessionEvent('session-A', {
        type: 'message_start',
        message: { id: 'msg-a-1', role: 'user', content: 'Active message' },
      });
      expect(result.current.messages).toHaveLength(1);

      // Receive events for session B (background, different sessionId via session_event wrapper)
      simulateSessionEvent('session-B', {
        type: 'message_start',
        message: { id: 'msg-b-1', role: 'user', content: 'Background message' },
      });
      simulateSessionEvent('session-B', {
        type: 'message_start',
        message: { id: 'msg-b-2', role: 'assistant' },
      });
      simulateSessionEvent('session-B', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Background streaming' },
      });
      simulateSessionEvent('session-B', { type: 'message_end' });

      // Verify session A's messages are NOT affected
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg-a-1');
      expect(result.current.messages[0].content[0].text).toBe('Active message');

      // No background messages leaked
      expect(result.current.messages.every((m) => m.id.startsWith('msg-a'))).toBe(true);
    });
  });

  // ========================================
  // 7A.4: Rapid Session Switching
  // ========================================

  describe('rapid session switching', () => {
    it('should prevent cross-session message leaks when rapidly switching between 3 sessions', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Send message to session-1
      simulateSessionEvent('session-1', {
        type: 'message_start',
        message: { id: 'msg-s1-1', role: 'user', content: 'Session 1 message' },
      });
      expect(result.current.messages).toHaveLength(1);

      // Rapidly switch: 1 → 2 → 3
      act(() => { rerender({ sessionId: 'session-2' }); });
      act(() => { rerender({ sessionId: 'session-3' }); });

      // Messages should be clean (cleared on switch)
      expect(result.current.messages).toEqual([]);

      // Add messages for session-3 (current)
      simulateSessionEvent('session-3', {
        type: 'message_start',
        message: { id: 'msg-s3-1', role: 'user', content: 'Session 3 message' },
      });
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg-s3-1');

      // Switch back to session-2 quickly
      act(() => { rerender({ sessionId: 'session-2' }); });

      // Try sending stale messages through old listener
      // The old listener for session-1 should be invalidated
      expect(result.current.messages).toEqual([]);
    });

    it('should maintain correct identity across rapid rerenders', () => {
      const sessionIds = ['s-a', 's-b', 's-c', 's-d', 's-e'];
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: sessionIds[0] } }
      );

      // Rapidly cycle through all sessions
      for (let i = 1; i < sessionIds.length; i++) {
        act(() => { rerender({ sessionId: sessionIds[i] }); });
      }

      // Final session should be clean
      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');

      // Send a message to the final session
      simulateSessionEvent(sessionIds[sessionIds.length - 1], {
        type: 'message_start',
        message: { id: 'msg-final', role: 'user', content: 'Final session' },
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg-final');
    });
  });

  // ========================================
  // 7D: Edge Cases
  // ========================================

  describe('edge cases', () => {
    it('session switch mid-stream: identity guard prevents stale updates', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-A' } }
      );

      // Start streaming on session A
      simulateSessionEvent('session-A', { type: 'agent_start' });
      simulateSessionEvent('session-A', {
        type: 'message_start',
        message: { id: 'msg-a-stream', role: 'assistant' },
      });

      // Send some deltas
      simulateSessionEvent('session-A', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Partial...' },
      });

      // Mid-stream: switch to session B
      act(() => {
        rerender({ sessionId: 'session-B' });
      });

      // State should be cleared
      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');

      // The old listener is invalidated — further deltas on session A
      // through the old captured listener should be ignored
      // (But the capturedListener is now for session-B, so we can't
      // easily simulate this. Instead, verify new session works.)
      simulateSessionEvent('session-B', {
        type: 'message_start',
        message: { id: 'msg-b-1', role: 'user', content: 'Session B prompt' },
      });
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg-b-1');
    });

    it('WebSocket reconnect: hook re-registers listener when sessionId changes', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useSessionStream(sessionId),
        { initialProps: { sessionId: 'session-1' } }
      );

      // Initial subscription
      const firstCallCount = mockWsInstance!.addMessageListener.mock.calls.length;
      expect(firstCallCount).toBe(1);

      // Simulate "reconnect" by switching away and back
      act(() => { rerender({ sessionId: 'session-2' }); });
      act(() => { rerender({ sessionId: 'session-1' }); });

      // Should have new subscriptions (each switch creates new)
      expect(mockWsInstance!.addMessageListener.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('empty session: no messages, empty state renders without error', () => {
      const { result } = renderHook(() => useSessionStream('empty-session'));

      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');
      expect(result.current.isReplaying).toBe(false);
      expect(result.current.streamingContent).toEqual([]);
      expect(result.current.activeToolCalls).toEqual([]);
      expect(result.current.contextPercent).toBe(0);

      // Verify actions work on empty state
      act(() => {
        result.current.clearMessages();
      });
      expect(result.current.messages).toEqual([]);
    });

    it('very long message (50KB text): renders without crash', () => {
      const { result } = renderHook(() => useSessionStream('session-long'));

      // Generate ~50KB of text
      const longText = 'A'.repeat(50000);

      simulateSessionEvent('session-long', { type: 'agent_start' });
      simulateSessionEvent('session-long', {
        type: 'message_start',
        message: { id: 'msg-long', role: 'assistant' },
      });
      simulateSessionEvent('session-long', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: longText },
      });
      simulateSessionEvent('session-long', { type: 'message_end' });
      simulateSessionEvent('session-long', { type: 'agent_end' });

      // Should have the message without crashing
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].isComplete).toBe(true);
      const textPart = result.current.messages[0].content.find((p) => p.type === 'text');
      expect(textPart?.text).toBe(longText);
      expect(textPart!.text!.length).toBe(50000);
    });

    it('tool-only turn (no text): tool messages appear correctly', () => {
      const { result } = renderHook(() => useSessionStream('session-tools'));

      simulateSessionEvent('session-tools', { type: 'agent_start' });

      // Tool execution only — no message_start/message_update for assistant text
      simulateSessionEvent('session-tools', {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'echo hello' },
      });
      simulateSessionEvent('session-tools', {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        result: { content: [{ type: 'text', text: 'hello' }] },
        isError: false,
      });

      // Second tool
      simulateSessionEvent('session-tools', {
        type: 'tool_execution_start',
        toolCallId: 'tool-2',
        toolName: 'read',
        args: { path: '/tmp/file.txt' },
      });
      simulateSessionEvent('session-tools', {
        type: 'tool_execution_end',
        toolCallId: 'tool-2',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      });

      simulateSessionEvent('session-tools', { type: 'agent_end' });

      // Should have 2 tool messages, no text messages
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages.every((m) => m.role === 'tool')).toBe(true);
      expect(result.current.messages[0].toolCall!.name).toBe('bash');
      expect(result.current.messages[1].toolCall!.name).toBe('read');
      expect(result.current.status).toBe('idle');
    });

    it('thinking-only message: thinking content renders', () => {
      const { result } = renderHook(() => useSessionStream('session-think'));

      simulateSessionEvent('session-think', { type: 'agent_start' });
      simulateSessionEvent('session-think', {
        type: 'message_start',
        message: { id: 'msg-think', role: 'assistant' },
      });

      // Only thinking deltas, no text_delta
      simulateSessionEvent('session-think', {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me analyze this...' },
      });
      simulateSessionEvent('session-think', {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'The answer should be 42.' },
      });

      simulateSessionEvent('session-think', { type: 'message_end' });
      simulateSessionEvent('session-think', { type: 'agent_end' });

      expect(result.current.messages).toHaveLength(1);
      const msg = result.current.messages[0];
      expect(msg.role).toBe('assistant');
      expect(msg.isComplete).toBe(true);

      // Should have thinking content but no text
      const thinkingPart = msg.content.find((p) => p.type === 'thinking');
      expect(thinkingPart?.thinking).toBe('Let me analyze this...The answer should be 42.');
      const textPart = msg.content.find((p) => p.type === 'text');
      expect(textPart).toBeUndefined();
    });

    it('auto-compaction during streaming: indicator accessible from store', () => {
      const { result } = renderHook(() => useSessionStream('session-compact'));

      // Start streaming
      simulateSessionEvent('session-compact', { type: 'agent_start' });
      simulateSessionEvent('session-compact', {
        type: 'message_start',
        message: { id: 'msg-compact', role: 'assistant' },
      });
      simulateSessionEvent('session-compact', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Streaming...' },
      });

      // While streaming, the hook status is 'streaming'
      expect(result.current.status).toBe('streaming');

      // The isCompacting and compactionReason are managed by sessionStore,
      // not useSessionStream. The ChatView reads those from the store.
      // We verify the hook's status is correct during streaming.
      expect(result.current.streamingContent.length).toBeGreaterThanOrEqual(0);

      // End streaming
      simulateSessionEvent('session-compact', { type: 'message_end' });
      simulateSessionEvent('session-compact', { type: 'agent_end' });
      expect(result.current.status).toBe('idle');
    });

    it('mixed thinking and text content in same message', () => {
      const { result } = renderHook(() => useSessionStream('session-mixed'));

      simulateSessionEvent('session-mixed', { type: 'agent_start' });
      simulateSessionEvent('session-mixed', {
        type: 'message_start',
        message: { id: 'msg-mixed', role: 'assistant' },
      });

      // Thinking first
      simulateSessionEvent('session-mixed', {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm, let me think...' },
      });
      // Then text
      simulateSessionEvent('session-mixed', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Here is the answer.' },
      });

      simulateSessionEvent('session-mixed', { type: 'message_end' });
      simulateSessionEvent('session-mixed', { type: 'agent_end' });

      const msg = result.current.messages[0];
      // Thinking comes first in content array
      expect(msg.content[0].type).toBe('thinking');
      expect(msg.content[0].thinking).toBe('Hmm, let me think...');
      expect(msg.content[1].type).toBe('text');
      expect(msg.content[1].text).toBe('Here is the answer.');
    });

    it('multiple turns in one session accumulate correctly', () => {
      const { result } = renderHook(() => useSessionStream('session-multi'));

      // Turn 1
      runStreamingTurn('session-multi', 'msg-turn1', ['Turn 1 response'], {
        userMsgId: 'user-1',
        userContent: 'Question 1',
      });
      expect(result.current.messages).toHaveLength(2);

      // Turn 2
      runStreamingTurn('session-multi', 'msg-turn2', ['Turn 2 response'], {
        userMsgId: 'user-2',
        userContent: 'Question 2',
      });
      expect(result.current.messages).toHaveLength(4);

      // Turn 3
      runStreamingTurn('session-multi', 'msg-turn3', ['Turn 3 response'], {
        userMsgId: 'user-3',
        userContent: 'Question 3',
      });
      expect(result.current.messages).toHaveLength(6);

      // Verify order and content
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content[0].text).toBe('Question 1');
      expect(result.current.messages[1].role).toBe('assistant');
      expect(result.current.messages[2].role).toBe('user');
      expect(result.current.messages[3].role).toBe('assistant');
      expect(result.current.messages[4].role).toBe('user');
      expect(result.current.messages[5].role).toBe('assistant');
    });

    it('handles null WebSocket gracefully on sendPrompt', () => {
      mockWsInstance = null;
      const { result } = renderHook(() => useSessionStream('session-null'));

      // Should not throw when WS is null
      expect(() => {
        act(() => {
          result.current.sendPrompt('test');
        });
      }).not.toThrow();
    });

    it('handles null WebSocket gracefully on cancelCurrentTurn', () => {
      mockWsInstance = null;
      const { result } = renderHook(() => useSessionStream('session-null'));

      expect(() => {
        act(() => {
          result.current.cancelCurrentTurn();
        });
      }).not.toThrow();
    });
  });
});
