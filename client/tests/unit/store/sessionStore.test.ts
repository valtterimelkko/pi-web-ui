import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, type Message, type Session } from '../../src/store/sessionStore';

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
  });
});
