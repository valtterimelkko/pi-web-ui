/**
 * Watch Condition Evaluator
 *
 * A small, runtime-neutral predicate engine. It evaluates declarative
 * conditions against the common `NormalizedEvent` stream that every runtime
 * emits, so a watch never needs per-runtime code.
 *
 * The engine is intentionally generic ("function-agnostic"): it matches on
 * event types, tool calls, and text — not on any one feature. Compaction,
 * approvals, a specific tool finally being used, an assistant saying a
 * sentinel phrase — all are expressed through the same three primitives.
 *
 * Text matching is stateful on purpose. Assistant output arrives as a stream
 * of deltas across many `message_update` events, so a substring or regex that
 * spans delta boundaries would be missed if each event were tested in
 * isolation. The engine therefore accumulates assistant text for the current
 * turn and tests conditions against the rolling buffer. The buffer is reset at
 * each turn boundary to bound memory.
 */

import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { WatchConditionSpec, WatchConditionType } from '../types.js';

export interface ResolvedCondition {
  id: string;
  type: WatchConditionType;
  spec: WatchConditionSpec;
  once: boolean;
  regex?: RegExp;
}

export interface ConditionMatch {
  conditionId: string;
  eventType: string;
  evidence: string;
}

const EVIDENCE_MAX = 200;

/** Contract 1.47.0: bounds for the server-side `deadline` condition. */
export const DEADLINE_MIN_SECONDS = 1;
export const DEADLINE_MAX_SECONDS = 86_400;

function validateDeadlineSpec(spec: WatchConditionSpec): void {
  const n = spec.afterSeconds;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < DEADLINE_MIN_SECONDS || n > DEADLINE_MAX_SECONDS) {
    throw new Error(`deadline.afterSeconds must be an integer between ${DEADLINE_MIN_SECONDS} and ${DEADLINE_MAX_SECONDS}`);
  }
  if (spec.once === false) {
    throw new Error('deadline conditions fire exactly once; once:false is not supported');
  }
}

/** Assign a stable id, normalize defaults, and pre-compile any regex. */
export function resolveCondition(spec: WatchConditionSpec, index: number): ResolvedCondition {
  const id = spec.id && spec.id.trim() ? spec.id.trim() : `c${index}`;
  let regex: RegExp | undefined;
  if (spec.type === 'deadline') validateDeadlineSpec(spec);
  if (spec.type === 'text' && spec.pattern) {
    // A bad pattern should fail loudly at registration time, not silently at
    // match time, so we let the RegExp constructor throw here.
    regex = new RegExp(spec.pattern, spec.patternFlags ?? 'i');
  }
  return {
    id,
    type: spec.type,
    spec: { ...spec, id },
    once: spec.once !== false,
    regex,
  };
}

export function resolveConditions(specs: WatchConditionSpec[]): ResolvedCondition[] {
  return specs.map((spec, i) => resolveCondition(spec, i));
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > EVIDENCE_MAX ? `${clean.slice(0, EVIDENCE_MAX - 1)}…` : clean;
}

/**
 * Extract assistant text carried by a single event. Mirrors the shapes the
 * web UI and the live-validation recorder rely on: streamed `text_delta`s and
 * fully-formed `content` arrays both appear depending on runtime.
 */
function extractAssistantDelta(event: NormalizedEvent): string {
  if (event.type !== 'message_update' && event.type !== 'message_start') return '';
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (typeof data.text === 'string') return data.text;
  const ame = data.assistantMessageEvent as Record<string, unknown> | undefined;
  if (ame?.type === 'text_delta' && typeof ame.delta === 'string') return ame.delta;
  const content = ame?.content as Array<{ type: string; text?: string }> | undefined;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
  }
  return '';
}

/** Best-effort "any text this event carries" for `source: 'any'` text conditions. */
function extractAnyText(event: NormalizedEvent): string {
  const assistant = extractAssistantDelta(event);
  if (assistant) return assistant;
  const data = (event.data ?? {}) as Record<string, unknown>;
  for (const key of ['text', 'result', 'message', 'summary', 'content']) {
    const v = data[key];
    if (typeof v === 'string') return v;
  }
  return '';
}

function roleOf(event: NormalizedEvent): 'user' | 'assistant' | 'unknown' {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const nested = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>).role : undefined;
  const role = typeof data.role === 'string' ? data.role : nested;
  return role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'unknown';
}

