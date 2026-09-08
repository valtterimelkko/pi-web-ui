import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore, type Message } from '../../../src/store/sessionStore';

type DebugState = { debugSizeScanCount?: number };
type Projection = {
  current: Message[];
  session: Message[] | undefined;
  legacy: Message[] | undefined;
  lru: Message[] | undefined;
};

type Delta = { type: 'text_delta' | 'thinking_delta'; delta: string };

function debugSizeScans(): number {
  return (useSessionStore.getState() as unknown as DebugState).debugSizeScanCount ?? 0;
}

function estimatedMessageSize(message: Message): number {
  let size = 100;
  if (typeof message.content === 'string') return size + message.content.length * 2;
  for (const part of message.content) {
    size += (part.text?.length ?? 0) * 2;
    size += (part.thinking?.length ?? 0) * 2;
  }
  return size;
}

function estimatedMessagesSize(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimatedMessageSize(message), 0);
}

function projection(sessionId: string): Projection {
  const state = useSessionStore.getState();
  return {
    current: state.messages,
    session: state.sessionData[sessionId]?.messages,
    legacy: state.sessionMessages[sessionId],
    lru: state.sessionCache.get(sessionId)?.messages,
  };
}

function foldDeltas(initial: Message['content'], deltas: Delta[]): Message['content'] {
  const parts = typeof initial === 'string'
    ? (initial ? [{ type: 'text' as const, text: initial }] : [])
    : initial.map((part) => ({ ...part }));

  for (const delta of deltas) {
    const last = parts.at(-1);
    if (delta.type === 'text_delta' && last?.type === 'text') {
      last.text = (last.text ?? '') + delta.delta;
    } else if (delta.type === 'thinking_delta' && last?.type === 'thinking') {
      last.thinking = (last.thinking ?? '') + delta.delta;
    } else if (delta.type === 'text_delta') {
      parts.push({ type: 'text', text: delta.delta });
    } else {
      parts.push({ type: 'thinking', thinking: delta.delta });
    }
  }
  return parts;
}

function seedCurrentSession(sessionId: string, messages: Message[]): void {
  const sizeBytes = estimatedMessagesSize(messages);
  useSessionStore.setState({
    currentSessionId: sessionId,
    currentSessionSdkType: 'pi',
    messages,
    sessionData: {
      [sessionId]: {
        messages,
        status: 'streaming',
        lastEventTimestamp: 1,
        contextPercent: 0,
        currentStep: 0,
        model: null,
      },
    },
    sessionMessages: { [sessionId]: messages },
    sessionCache: new Map([[sessionId, { messages, lastAccess: 1 }]]),
    sessionCacheMeta: {
      [sessionId]: {
        fileTimestamp: 0,
        lastLocalUpdate: 1,
        isStreaming: true,
        messageCount: messages.length,
        sizeBytes,
      },
    },
    lastStreamEventAt: null,
    debugSizeScanCount: 0,
  } as never);
}

function sessionDelta(sessionId: string, delta: Delta, messageId?: string): unknown {
  return {
    type: 'session_event',
    sessionId,
    event: {
      type: 'message_update',
      ...(messageId ? { message: { id: messageId } } : {}),
      assistantMessageEvent: delta,
    },
  };
}

