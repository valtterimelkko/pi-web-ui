import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';
import { useUIStore } from '../../../src/store/uiStore';

/**
 * History-replay batching: session_event messages between history_start and
 * history_end must be buffered and applied in ONE pass on history_end, so a
 * 600-event Command Code replay triggers a single render instead of 600
 * (which saturated the main thread for 15+ seconds on a laptop).
 */

function ccEvent(sessionId: string, n: number): { type: 'session_event'; sessionId: string; event: { type: string; message?: { id: string; role: string }; assistantMessageEvent?: { type: string; delta: string } } } {
  const id = `m${Math.floor(n / 2)}`;
  const kind = n % 2 === 0 ? 'message_start' : 'message_update';
  return {
    type: 'session_event',
    sessionId,
    event: kind === 'message_start'
      ? { type: 'message_start', message: { id, role: 'assistant' } }
      : { type: 'message_update', message: { id }, assistantMessageEvent: { type: 'text_delta', delta: `chunk-${n} ` } },
  } as never;
}

describe('history replay batching', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionMessages: {},
      streamingSessions: {},
      currentSessionId: 'cc-1',
      currentSessionSdkType: 'commandcode',
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,
      sessionData: {},
      historyReplayActive: {},
      isSwitchingSession: false,
      switchingToSessionId: null,
    });
    useUIStore.setState({ toasts: [] });
  });

  it('buffers session_events during a history window and applies them once at history_end', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({ type: 'session_switched', sessionId: 'cc-1', sessionPath: 'cc-1', sdkType: 'commandcode', messages: [] } as never);

    const setSpy = vi.spyOn(useSessionStore, 'setState');
    state.handleServerMessage({ type: 'history_start', sessionId: 'cc-1' } as never);
    // Replay is marked active so the message list can settle completion-driven.
    expect(useSessionStore.getState().historyReplayActive['cc-1']).toBe(true);

    setSpy.mockClear();
    for (let n = 0; n < 40; n++) state.handleServerMessage(ccEvent('cc-1', n) as never);
    // During the window: no per-event state writes at all (that is the fix).
    expect(setSpy).not.toHaveBeenCalled();

    state.handleServerMessage({ type: 'history_end', sessionId: 'cc-1' } as never);
    const messages = useSessionStore.getState().sessionMessages['cc-1'];
    expect(messages).toHaveLength(20);
    const first = messages[0];
    expect((first.content[0] as { text: string }).text).toBe('chunk-1 ');
    expect(useSessionStore.getState().historyReplayActive['cc-1']).toBeUndefined();
    setSpy.mockRestore();
  });

  it('folds tool events into tool messages within the same single flush', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({ type: 'session_switched', sessionId: 'cc-1', sessionPath: 'cc-1', sdkType: 'commandcode', messages: [] } as never);
    state.handleServerMessage({ type: 'history_start', sessionId: 'cc-1' } as never);
    state.handleServerMessage({ type: 'session_event', sessionId: 'cc-1', event: { type: 'message_start', message: { id: 'u1', role: 'user' } } } as never);
    state.handleServerMessage({ type: 'session_event', sessionId: 'cc-1', event: { type: 'tool_execution_start', toolCallId: 't9', toolName: 'bash', args: { command: 'ls' } } } as never);
    state.handleServerMessage({ type: 'session_event', sessionId: 'cc-1', event: { type: 'tool_execution_end', toolCallId: 't9', result: { content: [{ type: 'text', text: 'file-a' }] }, isError: false } } as never);
    state.handleServerMessage({ type: 'history_end', sessionId: 'cc-1' } as never);
    const messages = useSessionStore.getState().sessionMessages['cc-1'];
    expect(messages).toHaveLength(2);
    const tool = messages[1] as unknown as { role: string; toolCall: { name: string }; toolResult: { output: string } };
    expect(tool.role).toBe('tool');
    expect(tool.toolCall.name).toBe('bash');
    expect(tool.toolResult.output).toBe('file-a');
  });

  it('preserves event order for interleaved live events of the replaying session', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({ type: 'session_switched', sessionId: 'cc-1', sessionPath: 'cc-1', sdkType: 'commandcode', messages: [] } as never);
    state.handleServerMessage({ type: 'history_start', sessionId: 'cc-1' } as never);
    state.handleServerMessage(ccEvent('cc-1', 0) as never);
    state.handleServerMessage(ccEvent('cc-1', 1) as never);
    state.handleServerMessage(ccEvent('cc-1', 2) as never);
    state.handleServerMessage(ccEvent('cc-1', 3) as never);
    state.handleServerMessage({ type: 'history_end', sessionId: 'cc-1' } as never);
    const messages = useSessionStore.getState().sessionMessages['cc-1'];
    expect(messages.map((m: { id: string }) => m.id)).toEqual(['m0', 'm1']);
  });

  it('does not buffer events for sessions outside the history window', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({ type: 'session_switched', sessionId: 'cc-1', sessionPath: 'cc-1', sdkType: 'commandcode', messages: [] } as never);
    state.handleServerMessage({ type: 'history_start', sessionId: 'cc-1' } as never);
    // A live event for a different session applies immediately.
    state.handleServerMessage(ccEvent('other-9', 0) as never);
    expect(useSessionStore.getState().sessionMessages['other-9']).toHaveLength(1);
    // The replaying session stays buffered (its own event is held back).
    state.handleServerMessage(ccEvent('cc-1', 0) as never);
    expect(useSessionStore.getState().sessionMessages['cc-1']).toBeUndefined();
    state.handleServerMessage({ type: 'history_end', sessionId: 'cc-1' } as never);
    expect(useSessionStore.getState().sessionMessages['cc-1']).toHaveLength(1);
  });

  it('flushes a stuck buffer on a safety timeout instead of dropping the replay', () => {
    vi.useFakeTimers();
    try {
      const state = useSessionStore.getState();
      state.handleServerMessage({ type: 'session_switched', sessionId: 'cc-1', sessionPath: 'cc-1', sdkType: 'commandcode', messages: [] } as never);
      state.handleServerMessage({ type: 'history_start', sessionId: 'cc-1' } as never);
      for (let n = 0; n < 6; n++) state.handleServerMessage(ccEvent('cc-1', n) as never);
      // history_end never arrives (e.g. connection drop mid-replay).
      vi.advanceTimersByTime(15_000);
      const messages = useSessionStore.getState().sessionMessages['cc-1'];
      expect(messages).toHaveLength(3);
      expect(useSessionStore.getState().historyReplayActive['cc-1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a very large replay in bounded chunks (memory safety)', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({ type: 'session_switched', sessionId: 'cc-1', sessionPath: 'cc-1', sdkType: 'commandcode', messages: [] } as never);
    state.handleServerMessage({ type: 'history_start', sessionId: 'cc-1' } as never);
    // Far beyond the buffer cap: the buffer must flush incrementally (partial
    // state visible mid-window) instead of growing unbounded in memory.
    for (let n = 0; n < 2_600; n++) state.handleServerMessage(ccEvent('cc-1', n) as never);
    const midWindow = useSessionStore.getState().sessionMessages['cc-1'];
    expect(midWindow.length).toBeGreaterThan(0);
    expect(midWindow.length).toBeLessThan(1_300);
    state.handleServerMessage({ type: 'history_end', sessionId: 'cc-1' } as never);
    expect(useSessionStore.getState().sessionMessages['cc-1']).toHaveLength(1_300);
  });
});

describe('session switch robustness', () => {
  beforeEach(() => {
    vi.useRealTimers();
    useSessionStore.setState({
      isSwitchingSession: false,
      switchingToSessionId: null,
      error: null,
    });
    useUIStore.setState({ toasts: [] });
  });

  it('clears the switching state after a bounded acknowledgement timeout', () => {
    vi.useFakeTimers();
    try {
      useSessionStore.getState().setSwitchingSession(true, 'cc-stuck');
      expect(useSessionStore.getState().isSwitchingSession).toBe(true);
      // No session_switched ever arrives.
      vi.advanceTimersByTime(20_000);
      expect(useSessionStore.getState().isSwitchingSession).toBe(false);
      expect(useSessionStore.getState().switchingToSessionId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timeout after a successful switch', () => {
    vi.useFakeTimers();
    try {
      useSessionStore.getState().setSwitchingSession(true, 'cc-ok');
      useSessionStore.getState().handleServerMessage({ type: 'session_switched', sessionId: 'cc-ok', sessionPath: 'cc-ok', sdkType: 'commandcode', messages: [] } as never);
      vi.advanceTimersByTime(60_000);
      expect(useSessionStore.getState().isSwitchingSession).toBe(false);
      expect(useUIStore.getState().toasts.filter(t => t.type === 'error')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
