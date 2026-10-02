import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore, type Message } from './sessionStore';

// Hb2: fill-on-end. The server now neutralises streamed content on assistant
// message_start frames (the doubled-first-chunk fix), so an assistant message
// that has content but NO deltas (an error or aborted reply that arrives as
// start+end only) would render empty. The message_end handler fills each
// text/thinking block whose streamed payload is empty from the terminal
// message, and never replaces non-empty streamed text.

const SID = 'hb2-session';

function contentText(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .map((part) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('');
}

function sessionMessages(): Message[] {
  return useSessionStore.getState().sessionData[SID]?.messages ?? [];
}

function lastAssistant(): Message | undefined {
  const messages = sessionMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
  return undefined;
}

function feed(message: unknown): void {
  useSessionStore.getState().handleServerMessage(message);
}

describe('sessionStore message_end fill-on-end (Hb2)', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: SID,
      messages: [],
      sessionData: {},
      sessionMessages: {},
      sessionCache: new Map(),
    });
    // The store mirrors the current-session transcript into `messages` only
    // once sessionData exists; seed it so both projections agree from the start.
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

  it('streaming deltas render exactly once on the corrected wire (typed-empty start + deltas)', () => {
    feed({ type: 'session_event', sessionId: SID, event: { type: 'agent_start' } });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'HB' } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '2LIVE-6612' } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'HB2LIVE-6612' }] } },
    });

    expect(contentText(lastAssistant())).toBe('HB2LIVE-6612');
  });

  it('fills an assistant message that arrives as start+end with no deltas (error/abort shape)', () => {
    feed({ type: 'session_event', sessionId: SID, event: { type: 'agent_start' } });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Request failed: upstream 429.' }] } },
    });

    expect(contentText(lastAssistant())).toBe('Request failed: upstream 429.');
  });

  it('fills typed-empty thinking blocks from message_end too', () => {
    feed({ type: 'session_event', sessionId: SID, event: { type: 'agent_start' } });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoned briefly' }] } },
    });

    const message = lastAssistant();
    const content = Array.isArray(message?.content) ? message.content : [];
    expect(content).toEqual([{ type: 'thinking', thinking: 'reasoned briefly' }]);
  });

  it('appends terminal blocks the streamed message lacks entirely', () => {
    feed({ type: 'session_event', sessionId: SID, event: { type: 'agent_start' } });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'assistant', content: [] } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Aborted before any token.' }] } },
    });

    expect(contentText(lastAssistant())).toBe('Aborted before any token.');
  });

  it('never replaces non-empty streamed text with the terminal text', () => {
    feed({ type: 'session_event', sessionId: SID, event: { type: 'agent_start' } });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'AB' } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ZZZ' }] } },
    });

    expect(contentText(lastAssistant())).toBe('AB');
  });

  it('fills the main-path (non session_event) message_end as well', () => {
    feed({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '' }] } });
    feed({ type: 'message_end', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Main path fill.' }] } });

    const messages = useSessionStore.getState().messages;
    const assistant = messages.find((m) => m.id === 'm1');
    expect(contentText(assistant)).toBe('Main path fill.');
  });

  it('leaves user-role and already-populated messages alone on message_end', () => {
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } },
    });
    feed({
      type: 'session_event', sessionId: SID,
      event: { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'DIFFERENT' }] } },
    });

    const messages = sessionMessages();
    const user = messages.find((m) => m.role === 'user');
    expect(contentText(user)).toBe('the prompt');
  });
});
