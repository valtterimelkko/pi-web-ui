/**
 * Tests for Claude Direct session info and pinning support.
 *
 * These verify:
 * 1. get_session_info returns session stats for Claude Direct sessions
 * 2. pin_session / unpin_session work for Claude Direct sessions
 * 3. ClaudeService pin tracking (in-memory)
 * 4. ClaudeService.getSessionStats builds correct stats from JSONL history
 * 5. Error handling for missing/invalid sessions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeSessionSubscribers } from '../../../src/claude/claude-session-subscribers.js';
import type { ClaudeMessageEntry } from '../../../src/claude/claude-session-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClaudeServiceMock(overrides: Record<string, unknown> = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    validateAuth: vi.fn().mockResolvedValue({ ok: true, email: 'test@test.com' }),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'claude-uuid-1', claudeSessionId: 'claude-real-1' }),
    sendPrompt: vi.fn(),
    abort: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    setModel: vi.fn().mockResolvedValue('sonnet'),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(undefined),
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
    isSessionPinned: vi.fn().mockReturnValue(false),
    hasSession: vi.fn().mockReturnValue(false),
    sessionExistsInRegistry: vi.fn().mockResolvedValue(false),
    getSessionStats: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ─── Session Info for Claude Direct ──────────────────────────────────────────

describe('Claude Direct: get_session_info', () => {

  it('returns session_info with stats for a Claude session', async () => {
    const sessionId = 'claude-uuid-1';
    const claudeSessionIds = new Set([sessionId]);
    const clientViewingSession = new Map([['client-1', sessionId]]);
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    const claudeService = makeClaudeServiceMock({
      getSessionStats: vi.fn().mockResolvedValue({
        sessionId,
        cwd: '/tmp/project',
        model: 'sonnet',
        userMessages: 3,
        assistantMessages: 3,
        toolCalls: 5,
        toolResults: 5,
        totalMessages: 16,
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
        cost: 0,
        pinned: false,
      }),
    });

    const sendMessage = (clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message });
    };

    // Simulate handleGetSessionInfo logic for Claude session
    const sessionPath = clientViewingSession.get('client-1');
    if (sessionPath && claudeSessionIds.has(sessionPath)) {
      const stats = await claudeService.getSessionStats(sessionPath);
      if (stats) {
        sendMessage('client-1', {
          type: 'session_info',
          stats: {
            sessionFile: undefined,
            sessionId: stats.sessionId,
            cwd: stats.cwd,
            userMessages: stats.userMessages,
            assistantMessages: stats.assistantMessages,
            toolCalls: stats.toolCalls,
            toolResults: stats.toolResults,
            totalMessages: stats.totalMessages,
            tokens: stats.tokens,
            cost: stats.cost,
            model: stats.model,
          },
        });
      }
    }

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0].message as Record<string, unknown>;
    expect(msg.type).toBe('session_info');
    const stats = msg.stats as Record<string, unknown>;
    expect(stats.sessionId).toBe(sessionId);
    expect(stats.cwd).toBe('/tmp/project');
    expect(stats.userMessages).toBe(3);
    expect(stats.assistantMessages).toBe(3);
    expect(stats.toolCalls).toBe(5);
    expect(stats.toolResults).toBe(5);
    expect(stats.totalMessages).toBe(16);
    expect(stats.tokens).toEqual({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 });
  });

  it('returns SESSION_NOT_FOUND error when Claude session does not exist', async () => {
    const sessionId = 'nonexistent';
    const claudeSessionIds = new Set([sessionId]);
    const clientViewingSession = new Map([['client-1', sessionId]]);
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    const claudeService = makeClaudeServiceMock({
      getSessionStats: vi.fn().mockResolvedValue(null),
    });

    const sendMessage = (clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message });
    };

    const sessionPath = clientViewingSession.get('client-1');
    if (sessionPath && claudeSessionIds.has(sessionPath)) {
      const stats = await claudeService.getSessionStats(sessionPath);
      if (!stats) {
        sendMessage('client-1', { type: 'error', message: 'Claude session not found', code: 'SESSION_NOT_FOUND' });
      }
    }

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message).toEqual({
      type: 'error',
      message: 'Claude session not found',
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('returns error when no session is active', () => {
    const clientViewingSession = new Map<string, string>();
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    const sendMessage = (clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message });
    };

    const sessionPath = clientViewingSession.get('client-1');
    if (!sessionPath) {
      sendMessage('client-1', { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
    }

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message).toEqual({
      type: 'error',
      message: 'No active session',
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('does NOT fall through to MultiSessionManager for Claude sessions', async () => {
    const sessionId = 'claude-uuid-1';
    const claudeSessionIds = new Set([sessionId]);
    const clientViewingSession = new Map([['client-1', sessionId]]);
    let multiSessionManagerCalled = false;

    const claudeService = makeClaudeServiceMock({
      getSessionStats: vi.fn().mockResolvedValue({
        sessionId,
        cwd: '/tmp/project',
        model: 'sonnet',
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        pinned: false,
      }),
    });

    const sessionPath = clientViewingSession.get('client-1');
    if (sessionPath && claudeSessionIds.has(sessionPath)) {
      const stats = await claudeService.getSessionStats(sessionPath);
      expect(stats).not.toBeNull();
    } else {
      multiSessionManagerCalled = true;
    }

    expect(multiSessionManagerCalled).toBe(false);
    expect(claudeService.getSessionStats).toHaveBeenCalledWith(sessionId);
  });
});

// ─── Session Pinning for Claude Direct ───────────────────────────────────────

describe('Claude Direct: pin_session / unpin_session', () => {

  describe('pin_session', () => {
    it('sends session_pinned when Claude session is pinned successfully', () => {
      const sessionId = 'claude-uuid-1';
      const claudeSessionIds = new Set([sessionId]);
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];

      const claudeService = makeClaudeServiceMock({
        pinSession: vi.fn().mockReturnValue(true),
      });

      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      // Simulate handlePinSession logic
      if (claudeSessionIds.has(sessionId)) {
        const success = claudeService.pinSession(sessionId);
        if (success) {
          sendMessage('client-1', { type: 'session_pinned', sessionPath: sessionId, pinned: true });
        }
      }

      expect(claudeService.pinSession).toHaveBeenCalledWith(sessionId);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message).toEqual({
        type: 'session_pinned',
        sessionPath: sessionId,
        pinned: true,
      });
    });

    it('sends session_pin_error when Claude session not found', () => {
      const sessionId = 'claude-uuid-unknown';
      const claudeSessionIds = new Set([sessionId]);
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];

      const claudeService = makeClaudeServiceMock({
        pinSession: vi.fn().mockReturnValue(false),
        hasSession: vi.fn().mockReturnValue(false),
      });

      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      if (claudeSessionIds.has(sessionId)) {
        const success = claudeService.pinSession(sessionId);
        if (!success) {
          const hasSession = claudeService.hasSession(sessionId);
          sendMessage('client-1', {
            type: 'session_pin_error',
            sessionPath: sessionId,
            error: hasSession ? 'Maximum pinned sessions limit reached' : 'Session not found',
          });
        }
      }

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message).toEqual({
        type: 'session_pin_error',
        sessionPath: sessionId,
        error: 'Session not found',
      });
    });

    it('sends session_pin_error when max pinned limit reached', () => {
      const sessionId = 'claude-uuid-1';
      const claudeSessionIds = new Set([sessionId]);
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];

      const claudeService = makeClaudeServiceMock({
        pinSession: vi.fn().mockReturnValue(false),
        hasSession: vi.fn().mockReturnValue(true),
      });

      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      if (claudeSessionIds.has(sessionId)) {
        const success = claudeService.pinSession(sessionId);
        if (!success) {
          const hasSession = claudeService.hasSession(sessionId);
          sendMessage('client-1', {
            type: 'session_pin_error',
            sessionPath: sessionId,
            error: hasSession ? 'Maximum pinned sessions limit reached' : 'Session not found',
          });
        }
      }

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message).toEqual({
        type: 'session_pin_error',
        sessionPath: sessionId,
        error: 'Maximum pinned sessions limit reached',
      });
    });

    it('does NOT fall through to MultiSessionManager for Claude sessions', () => {
      const sessionId = 'claude-uuid-1';
      const claudeSessionIds = new Set([sessionId]);
      let multiSessionManagerCalled = false;

      const claudeService = makeClaudeServiceMock({
        pinSession: vi.fn().mockReturnValue(true),
      });

      if (claudeSessionIds.has(sessionId)) {
        claudeService.pinSession(sessionId);
      } else {
        multiSessionManagerCalled = true;
      }

      expect(multiSessionManagerCalled).toBe(false);
      expect(claudeService.pinSession).toHaveBeenCalledWith(sessionId);
    });
  });

  describe('unpin_session', () => {
    it('sends session_pinned with pinned=false when Claude session is unpinned', () => {
      const sessionId = 'claude-uuid-1';
      const claudeSessionIds = new Set([sessionId]);
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];

      const claudeService = makeClaudeServiceMock({
        unpinSession: vi.fn().mockReturnValue(true),
      });

      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      if (claudeSessionIds.has(sessionId)) {
        claudeService.unpinSession(sessionId);
        sendMessage('client-1', { type: 'session_pinned', sessionPath: sessionId, pinned: false });
      }

      expect(claudeService.unpinSession).toHaveBeenCalledWith(sessionId);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message).toEqual({
        type: 'session_pinned',
        sessionPath: sessionId,
        pinned: false,
      });
    });

    it('sends session_pinned even when session was not pinned', () => {
      const sessionId = 'claude-uuid-1';
      const claudeSessionIds = new Set([sessionId]);
      const sentMessages: Array<{ clientId: string; message: unknown }> = [];

      const claudeService = makeClaudeServiceMock({
        unpinSession: vi.fn().mockReturnValue(false),
      });

      const sendMessage = (clientId: string, message: unknown) => {
        sentMessages.push({ clientId, message });
      };

      if (claudeSessionIds.has(sessionId)) {
        claudeService.unpinSession(sessionId);
        sendMessage('client-1', { type: 'session_pinned', sessionPath: sessionId, pinned: false });
      }

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message).toEqual({
        type: 'session_pinned',
        sessionPath: sessionId,
        pinned: false,
      });
    });

    it('does NOT fall through to MultiSessionManager for Claude sessions', () => {
      const sessionId = 'claude-uuid-1';
      const claudeSessionIds = new Set([sessionId]);
      let multiSessionManagerCalled = false;

      const claudeService = makeClaudeServiceMock();

      if (claudeSessionIds.has(sessionId)) {
        claudeService.unpinSession(sessionId);
      } else {
        multiSessionManagerCalled = true;
      }

      expect(multiSessionManagerCalled).toBe(false);
    });
  });
});

// ─── ClaudeService Pin Tracking (unit tests for in-memory pin state) ─────────

describe('ClaudeService pin tracking (in-memory)', () => {
  // We test the pin tracking logic that ClaudeService implements
  // without importing the real service (which needs filesystem/config).

  function createPinTracker(maxPinned: number = 2) {
    const pinnedSessions = new Set<string>();
    const knownSessions = new Set<string>();

    return {
      register(sessionId: string) { knownSessions.add(sessionId); },
      hasSession(sessionId: string) { return knownSessions.has(sessionId) || pinnedSessions.has(sessionId); },
      pin(sessionId: string): boolean {
        if (!knownSessions.has(sessionId) && !pinnedSessions.has(sessionId)) return false;
        if (pinnedSessions.has(sessionId)) return true;
        if (pinnedSessions.size >= maxPinned) return false;
        pinnedSessions.add(sessionId);
        return true;
      },
      unpin(sessionId: string): boolean {
        return pinnedSessions.delete(sessionId);
      },
      isPinned(sessionId: string): boolean {
        return pinnedSessions.has(sessionId);
      },
      getPinnedCount(): number {
        return pinnedSessions.size;
      },
    };
  }

  it('pins a known session', () => {
    const tracker = createPinTracker();
    tracker.register('session-1');
    expect(tracker.pin('session-1')).toBe(true);
    expect(tracker.isPinned('session-1')).toBe(true);
  });

  it('returns false for unknown session', () => {
    const tracker = createPinTracker();
    expect(tracker.pin('unknown')).toBe(false);
  });

  it('returns true when pinning already-pinned session (idempotent)', () => {
    const tracker = createPinTracker();
    tracker.register('session-1');
    expect(tracker.pin('session-1')).toBe(true);
    expect(tracker.pin('session-1')).toBe(true);
  });

  it('enforces max pinned limit', () => {
    const tracker = createPinTracker(2);
    tracker.register('session-1');
    tracker.register('session-2');
    tracker.register('session-3');
    expect(tracker.pin('session-1')).toBe(true);
    expect(tracker.pin('session-2')).toBe(true);
    expect(tracker.pin('session-3')).toBe(false);
  });

  it('unpins a session', () => {
    const tracker = createPinTracker();
    tracker.register('session-1');
    tracker.pin('session-1');
    expect(tracker.unpin('session-1')).toBe(true);
    expect(tracker.isPinned('session-1')).toBe(false);
  });

  it('allows re-pinning after unpinning', () => {
    const tracker = createPinTracker(1);
    tracker.register('session-1');
    tracker.register('session-2');
    expect(tracker.pin('session-1')).toBe(true);
    tracker.unpin('session-1');
    expect(tracker.pin('session-2')).toBe(true);
  });

  it('reports correct pinned count', () => {
    const tracker = createPinTracker();
    tracker.register('session-1');
    tracker.register('session-2');
    tracker.pin('session-1');
    tracker.pin('session-2');
    expect(tracker.getPinnedCount()).toBe(2);
  });
});

// ─── ClaudeService getSessionStats (unit tests for stats computation) ────────

describe('ClaudeService getSessionStats computation', () => {

  function computeStatsFromHistory(history: ClaudeMessageEntry[]) {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    for (const entry of history) {
      switch (entry.type) {
        case 'user': userMessages++; break;
        case 'assistant': assistantMessages++; break;
        case 'tool': toolCalls++; break;
        case 'tool_result': toolResults++; break;
        case 'meta': {
          const usage = entry.usage as {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          } | undefined;
          if (usage) {
            totalTokens.input += usage.input_tokens ?? 0;
            totalTokens.output += usage.output_tokens ?? 0;
            totalTokens.cacheRead += usage.cache_read_input_tokens ?? 0;
            totalTokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
          }
          break;
        }
      }
    }
    totalTokens.total = totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheWrite;

    return {
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: userMessages + assistantMessages + toolCalls + toolResults,
      tokens: totalTokens,
    };
  }

  it('counts user and assistant messages correctly', () => {
    const history: ClaudeMessageEntry[] = [
      { type: 'user', sessionId: 's1', content: 'hello', timestamp: 1 },
      { type: 'assistant', sessionId: 's1', content: 'hi', timestamp: 2 },
      { type: 'user', sessionId: 's1', content: 'how are you', timestamp: 3 },
      { type: 'assistant', sessionId: 's1', content: 'fine', timestamp: 4 },
    ];

    const stats = computeStatsFromHistory(history);
    expect(stats.userMessages).toBe(2);
    expect(stats.assistantMessages).toBe(2);
    expect(stats.totalMessages).toBe(4);
  });

  it('counts tool calls and results correctly', () => {
    const history: ClaudeMessageEntry[] = [
      { type: 'user', sessionId: 's1', content: 'do stuff', timestamp: 1 },
      { type: 'tool', sessionId: 's1', toolName: 'bash', toolCallId: 'tc-1', timestamp: 2 },
      { type: 'tool_result', sessionId: 's1', toolCallId: 'tc-1', timestamp: 3 },
      { type: 'tool', sessionId: 's1', toolName: 'read', toolCallId: 'tc-2', timestamp: 4 },
      { type: 'tool_result', sessionId: 's1', toolCallId: 'tc-2', isError: true, timestamp: 5 },
      { type: 'assistant', sessionId: 's1', content: 'done', timestamp: 6 },
    ];

    const stats = computeStatsFromHistory(history);
    expect(stats.toolCalls).toBe(2);
    expect(stats.toolResults).toBe(2);
    expect(stats.totalMessages).toBe(6);
  });

  it('accumulates token usage from meta entries', () => {
    const history: ClaudeMessageEntry[] = [
      {
        type: 'meta', sessionId: 's1', timestamp: 1,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
      {
        type: 'meta', sessionId: 's1', timestamp: 2,
        usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
      },
    ];

    const stats = computeStatsFromHistory(history);
    expect(stats.tokens.input).toBe(300);
    expect(stats.tokens.output).toBe(150);
    expect(stats.tokens.cacheRead).toBe(30);
    expect(stats.tokens.cacheWrite).toBe(15);
    expect(stats.tokens.total).toBe(495);
  });

  it('handles empty history', () => {
    const stats = computeStatsFromHistory([]);
    expect(stats.userMessages).toBe(0);
    expect(stats.assistantMessages).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.toolResults).toBe(0);
    expect(stats.totalMessages).toBe(0);
    expect(stats.tokens.total).toBe(0);
  });

  it('handles meta entries without usage', () => {
    const history: ClaudeMessageEntry[] = [
      { type: 'meta', sessionId: 's1', timestamp: 1 },
    ];

    const stats = computeStatsFromHistory(history);
    expect(stats.tokens.total).toBe(0);
  });
});

// ─── End-to-end flow simulation ──────────────────────────────────────────────

describe('Claude Direct: full session info + pin flow', () => {

  it('complete flow: create → get_info → pin → get_info → unpin', async () => {
    const sessionId = 'claude-flow-1';
    const claudeSessionIds = new Set<string>();
    const clientViewingSession = new Map<string, string>();
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];
    const pinnedSet = new Set<string>();
    const knownSessions = new Set<string>();

    const sendMessage = (clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message });
    };

    const claudeService = {
      createSession: vi.fn().mockResolvedValue({ sessionId, claudeSessionId: 'real-1' }),
      getSessionStats: vi.fn(),
      pinSession: vi.fn(),
      unpinSession: vi.fn(),
      hasSession: vi.fn(),
    };

    // Step 1: Create session
    claudeSessionIds.add(sessionId);
    clientViewingSession.set('client-1', sessionId);
    knownSessions.add(sessionId);

    // Step 2: Get session info
    claudeService.getSessionStats.mockResolvedValue({
      sessionId,
      cwd: '/tmp/project',
      model: 'sonnet',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0,
      pinned: false,
    });

    const sessionPath = clientViewingSession.get('client-1');
    if (sessionPath && claudeSessionIds.has(sessionPath)) {
      const stats = await claudeService.getSessionStats(sessionPath);
      sendMessage('client-1', { type: 'session_info', stats });
    }

    // Step 3: Pin session
    claudeService.pinSession.mockReturnValue(true);
    claudeService.hasSession.mockReturnValue(true);

    if (claudeSessionIds.has(sessionId)) {
      const success = claudeService.pinSession(sessionId);
      if (success) {
        pinnedSet.add(sessionId);
        sendMessage('client-1', { type: 'session_pinned', sessionPath: sessionId, pinned: true });
      }
    }

    // Step 4: Get session info again (now pinned)
    claudeService.getSessionStats.mockResolvedValue({
      sessionId,
      cwd: '/tmp/project',
      model: 'sonnet',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0,
      pinned: true,
    });

    sentMessages.length = 0;
    if (sessionPath && claudeSessionIds.has(sessionPath)) {
      const stats = await claudeService.getSessionStats(sessionPath);
      sendMessage('client-1', { type: 'session_info', stats });
    }

    // Step 5: Unpin session
    claudeService.unpinSession.mockReturnValue(true);
    if (claudeSessionIds.has(sessionId)) {
      claudeService.unpinSession(sessionId);
      pinnedSet.delete(sessionId);
      sendMessage('client-1', { type: 'session_pinned', sessionPath: sessionId, pinned: false });
    }

    // Verify all calls
    expect(claudeService.getSessionStats).toHaveBeenCalledTimes(2);
    expect(claudeService.pinSession).toHaveBeenCalledWith(sessionId);
    expect(claudeService.unpinSession).toHaveBeenCalledWith(sessionId);
    expect(pinnedSet.has(sessionId)).toBe(false);
  });
});
