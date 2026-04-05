import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, type Session } from '../../../src/store/sessionStore';

describe('sessionStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    const state = useSessionStore.getState();
    state.setSessions([]);
    state.setCurrentSession(null);
    state.setStreaming(false);
    state.setLoading(false);
    state.setError(null);
    state.setExtensionUIRequest(null);
    // Clear session data directly
    useSessionStore.setState({ 
      currentSessionId: null,
      isStreaming: false,
      isLoading: false,
      error: null,
      sessionData: {},
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

    it('session_event with message_start does NOT modify store state', () => {
      // session_event with message type events should be no-ops — 
      // those are handled by useSessionStream
      const stateBefore = useSessionStore.getState();
      const { sessions, currentSessionId, isStreaming, sessionInfo, contextPercent } = stateBefore;
      
      stateBefore.handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: {
          type: 'message_start',
          message: { id: 'msg-1', role: 'user', content: 'Hello' },
        },
      });

      const stateAfter = useSessionStore.getState();
      expect(stateAfter.sessions).toEqual(sessions);
      expect(stateAfter.currentSessionId).toBe(currentSessionId);
      expect(stateAfter.isStreaming).toBe(isStreaming);
      expect(stateAfter.sessionInfo).toEqual(sessionInfo);
      expect(stateAfter.contextPercent).toBe(contextPercent);
    });

    it('session_event with agent_start updates isStreaming for current session', () => {
      useSessionStore.setState({ currentSessionId: 'session-1' });
      expect(useSessionStore.getState().isStreaming).toBe(false);

      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: { type: 'agent_start' },
      });

      expect(useSessionStore.getState().isStreaming).toBe(true);
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('streaming');
    });

    it('session_event with agent_start does NOT update isStreaming for non-current session', () => {
      useSessionStore.setState({ currentSessionId: 'session-1' });
      
      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId: 'session-2',
        event: { type: 'agent_start' },
      });

      // Global isStreaming should not change for non-current session
      expect(useSessionStore.getState().isStreaming).toBe(false);
      // But session-2's status should be updated
      expect(useSessionStore.getState().sessionData['session-2']?.status).toBe('streaming');
    });

    it('session_event with agent_end updates isStreaming for current session', () => {
      useSessionStore.setState({ currentSessionId: 'session-1' });
      useSessionStore.setState({ isStreaming: true });

      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId: 'session-1',
        event: { type: 'agent_end' },
      });

      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('idle');
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
      
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('streaming');
    });

    it('should sync isStreaming to true when session_status is streaming for current session', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'streaming',
      });
      
      expect(useSessionStore.getState().isStreaming).toBe(true);
    });

    it('should sync isStreaming to true when session_status is busy for current session', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'busy',
      });
      
      expect(useSessionStore.getState().isStreaming).toBe(true);
    });

    it('should sync isStreaming to false when session_status is idle for current session', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'idle',
      });
      
      expect(useSessionStore.getState().isStreaming).toBe(false);
    });

    it('should NOT sync isStreaming when session_status is for a different session', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      expect(useSessionStore.getState().isStreaming).toBe(false);
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-2',
        sessionPath: '/path/to/session-2.jsonl',
        status: 'streaming',
      });
      
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().sessionData['session-2']?.status).toBe('streaming');
    });

    it('should correctly sync when switching from streaming session to new idle session', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      state.setSessionStatus('session-1', 'streaming');
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      state.handleServerMessage({
        type: 'session_created',
        sessionId: 'session-2',
      });
      expect(useSessionStore.getState().currentSessionId).toBe('session-2');
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-2',
        sessionPath: '/path/to/session-2.jsonl',
        status: 'idle',
      });
      
      expect(useSessionStore.getState().isStreaming).toBe(false);
      expect(useSessionStore.getState().sessionData['session-1']?.status).toBe('streaming');
    });

    it('should sync isStreaming to false when session_status is error for current session', () => {
      const state = useSessionStore.getState();
      
      state.setCurrentSession('session-1');
      state.setStreaming(true);
      expect(useSessionStore.getState().isStreaming).toBe(true);
      
      state.handleServerMessage({
        type: 'session_status',
        sessionId: 'session-1',
        sessionPath: '/path/to/session-1.jsonl',
        status: 'error',
      });
      
      expect(useSessionStore.getState().isStreaming).toBe(false);
    });
  });

  describe('switchSession', () => {
    beforeEach(() => {
      useSessionStore.setState({ 
        sessionData: {},
      });
    });

    it('should switch sessions', () => {
      const state = useSessionStore.getState();
      state.switchSession('session-2');
      
      expect(useSessionStore.getState().currentSessionId).toBe('session-2');
    });

    it('should reset streaming state on switch', () => {
      const state = useSessionStore.getState();
      state.setStreaming(true);
      expect(useSessionStore.getState().isStreaming).toBe(true);

      state.switchSession('session-2');
      expect(useSessionStore.getState().isStreaming).toBe(false);
    });
  });

  describe('sessionData', () => {
    it('should have empty sessionData initially', () => {
      const state = useSessionStore.getState();
      expect(state.sessionData).toEqual({});
    });

    it('should update sessionData via updateSessionData', () => {
      const state = useSessionStore.getState();
      state.updateSessionData('session-1', { status: 'streaming', contextPercent: 50 });
      
      const data = useSessionStore.getState().sessionData['session-1'];
      expect(data?.status).toBe('streaming');
      expect(data?.contextPercent).toBe(50);
      expect(data?.lastEventTimestamp).toBeGreaterThan(0);
    });

    it('should preserve existing sessionData when partially updating', () => {
      const state = useSessionStore.getState();
      state.updateSessionData('session-1', { status: 'streaming', contextPercent: 50 });
      state.updateSessionData('session-1', { contextPercent: 75 });
      
      const data = useSessionStore.getState().sessionData['session-1'];
      expect(data?.status).toBe('streaming'); // preserved
      expect(data?.contextPercent).toBe(75); // updated
    });
  });

  describe('worker status', () => {
    it('should track worker status', () => {
      const state = useSessionStore.getState();
      state.updateWorkerStatus('session-1', 'ready');
      
      expect(useSessionStore.getState().workerStatus['session-1']).toBe('ready');
      expect(useSessionStore.getState().activeWorkers).toContain('session-1');
    });

    it('should remove worker status', () => {
      const state = useSessionStore.getState();
      state.updateWorkerStatus('session-1', 'ready');
      state.removeWorkerStatus('session-1');
      
      expect(useSessionStore.getState().workerStatus['session-1']).toBeUndefined();
      expect(useSessionStore.getState().activeWorkers).not.toContain('session-1');
    });

    it('should not include terminated/error workers in activeWorkers', () => {
      const state = useSessionStore.getState();
      state.updateWorkerStatus('session-1', 'error');
      state.updateWorkerStatus('session-2', 'terminated');
      
      expect(useSessionStore.getState().activeWorkers).not.toContain('session-1');
      expect(useSessionStore.getState().activeWorkers).not.toContain('session-2');
    });
  });
});
