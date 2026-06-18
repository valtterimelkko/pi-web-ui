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

/** Assign a stable id, normalize defaults, and pre-compile any regex. */
export function resolveCondition(spec: WatchConditionSpec, index: number): ResolvedCondition {
  const id = spec.id && spec.id.trim() ? spec.id.trim() : `c${index}`;
  let regex: RegExp | undefined;
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

  constructor(private readonly conditions: ResolvedCondition[]) {}

  ingest(event: NormalizedEvent): ConditionMatch[] {
    // Reset the rolling assistant buffer at each turn boundary so a sentinel
    // from a previous turn cannot re-trigger a later turn's condition.
    if (event.type === 'agent_start') {
      this.assistantBuffer = '';
    }
    const delta = extractAssistantDelta(event);
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
        // For text, prefer the accumulated buffer so matches can span deltas.
        const haystack = cond.spec.source === 'any'
          ? extractAnyText(event) || delta
          : this.assistantBuffer;
        if (!haystack) return null;
        if (cond.spec.contains) {
          if (!haystack.includes(cond.spec.contains)) return null;
          return truncate(`…${cond.spec.contains}…`);
        }
        if (cond.regex) {
          const m = cond.regex.exec(haystack);
          if (!m) return null;
          return truncate(m[0] || cond.spec.pattern || 'match');
        }
        return null;
      }

      default:
        return null;
    }
  }
}
