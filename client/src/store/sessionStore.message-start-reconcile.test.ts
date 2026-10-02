import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore, type Message } from './sessionStore';

// Hb6: reconcile the composer's optimistic user bubble with the server's echo.
// The optimistic copy (id `optimistic_…`, added by MessageInput on send) and
// the user `message_start` echo (which carries no id on the pi wire) must
// collapse into ONE message; nothing else about the flows may change.

const SID = 'hb6-session';

function optimisticMessage(text: string): Message {
  return {
    id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
    isComplete: true,
  };
}

function userMessages(): Message[] {
  const messages = useSessionStore.getState().sessionData[SID]?.messages ?? [];
  return messages.filter((m) => m.role === 'user');
}

function feed(message: unknown): void {
  useSessionStore.getState().handleServerMessage(message);
}

function echo(text: string, path: 'session_event' | 'main' = 'session_event'): void {
  if (path === 'session_event') {
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } },
    });
  } else {
    feed({ type: 'message_start', message: { id: `wire_${Math.random().toString(36).slice(2, 7)}`, role: 'user', content: [{ type: 'text', text }] } });
  }
}

describe('sessionStore optimistic user bubble reconciliation (Hb6)', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: SID,
      messages: [],
      sessionData: {},
      sessionMessages: {},
      sessionCache: new Map(),
    });
    useSessionStore.setState((state) => ({
      sessionData: {
        ...state.sessionData,
        [SID]: {
          messages: [],
          status: 'idle' as const,
          lastEventTimestamp: 0,
          contextPercent: 0,
          currentStep: 0,
          model: null,
        },
      },
    }));
  });

  it('reconciles the echoed user message with the optimistic bubble (one bubble, position preserved)', () => {
    const text = 'Reply with exactly one line: HB6-1 and nothing else.';
    useSessionStore.getState().addMessage(optimisticMessage(text));

    echo(text);

    const users = userMessages();
    expect(users).toHaveLength(1);
    expect(users[0].id.startsWith('optimistic_')).toBe(false);
    expect(users[0].content).toBe(text);
  });

  it('keeps the reconciled message in its original position (before a later assistant reply)', () => {
    const text = 'Reply with exactly one line: HB6-1b and nothing else.';
    useSessionStore.getState().addMessage(optimisticMessage(text));
    echo(text);
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } },
    });

    const messages = useSessionStore.getState().sessionData[SID]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('appends normally when the echo text differs (no false match)', () => {
    useSessionStore.getState().addMessage(optimisticMessage('First prompt text'));
    echo('Second prompt text');

    const users = userMessages();
    expect(users).toHaveLength(2);
    expect(users[0].content).toBe('First prompt text');
    expect(users.map((m) => (Array.isArray(m.content) ? m.content.map((p) => (p as { text?: string }).text ?? '').join('') : m.content))).toContain('Second prompt text');
  });

  it('two identical prompts: the first echo consumes the optimistic copy, the second appends', () => {
    const text = 'Repeat myself twice';
    useSessionStore.getState().addMessage(optimisticMessage(text));
    echo(text);
    echo(text);

    const users = userMessages();
    expect(users).toHaveLength(2);
    expect(users.filter((m) => m.id.startsWith('optimistic_'))).toHaveLength(0);
  });

  it('appends when no optimistic copy exists (API-prompted turns and steer replays unchanged)', () => {
    echo('Steer replay text: HB6-steer');

    const users = userMessages();
    expect(users).toHaveLength(1);
    expect(users[0].id.startsWith('optimistic_')).toBe(false);
  });

  it('leaves an optimistic copy whose echo never arrives exactly as today (no silent deletion)', () => {
    const text = 'Echo never arrives for this one';
    useSessionStore.getState().addMessage(optimisticMessage(text));
    feed({ type: 'session_event', sessionId: SID, event: { type: 'agent_start' } });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'A different turn' }] } },
    });

    const users = userMessages();
    expect(users.some((m) => m.id.startsWith('optimistic_') && m.content === text)).toBe(true);
  });

  it('session_switched still rebuilds a single bubble from the transcript', () => {
    const text = 'Reply with exactly one line: HB6-switch and nothing else.';
    useSessionStore.getState().addMessage(optimisticMessage(text));
    echo(text);
    expect(userMessages()).toHaveLength(1);

    feed({
      type: 'session_switched',
      sessionId: SID,
      sessionPath: '/x',
      messages: [
        { id: 'u1', role: 'user', content: text, timestamp: 1 },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'HB6-switch' }], timestamp: 2 },
      ],
      fileTimestamp: 1,
      isStreaming: false,
    });

    // The switch rebuilds the visible projection from the transcript.
    const users = useSessionStore.getState().messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe('u1');
  });

  it('reconciles on the legacy main path too', () => {
    const text = 'Main path prompt';
    useSessionStore.getState().addMessage(optimisticMessage(text));
    echo(text, 'main');

    const messages = useSessionStore.getState().messages;
    const users = messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].id.startsWith('optimistic_')).toBe(false);
  });
});
