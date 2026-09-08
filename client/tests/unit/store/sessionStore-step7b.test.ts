import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore, type Message } from '../../../src/store/sessionStore';

type ReplayEvent = { type: string; [key: string]: unknown };
type ReplayEnvelope = { type: 'session_event'; sessionId: string; event: ReplayEvent };
type ReplayDebugState = {
  debugStorageLookupLinearScans?: number;
  debugStorageIdAllocationCollisions?: number;
};

type BaselineResult = {
  messages: Message[];
  linearScans: number;
  allocationCollisions: number;
};

function event(sessionId: string, replayEvent: ReplayEvent): ReplayEnvelope {
  return { type: 'session_event', sessionId, event: replayEvent };
}

function messageStart(sessionId: string, id: string, role: 'user' | 'assistant' = 'assistant'): ReplayEnvelope {
  return event(sessionId, {
    type: 'message_start',
    message: { id, role },
  });
}

function messageUpdate(sessionId: string, id: string | undefined, delta: string, type = 'text_delta'): ReplayEnvelope {
  return event(sessionId, {
    type: 'message_update',
    ...(id === undefined ? {} : { message: { id } }),
    assistantMessageEvent: { type, delta },
  });
}

function toolStart(sessionId: string, id: string): ReplayEnvelope {
  return event(sessionId, {
    type: 'tool_execution_start',
    toolCallId: id,
    toolName: 'bash',
    args: { command: `printf ${id}` },
  });
}

function toolEnd(sessionId: string, id: string, output: string): ReplayEnvelope {
  return event(sessionId, {
    type: 'tool_execution_end',
    toolCallId: id,
    result: { content: [{ type: 'text', text: output }] },
    isError: false,
  });
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
  };
}

/**
 * The pre-Step-7B fold oracle. This intentionally retains the old array
 * target searches so the test reports the work avoided by the indexed fold.
 * The 1,000-event chunk size mirrors HISTORY_BUFFER_FLUSH_EVENTS.
 */
function foldOld(events: ReplayEnvelope[], base: Message[] = [], chunkSize = 1_000): BaselineResult {
  let messages = base.map(cloneMessage);
  let linearScans = 0;
  let allocationCollisions = 0;

  for (let offset = 0; offset < events.length; offset += chunkSize) {
    const chunk = events.slice(offset, offset + chunkSize);
    const usedIds = new Set(messages.map((message) => message.id));
    const latestByWireId = new Map<string, string>();
    let activeMessageId: string | undefined;

    const storageIdForStart = (wireId: string): string => {
      if (!usedIds.has(wireId)) return wireId;
      allocationCollisions++;
      let n = 2;
      while (usedIds.has(`${wireId}#${n}`)) n++;
      return `${wireId}#${n}`;
    };
    const lookupId = (wireId: string): string => latestByWireId.get(wireId) ?? wireId;
    const findTarget = (id: string | undefined): Message | undefined => {
      if (id) {
        const mapped = lookupId(id);
        linearScans++;
        return messages.find((message) => message.id === mapped)
          ?? (linearScans++, messages.find((message) => message.id === id));
      }
      linearScans++;
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === 'assistant') return messages[index];
      }
      return undefined;
    };

    for (const buffered of chunk) {
      const replayEvent = buffered.event;
      switch (replayEvent.type) {
        case 'message_start': {
          const message = (replayEvent.message as { id?: string; role?: string; content?: Message['content'] } | undefined) ?? {};
          const wireId = message.id || `msg_${Date.now()}_${messages.length}`;
          const id = storageIdForStart(wireId);
          usedIds.add(id);
          latestByWireId.set(wireId, id);
          activeMessageId = wireId;
          messages.push({
            id,
            role: (message.role as Message['role']) ?? 'assistant',
            content: message.content ?? (message.role === 'user' ? '' : []),
            timestamp: Date.now(),
          });
          break;
        }
        case 'message_update': {
          const message = replayEvent.message as { id?: string } | undefined;
          const target = findTarget(message?.id || activeMessageId);
          if (!target) break;
          const assistantEvent = replayEvent.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (!assistantEvent || typeof assistantEvent.delta !== 'string') break;
          const contentArray = Array.isArray(target.content)
            ? target.content
            : typeof target.content === 'string' && target.content
              ? [{ type: 'text' as const, text: target.content }]
              : [];
          const lastEntry = contentArray[contentArray.length - 1];
          if (assistantEvent.type === 'text_delta') {
            if (lastEntry?.type === 'text') lastEntry.text = (lastEntry.text || '') + assistantEvent.delta;
            else contentArray.push({ type: 'text', text: assistantEvent.delta });
          } else if (assistantEvent.type === 'thinking_delta') {
            if (lastEntry?.type === 'thinking') lastEntry.thinking = (lastEntry.thinking || '') + assistantEvent.delta;
            else contentArray.push({ type: 'thinking', thinking: assistantEvent.delta });
          }
          target.content = contentArray;
          break;
        }
        case 'message_end':
          activeMessageId = undefined;
          break;
        case 'tool_execution_start': {
          const id = (replayEvent.toolCallId as string | undefined) || `tool_${Date.now()}_${messages.length}`;
          messages.push({
            id,
            role: 'tool',
            content: '',
            timestamp: Date.now(),
            toolCall: { id, name: (replayEvent.toolName as string | undefined) || 'unknown', args: replayEvent.args },
          });
          break;
        }
        case 'tool_execution_end': {
          const id = replayEvent.toolCallId as string | undefined;
          const target = findTarget(id);
          if (!target || target.role !== 'tool') break;
          const result = replayEvent.result;
          const content = typeof result === 'object' && result && Array.isArray((result as { content?: Array<{ text?: string }> }).content)
            ? ((result as { content: Array<{ text?: string }> }).content).map((part) => part.text ?? '').join('')
            : typeof result === 'string' ? result : '';
          target.content = content;
          target.toolResult = { output: content, isError: replayEvent.isError === true };
          break;
        }
      }
    }
  }

  return { messages, linearScans, allocationCollisions };
}