describe('Step 7A: atomic live message updates', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: null,
      currentSessionSdkType: null,
      messages: [],
      sessionData: {},
      sessionMessages: {},
      sessionCache: new Map(),
      sessionCacheMeta: {},
      lastStreamEventAt: null,
      historyReplayActive: {},
      debugSizeScanCount: 0,
    } as never);
  });

  it('folds every text/thinking delta atomically with zero full scans and stable untouched identities', () => {
    const sessionId = 'step7a-current';
    const target: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
      timestamp: 1,
    };
    const untouched: Message[] = Array.from({ length: 7 }, (_, index) => ({
      id: `unchanged-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0 ? `user-${index}` : [{ type: 'text' as const, text: `assistant-${index}` }],
      timestamp: index + 2,
    }));
    const messages = [target, ...untouched];
    seedCurrentSession(sessionId, messages);

    const deltas: Delta[] = [
      { type: 'text_delta', delta: ' one' },
      { type: 'text_delta', delta: ' two' },
      { type: 'thinking_delta', delta: 'why' },
      { type: 'thinking_delta', delta: '?' },
      { type: 'text_delta', delta: ' after' },
      { type: 'text_delta', delta: ' thought' },
    ];
    const expectedContent = foldDeltas(target.content, deltas);
    let previous = projection(sessionId);
    let affectedTuplePublications = 0;
    let unrelatedLifecyclePublications = 0;
    let inconsistentPublications = 0;
    let totalPublications = 0;

    const unsubscribe = useSessionStore.subscribe((state) => {
      totalPublications++;
      const next: Projection = {
        current: state.messages,
        session: state.sessionData[sessionId]?.messages,
        legacy: state.sessionMessages[sessionId],
        lru: state.sessionCache.get(sessionId)?.messages,
      };
      const tupleChanged = next.current !== previous.current
        || next.session !== previous.session
        || next.legacy !== previous.legacy
        || next.lru !== previous.lru;
      if (!tupleChanged) {
        unrelatedLifecyclePublications++;
      } else {
        affectedTuplePublications++;
        const arrays = [next.current, next.session, next.legacy, next.lru];
        const targetMessages = arrays.map((array) => array?.find((message) => message.id === target.id));
        if (arrays.some((array) => array !== next.current)
          || targetMessages.some((message) => message !== targetMessages[0])) {
          inconsistentPublications++;
        }
      }
      previous = next;
    });

    const beforeUntouched = new Map(untouched.map((message) => [message.id, message]));
    let beforeTarget = target;
    let beforeTargetContent = target.content;
    let expectedSize = estimatedMessagesSize(messages);

    for (const delta of deltas) {
      const beforeMessage = useSessionStore.getState().messages.find((message) => message.id === target.id)!;
      const beforeContent = beforeMessage.content;
      const beforeLastPart = Array.isArray(beforeContent) ? beforeContent.at(-1) : undefined;
      const beforeSize = estimatedMessageSize(beforeMessage);
      useSessionStore.getState().handleServerMessage(sessionDelta(sessionId, delta, target.id));
      const state = useSessionStore.getState();
      const afterProjection = projection(sessionId);
      const afterMessage = state.messages.find((message) => message.id === target.id)!;

      expect(afterMessage).not.toBe(beforeMessage);
      expect(beforeUntouched.get('unchanged-0')).toBe(state.messages.find((message) => message.id === 'unchanged-0'));
      expect(afterMessage.content).not.toBe(beforeContent);
      if (Array.isArray(beforeContent) && Array.isArray(afterMessage.content) && beforeLastPart?.type === afterMessage.content.at(-1)?.type) {
        // The append-to-the-current-part path must not mutate a memoised part
        // owned by the previous message version.
        expect(afterMessage.content.at(-1)).not.toBe(beforeLastPart);
      }
      expect(beforeTarget).not.toBe(afterMessage);
      expect(beforeTargetContent).not.toBe(afterMessage.content);

      expectedSize = expectedSize - beforeSize + estimatedMessageSize(afterMessage);
      expect(state.sessionCacheMeta[sessionId]?.sizeBytes).toBe(expectedSize);
      beforeTarget = afterMessage;
      beforeTargetContent = afterMessage.content;
    }

    unsubscribe();

    const finalState = useSessionStore.getState();
    expect(finalState.messages.find((message) => message.id === target.id)?.content).toEqual(expectedContent);
    expect(finalState.sessionData[sessionId]?.messages).toBe(finalState.messages);
    expect(finalState.sessionMessages[sessionId]).toBe(finalState.messages);
    expect(finalState.sessionCache.get(sessionId)?.messages).toBe(finalState.messages);
    expect(affectedTuplePublications, `affected tuple publications=${affectedTuplePublications} for deltas=${deltas.length}`).toBe(deltas.length);
    expect(unrelatedLifecyclePublications, `unrelated lifecycle publications=${unrelatedLifecyclePublications}`).toBe(0);
    expect(totalPublications, `total publications=${totalPublications}`).toBe(deltas.length);
    expect(inconsistentPublications, `inconsistent affected publications=${inconsistentPublications}`).toBe(0);
    expect(debugSizeScans(), `full-transcript size scans=${debugSizeScans()}`).toBe(0);
  });

  it('matches an independent oracle across replay/live boundaries, id-less Pi updates, reused Command Code IDs and late events', () => {
    const sessionId = 'step7a-boundary';
    const state = useSessionStore.getState();
    state.handleServerMessage({
      type: 'session_switched',
      sessionId,
      sdkType: 'commandcode',
      messages: [],
    });
    state.handleServerMessage({ type: 'history_start', sessionId });
    state.handleServerMessage({
      type: 'session_event',
      sessionId,
      event: { type: 'message_start', message: { id: 'replay-1', role: 'assistant' } },
    });
    state.handleServerMessage(sessionDelta(sessionId, { type: 'text_delta', delta: 'replayed' }, 'replay-1'));
    state.handleServerMessage({ type: 'history_end', sessionId });
    // The replay/switch is a baseline construction, not a live delta. Start
    // the per-delta cost witness after it has settled.
    useSessionStore.setState({ debugSizeScanCount: 0 } as never);
    state.handleServerMessage(sessionDelta(sessionId, { type: 'text_delta', delta: ' + late' }, 'replay-1'));

    // Pi's raw events can omit message.id; the tracked message_start ID is
    // the routing oracle for the following delta.
    state.handleServerMessage({
      type: 'session_event',
      sessionId,
      event: { type: 'message_start', message: { id: 'pi-1', role: 'assistant' } },
    });
    state.handleServerMessage(sessionDelta(sessionId, { type: 'thinking_delta', delta: 'private thought' }));

    const commandCodeTurn = (text: string) => {
      state.handleServerMessage({
        type: 'session_event',
        sessionId,
        event: { type: 'message_start', message: { id: 'commandcode-message-1', role: 'assistant' } },
      });
      state.handleServerMessage(sessionDelta(sessionId, { type: 'text_delta', delta: text }, 'commandcode-message-1'));
      state.handleServerMessage({
        type: 'session_event',
        sessionId,
        event: { type: 'message_end', message: { id: 'commandcode-message-1' } },
      });
    };
    commandCodeTurn('first turn');
    commandCodeTurn('second turn');

    const messages = useSessionStore.getState().sessionMessages[sessionId] ?? [];
    const oracle = new Map([
      ['replay-1', [{ type: 'text', text: 'replayed + late' }]],
      ['pi-1', [{ type: 'thinking', thinking: 'private thought' }]],
      ['commandcode-message-1', [{ type: 'text', text: 'first turn' }]],
      ['commandcode-message-1#2', [{ type: 'text', text: 'second turn' }]],
    ]);
    expect(messages.map((message) => message.id)).toEqual([...oracle.keys()]);
    for (const message of messages) {
      expect(message.content).toEqual(oracle.get(message.id));
    }
    // Exactly ONE full scan is the documented baseline fallback for a session
    // whose sizeBytes meta was never computed; live deltas after it stay at 0.
    expect(debugSizeScans(), `boundary full-transcript size scans=${debugSizeScans()}`).toBeLessThanOrEqual(1);
  });
});
