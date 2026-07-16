import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useSessionStore, type Message, type Session } from '../../../src/store/sessionStore';
import { useUIStore } from '../../../src/store/uiStore';
import { useTransferStore } from '../../../src/store/transferStore';

describe('sessionStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    const state = useSessionStore.getState();
    state.setSessions([]);
    state.setCurrentSession(null);
    state.clearMessages();
    state.setStreaming(false);
    state.setLoading(false);
    state.setError(null);
    state.setExtensionUIRequest(null);
    useTransferStore.getState().reset();
    // Clear session messages cache directly
    useSessionStore.setState({ 
      sessionMessages: {}, 
      streamingSessions: {},
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,
      lastStreamEventAt: null,
      sessionCache: new Map(),
      sessionCacheMeta: {},
      pinnedSessionPaths: [],
      archivedSessionPaths: [],
      transferReadySessionIds: {},
    });
    useUIStore.setState({ toasts: [] });
  });

  describe('handleServerMessage', () => {
    it('should handle sessions_list message', () => {
      const state = useSessionStore.getState();
      const sessions: Session[] = [
        { id: 's1', path: '/p1', firstMessage: 'Hi', messageCount: 1, cwd: '/' },
      ];
      state.handleServerMessage({ type: 'sessions_list', sessions });
      expect(useSessionStore.getState().sessions).toEqual(sessions);
    });

    it('should handle session_created message', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({ type: 'session_created', sessionId: 'new-session' });
      expect(useSessionStore.getState().currentSessionId).toBe('new-session');
    });

    it('should handle agent_start message', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({ type: 'agent_start' });
      expect(useSessionStore.getState().isStreaming).toBe(true);
      expect(useSessionStore.getState().isLoading).toBe(false);
      expect(useSessionStore.getState().lastStreamEventAt).toBeTypeOf('number');
    });

    it('should handle agent_end message', () => {
      const state = useSessionStore.getState();
      state.setStreaming(true);
      state.handleServerMessage({ type: 'agent_end' });
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().lastStreamEventAt).toBeNull();
    });

    it('should handle error message', () => {
      const state = useSessionStore.getState();
      state.setStreaming(true);
      state.setLoading(true);
      state.handleServerMessage({ type: 'error', message: 'Test error' });
      expect(useSessionStore.getState().error).toBe('Test error');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().isLoading).toBe(false);
    });

    it('surfaces the server-provided remediation message for Claude auth expiry errors', () => {
      const state = useSessionStore.getState();
      state.setStreaming(true);
      state.setLoading(true);

      // The server (claude-auth-errors.ts) now sends a backend/profile-aware
      // remediation message; the client displays it verbatim rather than a
      // hardcoded "Claude Direct" string.
      state.handleServerMessage({
        type: 'error',
        code: 'CLAUDE_AUTH_EXPIRED',
        message: 'Claude Code authentication has expired. Run `claude auth login` (or `/login`) on the server, then retry.',
      });

      const toasts = useUIStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({
        type: 'error',
        message: expect.stringContaining('claude auth login'),
      });
      expect(toasts[0].message).not.toContain('Claude Direct');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().isLoading).toBe(false);
    });

    it('surfaces Pi compaction and uses the SDK post-compaction estimate until a later usage update arrives', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      useSessionStore.setState({
        contextWindow: 372_000,
        contextUsed: 279_474,
        contextPercent: 75,
        sessionInfo: {
          sessionFile: undefined,
          sessionId: 'session-1',
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          contextWindow: 372_000,
          contextUsed: 279_474,
          contextPercent: 75,
        },
      });

      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: { type: 'compaction_start', reason: 'threshold' },
      });

      expect(useSessionStore.getState().isCompacting).toBe(true);
      expect(useSessionStore.getState().compactionReason).toBe('threshold');
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        type: 'info',
        message: expect.stringContaining('Auto-compacting'),
      });

      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: {
          type: 'compaction_end',
          reason: 'threshold',
          result: { tokensBefore: 279_474, estimatedTokensAfter: 20_293 },
          aborted: false,
          willRetry: false,
        },
      });

      expect(useSessionStore.getState()).toMatchObject({
        isCompacting: false,
        compactionReason: null,
        contextUsed: 20_293,
        contextPercent: 5,
      });
      expect(useSessionStore.getState().sessionInfo).toMatchObject({
        contextUsed: 20_293,
        contextPercent: 5,
      });
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        type: 'success',
        message: expect.stringContaining('estimated'),
      });

      state.handleServerMessage({
        type: 'context_update',
        sessionId: 'session-1',
        contextWindow: 372_000,
        contextUsed: 24_180,
        contextPercent: 7,
      });

      expect(useSessionStore.getState()).toMatchObject({
        contextUsed: 24_180,
        contextPercent: 7,
      });
    });

    it('should handle session_event error for current session', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      state.setLoading(true);
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: { type: 'error', message: '429 The service may be temporarily overloaded' },
      });
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('error');
      expect(useSessionStore.getState().error).toBe('429 The service may be temporarily overloaded');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().isLoading).toBe(false);
    });

    it('should handle session_event error for background session without affecting current session', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-2',
        event: { type: 'error', message: 'Background session error' },
      });
      expect(useSessionStore.getState().sessionData['session-2']?.status).toBe('error');
      // Current session should not be affected
      expect(useSessionStore.getState().error).toBeNull();
      expect(useSessionStore.getState().isStreaming).toBe(true);
    });

    it('should handle stale_stream_reset event by setting session idle and showing warning', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: { type: 'stale_stream_reset', message: 'Session reset from stale streaming state.' },
      });
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('idle');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().isLoading).toBe(false);
    });

    it('should handle api_error event with provider info', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: {
          type: 'api_error',
          message: "429 Sorry, you've exhausted this model's rate limit.",
          provider: 'github-copilot',
          model: 'claude-sonnet-4.6',
        },
      });
      // Session status should not change (api_error is informational only)
      expect(useSessionStore.getState().sessionData['session-1']?.status).not.toBe('error');
    });

    it('should persist api_error as a visible error message in the chat', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: {
          type: 'api_error',
          message: "429 Sorry, you've exhausted this model's rate limit.",
          provider: 'github-copilot',
          model: 'claude-sonnet-4.6',
        },
      });
      // Should add an error message to the messages array
      const msgs = useSessionStore.getState().messages;
      const errorMsg = msgs.find(m => m.error);
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.role).toBe('assistant');
      expect(errorMsg!.error!.message).toBe("429 Sorry, you've exhausted this model's rate limit.");
      expect(errorMsg!.error!.provider).toBe('github-copilot');
      expect(errorMsg!.error!.model).toBe('claude-sonnet-4.6');
    });

    it('should persist api_error message in sessionData for background sessions', () => {
      const state = useSessionStore.getState();
      // session-2 is NOT the current session
      state.setCurrentSession('session-1');
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-2',
        event: {
          type: 'api_error',
          message: 'API Error occurred',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
        },
      });
      // Should add error message to session-2's messages
      const session2Msgs = useSessionStore.getState().sessionMessages['session-2'];
      const errorMsg = session2Msgs?.find(m => m.error);
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.error!.message).toBe('API Error occurred');
      // Current session messages should NOT have the error
      const currentMsgs = useSessionStore.getState().messages;
      expect(currentMsgs.find(m => m.error)).toBeUndefined();
    });

    it('should handle raw JSONL message entries with stopReason=error during replay', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('session-1');
      // Simulate a raw JSONL entry being replayed as a session_event
      state.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: {
          type: 'message',
          message: {
            id: 'msg-err-1',
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: "429 Sorry, you've exhausted this model's rate limit.",
            provider: 'github-copilot',
            model: 'claude-sonnet-4.6',
          },
        },
      });
      // Should add an error message to the messages array
      const msgs = useSessionStore.getState().messages;
      const errorMsg = msgs.find(m => m.error);
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.error!.message).toBe("429 Sorry, you've exhausted this model's rate limit.");
    });

    it('should handle message_start message', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({
        type: 'message_start',
        message: { id: 'msg-1', role: 'user', content: 'Hello' },
      });
      expect(useSessionStore.getState().messages).toHaveLength(1);
      expect(useSessionStore.getState().messages[0].id).toBe('msg-1');
    });

    it('should handle tool_execution_start message', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        args: { path: '/test' },
      });
      expect(useSessionStore.getState().messages).toHaveLength(1);
      expect(useSessionStore.getState().messages[0].role).toBe('tool');
      expect(useSessionStore.getState().lastStreamEventAt).toBeTypeOf('number');
    });

    it('should handle extension_ui_request message', () => {
      const state = useSessionStore.getState();
      const request = {
        id: 'req-1',
        type: 'confirm',
        method: 'test',
        params: {},
        timeout: 30000,
      };
      state.handleServerMessage({
        type: 'extension_ui_request',
        request,
      });
      const stored = useSessionStore.getState().extensionUIRequest;
      expect(stored).toMatchObject(request);
      // Arrival time is stamped so a near-expiry deadline can be computed.
      expect(typeof stored?.receivedAt).toBe('number');
    });

    it('marks the open AskUserQuestion request expired on extension_ui_cancel (keeps it, with reason)', () => {
      const state = useSessionStore.getState();
      state.setExtensionUIRequest({
        id: 'req-auq',
        type: 'ask_user_question',
        method: 'claude.askUserQuestion',
        params: { questions: [] },
        timeout: 30000,
      });

      state.handleServerMessage({
        type: 'extension_ui_cancel',
        request: { id: 'req-auq', reason: 'timeout' },
      });

      const req = useSessionStore.getState().extensionUIRequest;
      // Not cleared — the dialog switches to an expired state so the user's
      // draft is preserved, not silently removed.
      expect(req).not.toBeNull();
      expect(req?.id).toBe('req-auq');
      expect(req?.expired).toBe(true);
      expect(req?.expiredReason).toBe('timeout');
    });

    it('ignores extension_ui_cancel for a non-matching request id', () => {
      const state = useSessionStore.getState();
      state.setExtensionUIRequest({
        id: 'req-auq',
        type: 'ask_user_question',
        method: 'claude.askUserQuestion',
        params: { questions: [] },
        timeout: 30000,
      });

      state.handleServerMessage({
        type: 'extension_ui_cancel',
        request: { id: 'req-other', reason: 'disconnected' },
      });

      const req = useSessionStore.getState().extensionUIRequest;
      expect(req?.expired).toBeFalsy();
    });

    it('shows a non-blocking toast for an ASK_ALREADY_CLOSED error (no global error state)', () => {
      const state = useSessionStore.getState();
      state.setStreaming(true);

      state.handleServerMessage({
        type: 'error',
        code: 'ASK_ALREADY_CLOSED',
        message: 'That question already closed, so your answer wasn\'t delivered to the assistant.',
      });

      const toasts = useUIStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toMatch(/already closed/i);
      // Non-blocking: no global error banner, streaming state untouched.
      expect(useSessionStore.getState().error).toBeNull();
      expect(useSessionStore.getState().isStreaming).toBe(true);
    });

    it('does not let an incoming transferred user message clear the ready marker', () => {
      const state = useSessionStore.getState();
      state.setCurrentSession('target-1');

      state.handleServerMessage({
        type: 'session_transfer_completed',
        sourceSessionId: 'source-1',
        targetSessionId: 'target-1',
        createdNewSession: false,
      });

      expect(useSessionStore.getState().transferReadySessionIds['target-1']).toBe(true);

      state.addMessage({
        id: 'user-1',
        role: 'user',
        content: 'Continue from the transferred context.',
        timestamp: Date.now(),
      });

      expect(useSessionStore.getState().transferReadySessionIds['target-1']).toBe(true);
      state.clearTransferReady('target-1');
      expect(useSessionStore.getState().transferReadySessionIds['target-1']).toBeUndefined();
    });

    it('ignores malformed transfer completion events', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({
        type: 'session_transfer_completed',
        sourceSessionId: 'source-1',
        targetSessionId: '',
        createdNewSession: 'false',
      } as never);

      expect(useSessionStore.getState().transferReadySessionIds).toEqual({});
      expect(useUIStore.getState().toasts).toEqual([]);
    });

    it('preserves transfer readiness when cached session data is removed', () => {
      const state = useSessionStore.getState();
      state.markTransferReady('target-1');
      state.clearSessionMessages('target-1');
      expect(useSessionStore.getState().transferReadySessionIds['target-1']).toBe(true);
    });

    it('preserves transfer readiness across a potentially stale session list refresh', () => {
      const state = useSessionStore.getState();
      state.markTransferReady('deleted-session');
      state.markTransferReady('kept-session');
      state.handleServerMessage({
        type: 'sessions_list',
        sessions: [{ id: 'kept-session', path: '/tmp/kept.jsonl', cwd: '/tmp' }],
      });

      expect(useSessionStore.getState().transferReadySessionIds).toEqual({
        'deleted-session': true,
        'kept-session': true,
      });
    });

    it('ignores malformed transfer failure events', () => {
      useSessionStore.getState().handleServerMessage({
        type: 'session_transfer_failed',
        sourceSessionId: 'source-1',
        code: '',
        message: 42,
      });
      expect(useTransferStore.getState().error).toBeNull();
    });

    it('should handle thinking_level_changed message', () => {
      const state = useSessionStore.getState();
      expect(state.currentThinkingLevel).toBeNull();
      state.handleServerMessage({ type: 'thinking_level_changed', level: 'high' });
      expect(useSessionStore.getState().currentThinkingLevel).toBe('high');
    });

    it('should handle session_switched with thinkingLevel', () => {
      const state = useSessionStore.getState();
      state.setSessions([{ id: 's1', path: '/p1', firstMessage: 'Hi', messageCount: 1, cwd: '/' }]);
      state.handleServerMessage({
        type: 'session_switched',
        sessionId: 's1',
        sessionPath: '/p1',
        model: 'anthropic/claude-sonnet-4',
        thinkingLevel: 'xhigh',
        messages: [],
      });
      expect(useSessionStore.getState().currentThinkingLevel).toBe('xhigh');
      expect(useSessionStore.getState().currentModel).toBe('anthropic/claude-sonnet-4');
    });

    it('should reset thinkingLevel to null on session_switched without thinkingLevel', () => {
      const state = useSessionStore.getState();
      useSessionStore.setState({ currentThinkingLevel: 'high' });
      state.setSessions([{ id: 's1', path: '/p1', firstMessage: 'Hi', messageCount: 1, cwd: '/' }]);
      state.handleServerMessage({
        type: 'session_switched',
        sessionId: 's1',
        sessionPath: '/p1',
        messages: [],
      });
      expect(useSessionStore.getState().currentThinkingLevel).toBeNull();
    });
  });

});
