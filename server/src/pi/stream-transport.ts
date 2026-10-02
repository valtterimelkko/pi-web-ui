/**
 * Streaming transport projection — WS-path memory robustness (2026-09-05).
 *
 * Why this exists: the Pi SDK's provider adapters emit `message_update` events
 * whose `message` and nested `assistantMessageEvent.partial` are aliases of one
 * mutable, continuously-growing output object. Forwarding those raw events over
 * a transport serialises the accumulated message on EVERY delta — quadratic
 * total traffic (measured: a 40 KB thinking message produced 162 MB of wire
 * bytes) and, when a consumer stalls, unbounded retention of already-created
 * strings. The same aliases also made the Internal API broker's cached replay
 * byte counts drift after insertion.
 *
 * Policy (aligned with the 1.31.0 invariant "broker is a notification bus, not
 * a content bus"; the browser client rebuilds streaming content from deltas
 * and falls back to a tracked session message id when updates carry none):
 *
 * - `message_update`: keep `message` as small identity/status fields only
 *   (`id`, `role`, `stopReason`, `errorMessage`); keep `assistantMessageEvent`
 *   delta semantics but NEVER the accumulated `partial`.
 * - `message_start`: keep the message but detach `content` (copy the array and
 *   shallow-copy each block) so later provider mutation cannot grow what we
 *   already sent or retained. Content at start is tiny (empty blocks or the
 *   transformed skill-loaded placeholder the client renders).
 * - Everything else — `message_end`, `turn_end`, `agent_*`, `tool_*`,
 *   `compaction_*`, extension events — passes through untouched: final
 *   messages and tool results are the authoritative content carriers.
 */

type StreamingEvent = Record<string, unknown> & {
  type?: string;
  message?: unknown;
  assistantMessageEvent?: unknown;
};

const MESSAGE_IDENTITY_FIELDS = ['id', 'role', 'stopReason', 'errorMessage'] as const;

function slimStreamingMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const source = message as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of MESSAGE_IDENTITY_FIELDS) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  return projected;
}

/** Shallow copy of an assistantMessageEvent without the accumulated `partial`. */
export function stripAssistantMessageEventPartial(assistantMessageEvent: unknown): unknown {
  if (!assistantMessageEvent || typeof assistantMessageEvent !== 'object' || Array.isArray(assistantMessageEvent)) {
    return assistantMessageEvent;
  }
  const source = assistantMessageEvent as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'partial') projected[key] = value;
  }
  return projected;
}

function detachMessageContent(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const source = message as Record<string, unknown>;
  if (!Array.isArray(source.content)) return message;
  const content = source.content.map((block) =>
    block && typeof block === 'object' && !Array.isArray(block)
      ? { ...(block as Record<string, unknown>) }
      : block,
  );
  return { ...source, content };
}

/** Hb2 (doubled-first-chunk fix): marker the manager's skill-content transform
 * sets on its synthetic placeholder message. The placeholder exists at emit
 * time by construction (it replaces the whole content array), and the client
 * renders it from the start frame — so the neutralisation below must preserve
 * it while stripping everything else. */
export const SKILL_CONTENT_MARKER = 'skill-content';

function isSkillMarkedMessage(message: unknown): boolean {
  return !!message
    && typeof message === 'object'
    && (message as Record<string, unknown>).customType === SKILL_CONTENT_MARKER;
}

/** Hb2 (doubled-first-chunk fix): the pi-ai adapters mutate ONE shared output
 * object in place as provider chunks land, and the agent loop emits
 * `message_start` with a shallow copy of it. The event crosses several async
 * hops before this projection runs, so the content array already holds the
 * first streamed chunk by then (captured live: start content "HB" + the same
 * "HB" again as the first text_delta — the browser rendered both). The wire
 * contract is that clients rebuild streamed content from deltas, so an
 * assistant start frame carries typed-EMPTY blocks: types and order are
 * preserved, streamed payloads are dropped. Synthetic (skill-marked) starts
 * and user-role frames pass through untouched. */
function neutraliseStreamedStartContent(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const source = message as Record<string, unknown>;
  if (!Array.isArray(source.content)) return source;
  const content = source.content.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const typed = block as Record<string, unknown>;
    if (typed.type === 'text') {
      return { ...typed, text: typeof typed.text === 'string' ? '' : typed.text };
    }
    if (typed.type === 'thinking') {
      return { ...typed, thinking: typeof typed.thinking === 'string' ? '' : typed.thinking };
    }
    return { ...typed };
  });
  return { ...source, content };
}

/**
 * Project a raw Pi SDK streaming event for any transport/retention boundary
 * (browser WebSocket fan-out, Internal API normalization/broker, direct SSE).
 * Terminal and tool events are returned as the SAME reference.
 */
export function projectStreamingEventForTransport<T extends StreamingEvent>(event: T): T {
  if (event.type === 'message_update') {
    return {
      ...event,
      message: slimStreamingMessage(event.message),
      assistantMessageEvent: stripAssistantMessageEventPartial(event.assistantMessageEvent),
    } as T;
  }
  if (event.type === 'message_start') {
    const detached = detachMessageContent(event.message);
    const role = detached && typeof detached === 'object'
      ? (detached as Record<string, unknown>).role
      : undefined;
    if (role === 'assistant' && !isSkillMarkedMessage(detached)) {
      return { ...event, message: neutraliseStreamedStartContent(detached) } as T;
    }
    return { ...event, message: detached } as T;
  }
  return event;
}
