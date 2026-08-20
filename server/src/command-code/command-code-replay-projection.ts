import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * Read-side replay projection for Command Code journals.
 *
 * The journal faithfully records one `message_update` per native streaming
 * delta (per-token text/thinking), which is correct for live streaming but
 * pathological for replay: a single real session reached 7,423 message_update
 * events for one turn, and the browser re-rendered and string-concatenated
 * each one. Every other runtime coalesces history into whole messages before
 * replay; this module gives Command Code the same read-side collapse without
 * changing the write-side journal shape (the journal stays the exact,
 * append-only evidence record).
 *
 * Coalescing rule: runs of consecutive message_update events carrying the
 * same (message id, assistant event kind) merge into one event whose delta is
 * the concatenation. Runs never merge across kinds, ids, or interleaved
 * non-delta events, so visible ordering and content are preserved exactly.
 */
export function coalesceCommandCodeReplayEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  if (events.length <= 1) return [...events];
  const output: NormalizedEvent[] = [];
  for (const event of events) {
    const previous = output[output.length - 1];
    if (
      previous !== undefined &&
      event.type === 'message_update' &&
      previous.type === 'message_update' &&
      canMerge(previous, event)
    ) {
      mergeInto(previous, event);
      continue;
    }
    output.push(event);
  }
  return output;
}

/** Describes a coalescing pass for logs and diagnostics. */
export interface CommandCodeReplayCoalesceStats {
  inputCount: number;
  outputCount: number;
  /** message_update events removed from the wire by coalescing. */
  collapsed: number;
}

export function describeCommandCodeReplayCoalesce(input: NormalizedEvent[], output: NormalizedEvent[]): CommandCodeReplayCoalesceStats {
  const inputUpdates = input.filter((event) => event.type === 'message_update').length;
  const outputUpdates = output.filter((event) => event.type === 'message_update').length;
  return { inputCount: input.length, outputCount: output.length, collapsed: inputUpdates - outputUpdates };
}

interface AssistantDeltaEvent extends NormalizedEvent {
  type: 'message_update';
  data: {
    id?: unknown;
    assistantMessageEvent?: { type?: unknown; delta?: unknown };
  };
}

function asDeltaEvent(event: NormalizedEvent): AssistantDeltaEvent | undefined {
  if (event.type !== 'message_update') return undefined;
  const data = event.data as AssistantDeltaEvent['data'] | undefined;
  if (!data || typeof data !== 'object') return undefined;
  return event as AssistantDeltaEvent;
}

function deltaKind(event: AssistantDeltaEvent): 'text_delta' | 'thinking_delta' | undefined {
  const assistant = dataAssistantEvent(event);
  if (!assistant) return undefined;
  if (assistant.type !== 'text_delta' && assistant.type !== 'thinking_delta') return undefined;
  return typeof assistant.delta === 'string' ? assistant.type : undefined;
}

function dataAssistantEvent(event: AssistantDeltaEvent): { type: unknown; delta: unknown } | undefined {
  const assistant = event.data.assistantMessageEvent;
  if (!assistant || typeof assistant !== 'object') return undefined;
  return assistant as { type: unknown; delta: unknown };
}

function canMerge(previous: NormalizedEvent, current: NormalizedEvent): boolean {
  const previousDelta = asDeltaEvent(previous);
  if (!previousDelta) return false;
  const currentDelta = asDeltaEvent(current);
  if (!currentDelta) return false;
  if (previousDelta.data.id !== currentDelta.data.id) return false;
  return deltaKind(previousDelta) === deltaKind(currentDelta) && deltaKind(previousDelta) !== undefined;
}

function mergeInto(previous: NormalizedEvent, current: NormalizedEvent): void {
  const previousDelta = asDeltaEvent(previous)!;
  const currentDelta = asDeltaEvent(current)!;
  const kind = deltaKind(previousDelta)!;
  const previousAssistant = dataAssistantEvent(previousDelta)!;
  const currentAssistant = dataAssistantEvent(currentDelta)!;
  previousDelta.data.assistantMessageEvent = {
    type: kind,
    delta: `${previousAssistant.delta}${currentAssistant.delta}`,
  };
}