/** Evidence for the first match in `haystack` that ends after `newFrom`, else null. */
function matchText(cond: ResolvedCondition, haystack: string, newFrom: number): string | null {
  if (cond.spec.contains) {
    const needle = cond.spec.contains;
    const start = Math.max(0, newFrom - needle.length + 1);
    if (haystack.indexOf(needle, start) === -1) return null;
    return truncate(`…${needle}…`);
  }
  if (cond.regex) {
    const flags = cond.regex.flags.includes('g') ? cond.regex.flags : `${cond.regex.flags}g`;
    const re = new RegExp(cond.regex.source, flags);
    for (const m of haystack.matchAll(re)) {
      if ((m.index ?? 0) + m[0].length > newFrom) return truncate(m[0] || cond.spec.pattern || 'match');
    }
    return null;
  }
  return null;
}

function shallowDataMatch(event: NormalizedEvent, match: Record<string, string | number | boolean>): boolean {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return Object.entries(match).every(([k, v]) => data[k] === v);
}

/**
 * Stateful matcher for one set of resolved conditions. Feed it every event for
 * a session via {@link ingest}; it returns the conditions that matched *this*
 * event. `once`-semantics and ledger persistence are the caller's job — the
 * engine only answers "what matched right now".
 */
export class ConditionEngine {
  private assistantBuffer = '';
  /** Buffer length before the current event's delta: matches must end past it. */
  private previousLength = 0;
  /** Role of the message currently streaming; user-role text never feeds the buffer. */
  private messageRole: 'user' | 'other' = 'other';

  constructor(private readonly conditions: ResolvedCondition[]) {}

  ingest(event: NormalizedEvent): ConditionMatch[] {
    // Reset the rolling assistant buffer at each turn boundary so a sentinel
    // from a previous turn cannot re-trigger a later turn's condition.
    if (event.type === 'agent_start') {
      this.assistantBuffer = '';
      this.messageRole = 'other';
    }
    if (event.type === 'message_start') this.messageRole = roleOf(event) === 'user' ? 'user' : 'other';
    // A prompt echo (user message_start, or a user text_delta replayed by
    // Antigravity / OpenCode) is not the assistant saying the sentinel.
    const userText = this.messageRole === 'user' || roleOf(event) === 'user';
    const delta = userText ? '' : extractAssistantDelta(event);
    if (event.type === 'message_end' && this.messageRole === 'user') this.messageRole = 'other';
    this.previousLength = this.assistantBuffer.length;
    if (delta) this.assistantBuffer += delta;

    const matches: ConditionMatch[] = [];
    for (const cond of this.conditions) {
      const evidence = this.matchOne(cond, event, delta);
      if (evidence !== null) {
        matches.push({ conditionId: cond.id, eventType: event.type, evidence });
      }
    }
    return matches;
  }

  /** Returns evidence string when the condition matches this event, else null. */
  private matchOne(cond: ResolvedCondition, event: NormalizedEvent, delta: string): string | null {
    const data = (event.data ?? {}) as Record<string, unknown>;

    switch (cond.type) {
      case 'event_type': {
        if (event.type !== cond.spec.eventType) return null;
        if (cond.spec.dataMatch && !shallowDataMatch(event, cond.spec.dataMatch)) return null;
        return truncate(`event ${event.type}`);
      }

      case 'tool': {
        const wantPhase = cond.spec.phase ?? 'start';
        const wantType = wantPhase === 'end' ? 'tool_execution_end' : 'tool_execution_start';
        if (event.type !== wantType) return null;
        if (cond.spec.toolName && data.toolName !== cond.spec.toolName) return null;
        if (cond.spec.argIncludes) {
          const payload = wantPhase === 'end' ? data.result : data.args;
          const str = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
          if (!str.includes(cond.spec.argIncludes)) return null;
        }
        const tool = typeof data.toolName === 'string' ? data.toolName : 'tool';
        return truncate(`${tool} (${wantPhase})`);
      }

      case 'text': {
        if (cond.spec.source === 'any') {
          const haystack = extractAnyText(event) || delta;
          if (!haystack) return null;
          return matchText(cond, haystack, 0);
        }
        // Assistant text: search the accumulated buffer so matches can span
        // deltas, but only when this event added text, and only for a match
        // that reaches into the new text — an occurrence fires once, not on
        // every later event of the turn.
        if (!delta) return null;
        return matchText(cond, this.assistantBuffer, this.previousLength);
      }

      // `deadline` is timer-driven by the WatchManager; events never match it.
      case 'deadline':
      default:
        return null;
    }
  }
}
