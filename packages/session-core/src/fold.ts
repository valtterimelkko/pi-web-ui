/**
 * Events to messages: the HISTORY fold, extracted from
 * `client/src/store/sessionStore.ts` (command-centre step 1a). Pure apart from
 * the injectable clock. The store's live per-event handlers still carry their
 * own copies of these semantics; they are deliberately not rewritten here.
 */
import type { Message } from './model.js';

/** One buffered server message; foldable ones carry a Pi-format `event`. */
export type FoldBufferItem = { type: string; [key: string]: unknown };

export interface FoldOptions {
  /** Messages already in the session (copied, never mutated). */
  base?: Message[];
  /** Clock for timestamps and fallback ids; defaults to `Date.now`. */
  now?: () => number;
}

export interface FoldResult {
  messages: Message[];
  /** Non-foldable items, in order, for the caller's normal dispatch. */
  leftovers: FoldBufferItem[];
  diagnostics: {
    storageLookupLinearScans: number;
    storageIdAllocationCollisions: number;
  };
}

/** Flatten a tool result (string, `{content:[{text}]}`, or other object) to text. */
export function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const maybeContent = (result as { content?: Array<{ text?: string }> }).content;
    if (Array.isArray(maybeContent)) {
      return maybeContent.map((part) => part.text ?? '').join('');
    }
    return JSON.stringify(result);
  }
  return '';
}

/** Fold buffered history session_events into final Message objects.
 * Mirrors the per-event handlers' accumulation semantics (message_start /
 * message_update text+thinking deltas / tool start+end) but with ONE state
 * write at the end instead of a set() per event — the per-event path made a
 * 1,500-event Command Code replay clone the whole message array 1,500 times.
 * Non-foldable event types are returned as leftovers for normal dispatch. */
