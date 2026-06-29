import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useSessionStore, type Message, type Session } from '../../../src/store/sessionStore';
import { useUIStore } from '../../../src/store/uiStore';

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
      expect(useSessionStore.getState().extensionUIRequest).toEqual(request);
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