function makeLargeFixture(sessionId: string, messageCount: number): ReplayEnvelope[] {
  const events: ReplayEnvelope[] = [];
  for (let index = 0; index < messageCount; index++) {
    events.push(messageStart(sessionId, `message-${index}`));
  }
  for (let index = 0; index < messageCount; index++) {
    events.push(messageUpdate(sessionId, `message-${index}`, `chunk-${index}`));
  }
  for (let index = 0; index < Math.floor(messageCount / 10); index++) {
    events.push(toolStart(sessionId, `tool-${index}`));
  }
  for (let index = 0; index < Math.floor(messageCount / 10); index++) {
    events.push(toolEnd(sessionId, `tool-${index}`, `result-${index}`));
  }
  return events;
}

function comparable(messages: Message[]): unknown[] {
  return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

function resetStore(currentSessionId: string | null = 'foreground'): void {
  useSessionStore.setState({
    currentSessionId,
    currentSessionSdkType: 'commandcode',
    messages: [],
    sessionData: {},
    sessionMessages: {},
    sessionCache: new Map(),
    sessionCacheMeta: {},
    historyReplayActive: {},
    streamingSessions: {},
    debugSizeScanCount: 0,
  } as never);
  const debug = useSessionStore.getState() as unknown as ReplayDebugState;
  if (Object.prototype.hasOwnProperty.call(debug, 'debugStorageLookupLinearScans')) {
    useSessionStore.setState({
      debugStorageLookupLinearScans: 0,
      debugStorageIdAllocationCollisions: 0,
    } as never);
  }
}

function replay(sessionId: string, events: ReplayEnvelope[]): Message[] {
  const state = useSessionStore.getState();
  state.handleServerMessage({ type: 'history_start', sessionId } as never);
  for (const replayEvent of events) state.handleServerMessage(replayEvent as never);
  state.handleServerMessage({ type: 'history_end', sessionId } as never);
  return useSessionStore.getState().sessionMessages[sessionId] ?? [];
}

describe('Step 7B: indexed replay target lookup', () => {
  beforeEach(() => {
    resetStore();
  });

  it('reports zero linear target scans after the per-fold index is built', () => {
    const sessionId = 'step7b-cost';
    const events = [
      messageStart(sessionId, 'assistant-1'),
      messageStart(sessionId, 'assistant-2'),
      messageUpdate(sessionId, 'assistant-1', 'one'),
      messageUpdate(sessionId, 'assistant-2', 'two'),
      toolStart(sessionId, 'tool-1'),
      toolEnd(sessionId, 'tool-1', 'done'),
    ];
    const old = foldOld(events);
    const messages = replay(sessionId, events);
    const debug = useSessionStore.getState() as unknown as ReplayDebugState;

    // This property assertion is intentionally first-test RED before the
    // implementation adds the production cost witness.
    expect(Object.prototype.hasOwnProperty.call(debug, 'debugStorageLookupLinearScans')).toBe(true);
    expect(debug.debugStorageLookupLinearScans).toBe(0);
    expect(debug.debugStorageIdAllocationCollisions).toBe(0);
    expect(comparable(messages)).toEqual(comparable(old.messages));
    expect(old.linearScans).toBe(3);
  });

  it.each([1_000, 10_000])('matches the old fold exactly for %i messages across replay chunks', (messageCount) => {
    const sessionId = `step7b-large-${messageCount}`;
    const events = makeLargeFixture(sessionId, messageCount);
    const old = foldOld(events);
    const messages = replay(sessionId, events);
    const debug = useSessionStore.getState() as unknown as ReplayDebugState;

    expect(comparable(messages)).toEqual(comparable(old.messages));
    expect(debug.debugStorageLookupLinearScans).toBe(0);
    expect(debug.debugStorageIdAllocationCollisions).toBe(0);
    // Keep the old-vs-new operation witness in the test output/report. The
    // indexed implementation performs no target linear scans; index creation
    // itself is the intended O(N) per-fold work.
    console.info(`[step7b-cost] N=${messageCount} E=${messageCount * 2 + Math.floor(messageCount / 5)} oldLinearScans=${old.linearScans} newLinearScans=${debug.debugStorageLookupLinearScans}`);
  });

  it('preserves duplicate wire IDs, id-less latest-assistant fallback, late events, and tool targets', () => {
    const sessionId = 'step7b-semantics';
    const events = [
      messageStart(sessionId, 'commandcode-message-1'),
      messageUpdate(sessionId, 'commandcode-message-1', 'first'),
      event(sessionId, { type: 'message_end', message: { id: 'commandcode-message-1' } }),
      messageStart(sessionId, 'commandcode-message-1'),
      messageUpdate(sessionId, 'commandcode-message-1', 'second'),
      event(sessionId, { type: 'message_end', message: { id: 'commandcode-message-1' } }),
      messageStart(sessionId, 'pi-latest'),
      messageUpdate(sessionId, undefined, ' thinking', 'thinking_delta'),
      messageUpdate(sessionId, 'commandcode-message-1', ' late'),
      toolStart(sessionId, 'tool-target'),
      toolEnd(sessionId, 'tool-target', 'tool output'),
    ];
    const old = foldOld(events);
    const messages = replay(sessionId, events);
    const debug = useSessionStore.getState() as unknown as ReplayDebugState;

    expect(comparable(messages)).toEqual(comparable(old.messages));
    expect(messages.map((message) => message.id)).toEqual([
      'commandcode-message-1',
      'commandcode-message-1#2',
      'pi-latest',
      'tool-target',
    ]);
    expect(JSON.stringify(messages[0].content)).toContain('first');
    expect(JSON.stringify(messages[0].content)).not.toContain('late');
    expect(JSON.stringify(messages[1].content)).toContain('second');
    expect(JSON.stringify(messages[1].content)).toContain('late');
    expect(JSON.stringify(messages[2].content)).toContain('thinking');
    expect((messages[3].toolResult?.output)).toBe('tool output');
    expect(debug.debugStorageLookupLinearScans).toBe(0);
    expect(debug.debugStorageIdAllocationCollisions).toBe(1);
    expect(old.allocationCollisions).toBe(1);
  });

  it('keeps indexed replay output when a background session is switched into view', () => {
    const backgroundId = 'step7b-background';
    const events = [
      messageStart(backgroundId, 'background-1'),
      messageUpdate(backgroundId, 'background-1', 'background text'),
      toolStart(backgroundId, 'background-tool'),
      toolEnd(backgroundId, 'background-tool', 'background result'),
    ];
    const old = foldOld(events);
    const messages = replay(backgroundId, events);
    expect(useSessionStore.getState().currentSessionId).toBe('foreground');
    expect(comparable(messages)).toEqual(comparable(old.messages));

    useSessionStore.getState().switchSession(backgroundId);
    expect(useSessionStore.getState().currentSessionId).toBe(backgroundId);
    expect(comparable(useSessionStore.getState().messages)).toEqual(comparable(old.messages));
    expect(useSessionStore.getState().sessionCache.get(backgroundId)?.messages).toBe(useSessionStore.getState().messages);
    expect((useSessionStore.getState() as unknown as ReplayDebugState).debugStorageLookupLinearScans).toBe(0);
  });
});
