import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore, type Session } from '../../../src/store/sessionStore';
import { useUIStore } from '../../../src/store/uiStore';

// Reset stores before each test
beforeEach(() => {
  // Reset session store
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    isStreaming: false,
    isLoading: false,
    error: null,
    sessionData: {},
    claudeAvailable: false,
    claudeAuthError: null,
  });

  // Reset UI store toasts
  useUIStore.setState({ toasts: [] });
});

describe('sessionStore dual-SDK additions', () => {
  // ─── setClaudeAvailable ───────────────────────────────────────────────────

  describe('setClaudeAvailable', () => {
    it('setClaudeAvailable(true) sets claudeAvailable: true', () => {
      const state = useSessionStore.getState();
      state.setClaudeAvailable(true);
      expect(useSessionStore.getState().claudeAvailable).toBe(true);
      expect(useSessionStore.getState().claudeAuthError).toBeNull();
    });

    it('setClaudeAvailable(false, msg) sets claudeAvailable: false and claudeAuthError', () => {
      const state = useSessionStore.getState();
      state.setClaudeAvailable(false, 'Not authenticated');
      expect(useSessionStore.getState().claudeAvailable).toBe(false);
      expect(useSessionStore.getState().claudeAuthError).toBe('Not authenticated');
    });

    it('setClaudeAvailable(true) clears previous error', () => {
      useSessionStore.setState({ claudeAvailable: false, claudeAuthError: 'old error' });
      useSessionStore.getState().setClaudeAvailable(true);
      expect(useSessionStore.getState().claudeAvailable).toBe(true);
      expect(useSessionStore.getState().claudeAuthError).toBeNull();
    });
  });

  // ─── claude_available server message ─────────────────────────────────────

  describe('claude_available server message', () => {
    it('handles claude_available message with available: true', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({ type: 'claude_available', available: true });
      expect(useSessionStore.getState().claudeAvailable).toBe(true);
    });

    it('handles claude_available message with available: false and error', () => {
      const state = useSessionStore.getState();
      state.handleServerMessage({
        type: 'claude_available',
        available: false,
        error: 'Auth failed',
      });
      expect(useSessionStore.getState().claudeAvailable).toBe(false);
      expect(useSessionStore.getState().claudeAuthError).toBe('Auth failed');
    });
  });

  // ─── sdkType in session list ──────────────────────────────────────────────

  describe('session list with sdkType', () => {
    it('session with sdkType: claude is included in session list', () => {
      const state = useSessionStore.getState();
      const sessions: Session[] = [
        {
          id: 'pi-session-1',
          path: '/pi/path',
          firstMessage: 'Pi hello',
          messageCount: 2,
          cwd: '/',
          sdkType: 'pi',
        } as Session,
        {
          id: 'claude-session-1',
          path: '/claude/path',
          firstMessage: 'Claude hello',
          messageCount: 3,
          cwd: '/',
          sdkType: 'claude',
        } as Session,
      ];

      state.handleServerMessage({ type: 'sessions_list', sessions });

      const stored = useSessionStore.getState().sessions;
      expect(stored).toHaveLength(2);

      const claudeSession = stored.find((s) => s.id === 'claude-session-1');
      expect(claudeSession).toBeDefined();
      expect((claudeSession as Session & { sdkType?: string }).sdkType).toBe('claude');
    });
  });

  // ─── history_end ─────────────────────────────────────────────────────────

  describe('history_end', () => {
    it('history_end sets session status to idle', () => {
      const sessionId = 'session-replay-2';

      // Set session status to something else first
      useSessionStore.getState().setSessionStatus(sessionId, 'streaming');

      useSessionStore.getState().handleServerMessage({
        type: 'history_end',
        sessionId,
      });

      const sessionData = useSessionStore.getState().sessionData[sessionId];
      expect(sessionData?.status).toBe('idle');
    });
  });

  // ─── session_event: session_init ─────────────────────────────────────────

  describe('session_event: session_init', () => {
    it('session_init event updates session model', () => {
      const sessionId = 'session-with-model';

      // Add session to the list
      useSessionStore.setState({
        sessions: [
          {
            id: sessionId,
            path: '/some/path',
            firstMessage: 'hi',
            messageCount: 1,
            cwd: '/',
          } as Session,
        ],
      });

      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId,
        event: {
          type: 'session_init',
          model: 'claude-opus-4-6',
          tools: ['Read', 'Write'],
        },
      });

      const updatedSession = useSessionStore
        .getState()
        .sessions.find((s) => s.id === sessionId);
      expect((updatedSession as Session & { model?: string })?.model).toBe('claude-opus-4-6');
    });
  });

  // ─── session_event: rate_limit ────────────────────────────────────────────

  describe('session_event: rate_limit', () => {
    it('rate_limit event stores quotaInfo in sessionData', () => {
      const sessionId = 'session-rate-limit';

      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId,
        event: {
          type: 'rate_limit',
          status: 'allowed',
          rateLimitType: 'five_hour',
          isUsingOverage: false,
          resetsAt: 1000000,
        },
      });

      const sessionData = useSessionStore.getState().sessionData[sessionId];
      expect(sessionData?.quotaInfo).toBeDefined();
      expect(sessionData!.quotaInfo!.status).toBe('allowed');
      expect(sessionData!.quotaInfo!.rateLimitType).toBe('five_hour');
      expect(sessionData!.quotaInfo!.isUsingOverage).toBe(false);
    });

    it('rate_limit with isUsingOverage: true triggers a toast on active session', () => {
      const sessionId = 'session-overage';

      // Make it the current session
      useSessionStore.setState({ currentSessionId: sessionId });

      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId,
        event: {
          type: 'rate_limit',
          status: 'allowed',
          rateLimitType: 'five_hour',
          isUsingOverage: true,
          resetsAt: 1000000,
        },
      });

      const toasts = useUIStore.getState().toasts;
      const warningToast = toasts.find((t) => t.type === 'warning');
      expect(warningToast).toBeDefined();
      expect(warningToast!.message).toMatch(/overage/i);
    });

    it('rate_limit with isUsingOverage: true does NOT toast for non-active session', () => {
      const sessionId = 'session-inactive-overage';

      // Different session is active
      useSessionStore.setState({ currentSessionId: 'other-session' });

      useSessionStore.getState().handleServerMessage({
        type: 'session_event',
        sessionId,
        event: {
          type: 'rate_limit',
          status: 'allowed',
          rateLimitType: 'five_hour',
          isUsingOverage: true,
          resetsAt: 1000000,
        },
      });

      // No toast should be shown for an inactive session
      const toasts = useUIStore.getState().toasts;
      expect(toasts).toHaveLength(0);
    });
  });
});