export function foldSessionEvents(
  buffer: FoldBufferItem[],
  options: FoldOptions = {},
): FoldResult {
  const base = options.base ?? [];
  const now = options.now ?? Date.now;
  // Copy base messages (and their content entries) so a chunked continuation
  // never mutates store-owned objects in place — downstream memoization
  // compares by reference, so mutated-in-place entries would skip re-renders.
  const messages: Message[] = base.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((part) => ({ ...part })) : m.content,
  }));
  const leftovers: Array<{ type: string; [key: string]: unknown }> = [];
  let activeMessageId: string | undefined;
  // The copied messages are the fold's working set. Index every existing
  // storage ID once, retaining the first entry for the same reason Array.find
  // did: tool/message IDs can be malformed or collide in old history.
  const storageIdIndex = new Map<string, Message>();
  let latestAssistantMessage: Message | undefined;
  for (const message of messages) {
    if (!storageIdIndex.has(message.id)) storageIdIndex.set(message.id, message);
    if (message.role === 'assistant') latestAssistantMessage = message;
  }
  const lookupDiagnostics = { linearScans: 0 };
  let storageIdAllocationCollisions = 0;
  // Command Code restarts its synthetic message numbering every agent turn, so
  // the same wire id (commandcode-message-1..N) legitimately appears once per
  // turn. Deltas must route to the LATEST copy of a reused id (the turn being
  // replayed), never merge into the first occurrence — first-match routing
  // produced a wall of empty "Processed" bubbles. Colliding storage ids are
  // suffixed (#2, #3…) so each turn renders as its own message.
  const usedIds = new Set(messages.map((m) => m.id));
  const latestByWireId = new Map<string, string>();
  /** Allocate the storage id for a NEW message_start with this wire id
   * (suffixed on collision with any earlier copy in this session). */
  const storageIdForStart = (wireId: string): string => {
    if (!usedIds.has(wireId)) return wireId;
    // Collision accounting is intentionally separate from target lookup work:
    // a duplicate wire ID is valid Command Code history and gets a suffix.
    storageIdAllocationCollisions++;
    let n = 2;
    while (usedIds.has(`${wireId}#${n}`)) n++;
    return `${wireId}#${n}`;
  };
  /** Pure lookup: never allocates. Falls back to the wire id itself. */
  const lookupId = (wireId: string): string => latestByWireId.get(wireId) ?? wireId;
  const findTarget = (id: string | undefined): Message | undefined => {
    if (id) {
      const mapped = lookupId(id);
      // Both the wire-ID projection and the storage-ID index are per-fold.
      // There is deliberately no linear fallback: an absent Map entry is the
      // same miss as the old array searches, without repeating O(N) work.
      return storageIdIndex.get(mapped) ?? storageIdIndex.get(id);
    }
    // Delta without an id targets the most recent assistant message (same
    // fallback semantics as the live handler's tracked current id). Tracking
    // it while building/appending the index preserves that fallback in O(1).
    return latestAssistantMessage;
  };
  for (const buffered of buffer) {
    const event = (buffered as { event?: { type?: string; [key: string]: unknown } }).event;
    if (!event || typeof event.type !== 'string') { leftovers.push(buffered); continue; }
    switch (event.type) {
      case 'message_start': {
        const message = (event as { message?: { id?: string; role?: string; content?: Message['content'] } }).message ?? {};
        const wireId = message.id || `msg_${now()}_${messages.length}`;
        const id = storageIdForStart(wireId);
        usedIds.add(id);
        latestByWireId.set(wireId, id);
        activeMessageId = wireId;
        const foldedMessage: Message = {
          id,
          role: (message.role as Message['role']) ?? 'assistant',
          // Structural extension marker (customType) rides along for the
          // talker's spoken-context scan; rendered projections ignore it.
          ...(typeof (message as { customType?: unknown }).customType === 'string'
            ? { customType: (message as { customType: string }).customType }
            : {}),
          // User bubbles can arrive with a plain string content from the wire;
          // keep it verbatim (Message.content allows it and user rendering
          // expects a string).
          content: message.content ?? (message.role === 'user' ? '' : []),
          timestamp: now(),
        };
        messages.push(foldedMessage);
        // Message starts normally have unique storage IDs. Keep first-match
        // behaviour for malformed collisions, matching the old array lookup.
        if (!storageIdIndex.has(id)) storageIdIndex.set(id, foldedMessage);
        if (foldedMessage.role === 'assistant') latestAssistantMessage = foldedMessage;
        break;
      }
      case 'message_update': {
        const message = (event as { message?: { id?: string } }).message;
        const target = findTarget(message?.id || activeMessageId);
        if (!target) break;
        const assistantEvent = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
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
        } else break;
        target.content = contentArray;
        break;
      }
      case 'message_end': {
        activeMessageId = undefined;
        break;
      }
      case 'tool_execution_start': {
        const raw = event as Record<string, unknown>;
        const toolCallId = (raw.toolCallId ?? raw.id) as string | undefined;
        const toolName = (raw.toolName ?? raw.name) as string | undefined;
        const args = raw.args ?? raw.input;
        const id = toolCallId || `tool_${now()}_${messages.length}`;
        const toolMessage: Message = {
          id,
          role: 'tool',
          content: '',
          timestamp: now(),
          toolCall: { id, name: toolName || 'unknown', args },
        };
        messages.push(toolMessage);
        // Tool IDs are not passed through message storage-ID allocation. Keep
        // the first map entry so duplicate/cross-role IDs retain Array.find's
        // historical first-match semantics.
        if (!storageIdIndex.has(id)) storageIdIndex.set(id, toolMessage);
        break;
      }
      case 'tool_execution_end': {
        const raw = event as Record<string, unknown>;
        const toolCallId = (raw.toolCallId ?? raw.id) as string | undefined;
        const args = raw.args ?? raw.input;
        const result = raw.result;
        const isError = raw.isError;
        const target = findTarget(toolCallId);
        if (!target || target.role !== 'tool') break;
        const content = extractToolResultText(result);
        target.content = content;
        // Replay parity: history events may carry args on the end event too.
        if (args !== undefined && target.toolCall) {
          target.toolCall = { ...target.toolCall, args };
        }
        target.toolResult = { output: content, isError: isError === true };
        break;
      }
      default:
        leftovers.push(buffered);
    }
  }
  return {
    messages,
    leftovers,
    diagnostics: {
      storageLookupLinearScans: lookupDiagnostics.linearScans,
      storageIdAllocationCollisions,
    },
  };
}

/**
 * Fold bare Pi-format events (as `normEventToPiFormat` emits them) into
 * messages. Leftovers are returned as bare events.
 */
export function foldEvents(
  events: Array<Record<string, unknown>>,
  options: FoldOptions = {},
): { messages: Message[]; leftovers: Array<Record<string, unknown>>; diagnostics: FoldResult['diagnostics'] } {
  const { messages, leftovers, diagnostics } = foldSessionEvents(
    events.map((event) => ({ type: 'session_event', event })),
    options,
  );
  return { messages, leftovers: leftovers.map((item) => item.event as Record<string, unknown>), diagnostics };
}
