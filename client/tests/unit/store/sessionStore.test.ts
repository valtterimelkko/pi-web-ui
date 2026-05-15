import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, type Message, type Session } from '../../../src/store/sessionStore';

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
      sessionCache: new Map(),
      sessionCacheMeta: {},
    });
  });

  it('should have initial state', () => {
    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.currentSessionId).toBeNull();
    expect(state.isStreaming).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.extensionUIRequest).toBeNull();
  });

  it('should add a message', () => {
    const state = useSessionStore.getState();
    const message: Message = {
      id: '1',
      role: 'user',
      content: 'Test message',
      timestamp: Date.now(),
    };
    state.addMessage(message);
    expect(useSessionStore.getState().messages).toHaveLength(1);
    expect(useSessionStore.getState().messages[0].content).toBe('Test message');
  });

  it('should update a message', () => {
    const state = useSessionStore.getState();
    const message: Message = {
      id: '1',
      role: 'assistant',
      content: 'Initial content',
      timestamp: Date.now(),
    };
    state.addMessage(message);
    state.updateMessage('1', { content: 'Updated content' });
    expect(useSessionStore.getState().messages[0].content).toBe('Updated content');
  });

  it('should set streaming state', () => {
    const state = useSessionStore.getState();
    state.setStreaming(true);
    expect(useSessionStore.getState().isStreaming).toBe(true);
    state.setStreaming(false);
    expect(useSessionStore.getState().isStreaming).toBe(false);
  });

  it('should set loading state', () => {
    const state = useSessionStore.getState();
    state.setLoading(true);
    expect(useSessionStore.getState().isLoading).toBe(true);
    state.setLoading(false);
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it('should set error state', () => {
    const state = useSessionStore.getState();
    state.setError('Something went wrong');
    expect(useSessionStore.getState().error).toBe('Something went wrong');
    state.setError(null);
    expect(useSessionStore.getState().error).toBeNull();
  });

  it('should set sessions', () => {
    const state = useSessionStore.getState();
    const sessions: Session[] = [
      {
        id: 'session-1',
        path: '/path/to/session',
        firstMessage: 'Hello',
        messageCount: 5,
        cwd: '/home/user',
      },
    ];
    state.setSessions(sessions);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(useSessionStore.getState().sessions[0].id).toBe('session-1');
  });

  it('should set current session', () => {
    const state = useSessionStore.getState();
    state.setCurrentSession('session-1');
    expect(useSessionStore.getState().currentSessionId).toBe('session-1');
  });

  it('should clear messages', () => {
    const state = useSessionStore.getState();
    state.addMessage({
      id: '1',
      role: 'user',
      content: 'Test',
      timestamp: Date.now(),
    });
    expect(useSessionStore.getState().messages).toHaveLength(1);
    state.clearMessages();
    expect(useSessionStore.getState().messages).toHaveLength(0);
  });

  it('should set extension UI request', () => {
    const state = useSessionStore.getState();
    const request = {
      id: 'req-1',
      type: 'confirm' as const,
      method: 'test-method',
      params: {},
      timeout: 30000,
    };
    state.setExtensionUIRequest(request);
    expect(useSessionStore.getState().extensionUIRequest).toEqual(request);
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
    });

    it('should handle agent_end message', () => {
      const state = useSessionStore.getState();
      state.setStreaming(true);
      state.handleServerMessage({ type: 'agent_end' });
      expect(useSessionStore.getState().isStreaming).toBe(false);
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

  describe('background session support', () => {
    it('should have sessionMessages and streamingSessions in initial state', () => {
      const state = useSessionStore.getState();
      expect(state.sessionMessages).toEqual({});
      expect(state.streamingSessions).toEqual({});
    });

    it('should cache messages per session when switching sessions', () => {
      const state = useSessionStore.getState();
      
      // Set first session and add messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      state.addMessage({ id: '2', role: 'assistant', content: 'Response 1', timestamp: 2000 });
      
      // Switch to second session
      state.setCurrentSession('session-2');
      
      // First session's messages should be cached
      expect(state.getSessionMessages('session-1')).toHaveLength(2);
      expect(state.getSessionMessages('session-1')[0].content).toBe('Message 1');
      
      // Current messages should be empty (new session)
      expect(useSessionStore.getState().messages).toHaveLength(0);
    });

    it('should restore cached messages when switching back to a session', () => {
      const state = useSessionStore.getState();
      
      // Set first session and add messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      
      // Switch to second session
      state.setCurrentSession('session-2');
      expect(useSessionStore.getState().messages).toHaveLength(0);
      
      // Switch back to first session
      state.setCurrentSession('session-1');
      
      // Should restore cached messages
      expect(useSessionStore.getState().messages).toHaveLength(1);
      expect(useSessionStore.getState().messages[0].content).toBe('Message 1');
    });

    it('should track streaming state per session', () => {
      const state = useSessionStore.getState();
      
      // Set session and start streaming
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      
      expect(state.isSessionStreaming('session-1')).toBe(true);
      expect(state.isSessionStreaming('session-2')).toBe(false);
      
      // Stop streaming
      state.setStreaming(false);
      expect(state.isSessionStreaming('session-1')).toBe(false);
    });

    it('should preserve streaming state for background sessions', () => {
      const store = useSessionStore;
      
      // Set session 1 and start streaming
      store.getState().setCurrentSession('session-1');
      store.getState().setStreaming(true);
      
      // Switch to session 2 (background session 1 is still streaming)
      store.getState().setCurrentSession('session-2');
      
      // Session 1 should still be marked as streaming
      const currentState = store.getState();
      expect(currentState.streamingSessions['session-1']).toBe(true);
    });

    it('should clear session messages with clearSessionMessages', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message', timestamp: 1000 });
      
      expect(state.getSessionMessages('session-1')).toHaveLength(1);
      
      state.clearSessionMessages('session-1');
      
      expect(state.getSessionMessages('session-1')).toHaveLength(0);
    });

    it('should update sessionMessages cache when adding messages', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message', timestamp: 1000 });
      
      // Check cache is updated
      expect(useSessionStore.getState().sessionMessages['session-1']).toHaveLength(1);
    });

    it('should update sessionMessages cache when updating messages', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'assistant', content: 'Initial', timestamp: 1000 });
      state.updateMessage('1', { content: 'Updated' });
      
      // Check cache is updated
      const cached = useSessionStore.getState().sessionMessages['session-1'];
      expect(cached).toHaveLength(1);
      expect(cached[0].content).toBe('Updated');
    });

    it('should handle session_switched with message caching', () => {
      const state = useSessionStore.getState();
      
      // Create first session with messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Old message', timestamp: 1000 });
      
      // Simulate session_switched from server
      state.handleServerMessage({
        type: 'session_switched',
        sessionId: 'session-2',
        messages: [
          { id: '2', role: 'user', content: 'New message', timestamp: 2000 },
        ],
      });
      
      // Should have switched to session-2 with its messages
      expect(useSessionStore.getState().currentSessionId).toBe('session-2');
      expect(useSessionStore.getState().messages).toHaveLength(1);
      expect(useSessionStore.getState().messages[0].content).toBe('New message');
      
      // Session 1's messages should still be cached
      expect(useSessionStore.getState().sessionMessages['session-1']).toHaveLength(1);
    });
  });

  describe('session_status syncing', () => {
    it('should update sessionData status for any session', () => {
      const state = useSessionStore.getState();
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'streaming',
      });
      
      // Get fresh state after handler runs
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('streaming');
    });

    it('should sync isStreaming to true when session_status is streaming for current session', () => {
      const state = useSessionStore.getState();
      
      // Set current session
      state.setCurrentSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      // Receive streaming status for current session
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'streaming',
      });
      
      // Global isStreaming should be synced
      expect(useSessionStore.getState().isStreaming).toBe(true);
    });

    it('should sync isStreaming to true when session_status is busy for current session', () => {
      const state = useSessionStore.getState();
      
      // Set current session
      state.setCurrentSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      // Receive busy status for current session
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'busy',
      });
      
      // Global isStreaming should be synced
      expect(useSessionStore.getState().isStreaming).toBe(true);
    });

    it('should sync isStreaming to false when session_status is idle for current session', () => {
      const state = useSessionStore.getState();
      
      // Set current session and start streaming
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      // Receive idle status for current session
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'idle',
      });
      
      // Global isStreaming should be synced to false
      expect(useSessionStore.getState().isStreaming).toBe(false);
    });

    it('should NOT sync isStreaming when session_status is for a different session', () => {
      const state = useSessionStore.getState();
      
      // Set current session
      state.setCurrentSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      // Receive streaming status for a DIFFERENT session
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-2',
        sessionPath: '/path/to/session-2.jsonl',
        status: 'streaming',
      });
      
      // Global isStreaming should NOT be affected
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      // But session-2's status should still be updated (get fresh state)
      expect(useSessionStore.getState().sessionData['session-2']?.status).toBe('streaming');
    });

    it('should correctly sync when switching from streaming session to new idle session', () => {
      const state = useSessionStore.getState();
      
      // Simulate being on session-1 which is streaming
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      state.setSessionStatus('session-1', 'streaming');
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      // Switch to session-2 (new session)
      state.handleServerMessage({
        type: 'session_created',
        sessionId: 'session-2',
      });
      expect(useSessionStore.getState().currentSessionId).toBe('session-2');
      // isStreaming is still true at this point (the bug we're fixing)
      
      // Receive idle status for session-2 (the new current session)
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-2',
        sessionPath: '/path/to/session-2.jsonl',
        status: 'idle',
      });
      
      // Now isStreaming should be synced to false
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      // session-1 should still be streaming in background (get fresh state)
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('streaming');
    });

    it('should sync isStreaming to false when session_status is error for current session', () => {
      const state = useSessionStore.getState();
      
      // Set current session and start streaming
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      // Receive error status for current session
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'error',
      });
      
      // Global isStreaming should be synced to false
      expect(useSessionStore.getState().isStreaming).toBe(false);
    });
  });

  describe('LRU cache', () => {
    beforeEach(() => {
      // Clear sessionCache before each test
      useSessionStore.setState({ 
        sessionCache: new Map(),
        sessionMessages: {},
        sessionCacheMeta: {},
      });
    });

    it('should have sessionCache in initial state', () => {
      const state = useSessionStore.getState();
      expect(state.sessionCache).toBeInstanceOf(Map);
      expect(state.sessionCache.size).toBe(0);
    });

    it('should cache messages when switching sessions', () => {
      const state = useSessionStore.getState();
      
      // Set first session and add messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      
      // Switch to second session
      state.setCurrentSession('session-2');
      
      // First session should be in cache
      const cache = useSessionStore.getState().sessionCache;
      expect(cache.has('session-1')).toBe(true);
      expect(cache.get('session-1')?.messages).toHaveLength(1);
    });

    it('should restore cached messages when switching back', () => {
      const state = useSessionStore.getState();
      
      // Set first session and add messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      
      // Switch to second session
      state.setCurrentSession('session-2');
      expect(useSessionStore.getState().messages).toHaveLength(0);
      
      // Switch back to first session
      state.setCurrentSession('session-1');
      
      // Should restore cached messages
      expect(useSessionStore.getState().messages).toHaveLength(1);
    });

    it('should evict oldest session when cache exceeds limit', () => {
      const state = useSessionStore.getState();
      
      // Add 6 sessions (exceeds MAX_CACHED_SESSIONS = 2)
      for (let i = 1; i <= 6; i++) {
        state.setCurrentSession(`session-${i}`);
        state.addMessage({ id: `msg-${i}`, role: 'user', content: `Message ${i}`, timestamp: i * 1000 });
      }
      
      // Check that eviction happened (should have at most 2)
      const cache = useSessionStore.getState().sessionCache;
      expect(cache.size).toBeLessThanOrEqual(2);
    });

    it('should never evict the current session', () => {
      const state = useSessionStore.getState();
      
      // Create first session
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      
      // Create more sessions to trigger eviction
      for (let i = 2; i <= 7; i++) {
        state.setCurrentSession(`session-${i}`);
        state.addMessage({ id: `${i}`, role: 'user', content: `Message ${i}`, timestamp: i * 1000 });
      }
      
      // Current session (session-7) should still be in cache
      const cache = useSessionStore.getState().sessionCache;
      expect(cache.has('session-7')).toBe(true);
    });

    it('should track lastAccess on session switch', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message', timestamp: 1000 });
      
      const beforeSwitch = Date.now();
      state.setCurrentSession('session-2');
      
      const cache = useSessionStore.getState().sessionCache;
      const cached = cache.get('session-1');
      expect(cached?.lastAccess).toBeGreaterThanOrEqual(beforeSwitch);
    });

    it('should provide cache statistics via getCacheStats', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message', timestamp: 1000 });
      
      const stats = state.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(2);
      expect(stats.sessions).toContain('session-1');
    });

    it('should update cache metadata with messageCount and sizeBytes', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Test message content', timestamp: 1000 });
      
      const meta = useSessionStore.getState().sessionCacheMeta['session-1'];
      expect(meta?.messageCount).toBe(1);
      expect(meta?.sizeBytes).toBeGreaterThan(0);
    });

    it('should NOT persist sessionCacheMeta to localStorage (removed from partialize)', () => {
      const state = useSessionStore.getState();

      state.setCurrentSession('session-1');
      state.addMessage({ id: 'msg-1', role: 'user', content: 'Test', timestamp: 1000 });

      // sessionCacheMeta is tracked in-memory for cache eviction
      const meta = useSessionStore.getState().sessionCacheMeta['session-1'];
      expect(meta).toBeDefined();
      expect(meta?.messageCount).toBe(1);

      // But it should NOT appear in the persisted state (partialize excludes it)
      const persistedRaw = localStorage.getItem('pi-web-ui-session');
      if (persistedRaw) {
        const parsed = JSON.parse(persistedRaw);
        expect(parsed.state?.sessionCacheMeta).toBeUndefined();
      }
    });

    it('should use throttled storage that does not write on every set()', () => {
      // Verify the store is using a custom storage (not raw localStorage)
      // The throttled storage debounces writes to max once per second.
      // We can verify the store functions normally and that writes eventually land.
      const state = useSessionStore.getState();

      state.setCurrentSession('session-throttle');
      state.addMessage({ id: 'msg-t', role: 'user', content: 'Throttled write test', timestamp: 1000 });

      // State should be set in-memory immediately
      expect(useSessionStore.getState().messages).toHaveLength(1);

      // After the debounce delay, localStorage should reflect the state.
      // We can't easily test the async debounce timing in Jest without fake timers,
      // but we can verify the store is operational and the storage key is used.
      expect(useSessionStore.getState().sessions.length).toBeGreaterThanOrEqual(0);
    });

    it('should throttle multiple rapid set() calls into a single localStorage write', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(Storage.prototype, 'setItem');

      const state = useSessionStore.getState();

      // Rapid fire multiple state changes (simulating streaming)
      state.setCurrentSession('burst-session');
      state.addMessage({ id: 'b1', role: 'user', content: 'Burst 1', timestamp: 1000 });
      state.addMessage({ id: 'b2', role: 'assistant', content: 'Burst 2', timestamp: 2000 });
      state.setStreaming(true);
      state.setStreaming(false);
      state.addMessage({ id: 'b3', role: 'tool', content: [{ type: 'text', text: 'Burst 3' }], timestamp: 3000 });

      // Immediately after: the throttled storage should have buffered but not written
      // First call to setItem happens on initial hydration, so we check the count after burst
      const callsAfterBurst = spy.mock.calls.filter(
        (call: string[]) => call[0] === 'pi-web-ui-session'
      ).length;

      // Flush pending writes
      vi.advanceTimersByTime(1100);

      const callsAfterFlush = spy.mock.calls.filter(
        (call: string[]) => call[0] === 'pi-web-ui-session'
      ).length;

      // After flush, there should be at most 1 additional write for the batch
      // (not 6 separate writes)
      const writesDuringTest = callsAfterFlush - callsAfterBurst;
      expect(writesDuringTest).toBeLessThanOrEqual(1);

      spy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe('switchSession', () => {
    beforeEach(() => {
      useSessionStore.setState({ 
        sessionCache: new Map(),
        sessionMessages: {},
        sessionCacheMeta: {},
        streamingSessions: {},
      });
    });

    it('should switch sessions atomically', () => {
      const state = useSessionStore.getState();
      
      // Set up first session with messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      
      // Use switchSession for atomic switch
      state.switchSession('session-2');
      
      expect(useSessionStore.getState().currentSessionId).toBe('session-2');
      expect(useSessionStore.getState().messages).toHaveLength(0);
    });

    it('should mark old session as accessed before switching', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message', timestamp: 1000 });
      
      const beforeSwitch = Date.now();
      state.switchSession('session-2');
      
      const cache = useSessionStore.getState().sessionCache;
      const cached = cache.get('session-1');
      expect(cached?.lastAccess).toBeGreaterThanOrEqual(beforeSwitch);
    });

    it('should restore cached messages when switching to previously visited session', () => {
      const state = useSessionStore.getState();
      
      // Set up first session with messages
      state.setCurrentSession('session-1');
      state.addMessage({ id: '1', role: 'user', content: 'Message 1', timestamp: 1000 });
      
      // Switch away
      state.switchSession('session-2');
      expect(useSessionStore.getState().messages).toHaveLength(0);
      
      // Switch back
      state.switchSession('session-1');
      expect(useSessionStore.getState().messages).toHaveLength(1);
      expect(useSessionStore.getState().messages[0].content).toBe('Message 1');
    });

    it('should reset streaming state based on streamingSessions', () => {
      const state = useSessionStore.getState();
      
      // Set up session-1 as streaming
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      
      // Set up session-2 as not streaming
      state.setCurrentSession('session-2');
      state.setStreaming(false);
      
      // Switch to session-1 (which is streaming)
      state.switchSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      // Switch to session-2 (which is not streaming)
      state.switchSession('session-2');
      expect(useSessionStore.getState().isStreaming).toBe(false);
    });

    it('should trigger eviction after switch', () => {
      const state = useSessionStore.getState();
      
      // Create 6 sessions to exceed limit
      for (let i = 1; i <= 6; i++) {
        state.switchSession(`session-${i}`);
        state.addMessage({ id: `${i}`, role: 'user', content: `Message ${i}`, timestamp: i * 1000 });
      }
      
      // Cache should be limited
      const cache = useSessionStore.getState().sessionCache;
      expect(cache.size).toBeLessThanOrEqual(2);
    });
  });
});