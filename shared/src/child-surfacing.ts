/**
 * Child-orchestration surfacing projections (contract 1.34.0).
 *
 * Pure, wire-safe types + one-line renderers for the two card families the
 * child-surfacing work emits:
 *
 * - {@link ChildCardProjection} — one identity per dispatched child (a Pi
 *   harness background subagent OR an Internal-API child session), carried in
 *   `background_child_state` / `child_dispatched` / `child_turn_ended`
 *   normalized-event `data` payloads and rendered by the browser.
 * - {@link WatchCardProjection} — a durable watch linking a parent session to
 *   a watched target, carried in `watch_registered` / `watch_fired` payloads.
 *
 * Deliberately COUNTS/IDS/STATES only: no transcripts, no prompts, no secrets.
 * Everything here must be safe to place on the Internal API broker, the SSE
 * stream, and the browser websocket.
 */

/** Which orchestration rail produced this child. */
export type ChildCardKind = 'background_subagent' | 'internal_api_child';

export type ChildCardStatus = 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ChildCardProjection {
  /** Stable identity: background subagent = taskId (`bg_*`); Internal-API child = child session id. */
  id: string;
  kind: ChildCardKind;
  status: ChildCardStatus;
  /** Human label: agent name (background) or operator label / first-message slice (Internal-API child). */
  label: string;
  /** Child runtime, e.g. `'pi' | 'claude' | 'opencode' | 'antigravity' | 'commandcode'`. Background subagents are pi. */
  runtime?: string;
  /** Effective provider/model, e.g. `'openai-codex/gpt-5.6-luna'`. */
  model?: string;
  /** Verbatim creation selector when it differs from the resolved model (Internal-API children). */
  modelSelector?: string;
  /** Model echoed as resolved by the create response (Internal-API children). */
  resolvedModel?: string;
  cwd?: string;
  /** Delegated task text, truncated (background subagents). */
  task?: string;
  /** Background subagent persisted run id (`sa_*`). */
  runId?: string;
  /** Child session id for Internal-API children (same as {@link id}; explicit for renderers). */
  childSessionId?: string;
  /** Parent session id when linkage is known. */
  parentSessionId?: string;
  exitCode?: number;
  timedOut?: boolean;
  /** Epoch ms. */
  startedAt?: number;
  /** Epoch ms. */
  endedAt?: number;
  error?: string;
}

export type WatchCardStatus = 'active' | 'fired' | 'cancelled' | 'stale' | 'done';

/** Compact per-condition summary with a human description. */
export interface WatchConditionSummary {
  id?: string;
  type: 'event_type' | 'tool' | 'text' | (string & {});
  /** Human one-liner, e.g. `event agent_end`. */
  description: string;
  fired?: boolean;
  fireCount?: number;
  /** Epoch ms. */
  lastFiredAt?: number;
}

export interface WatchCardProjection {
  watchId: string;
  /** Session that armed the watch (parent), when linkage is known. */
  sourceSessionId?: string;
  /** Session being observed (child). */
  targetSessionId: string;
  label?: string;
  status: WatchCardStatus;
  conditions: WatchConditionSummary[];
  fireCount?: number;
  /** Epoch ms. */
  lastFiredAt?: number;
  /** How the most recent wake was delivered, when one fired (`prompt | follow_up | steer`). */
  deliveryKind?: string;
  /** Epoch ms. */
  createdAt?: number;
}

/** Loose raw condition shape accepted by {@link describeWatchCondition}. */
export interface RawWatchCondition {
  id?: string;
  type?: string;
  eventType?: string;
  toolName?: string;
  phase?: string;
  argIncludes?: string;
  contains?: string;
  pattern?: string;
  source?: string;
}

const MAX_TASK_CHARS = 200;

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function quote(value: string | undefined): string {
  return `'${(value ?? '').replace(/'/g, "'")}'`;
}

/** Human one-line description of a raw watch condition spec. Total — never throws. */
export function describeWatchCondition(cond: RawWatchCondition | undefined | null): string {
  if (!cond || typeof cond !== 'object') return 'unknown condition';
  if (cond.type === 'event_type' && cond.eventType) return `event ${cond.eventType}`;
  if (cond.type === 'tool' && cond.toolName) {
    const phase = cond.phase ? `@${cond.phase}` : '';
    const arg = cond.argIncludes ? ` argIncludes ${quote(cond.argIncludes)}` : '';
    return `tool ${cond.toolName}${phase}${arg}`;
  }
  if (cond.type === 'text') {
    if (cond.pattern !== undefined) return `text matches /${cond.pattern}/`;
    if (cond.contains !== undefined) {
      const src = cond.source === 'assistant' ? 'assistant ' : '';
      return `text ${src}contains ${quote(cond.contains)}`;
    }
  }
  return 'unknown condition';
}

/** Human one-line render of a child card, degrading gracefully on sparse data. */
export function childCardOneLine(card: ChildCardProjection): string {
  const parts: string[] = [card.label || card.id];
  if (card.kind === 'internal_api_child' && card.runtime) parts.push(card.runtime);
  if (card.modelSelector && card.model && card.modelSelector !== card.model) {
    parts.push(`${card.modelSelector} → ${card.model}`);
  } else if (card.model) {
    parts.push(card.model);
  }
  parts.push(card.status);
  let line = parts.join(' · ');
  if (card.error) line += ` — ${truncate(card.error, 80)}`;
  return line;
}

/** Human one-line render of a watch card (⏳ armed / 🔔 fired). */
export function watchCardOneLine(card: WatchCardProjection): string {
  const icon = card.status === 'fired' ? '🔔' : '⏳';
  const name = card.label || card.watchId;
  const first = card.conditions[0]?.description ?? 'watch';
  const suffix =
    card.status === 'fired' && card.deliveryKind
      ? `${card.status} → ${card.deliveryKind}`
      : card.status;
  return `${icon} ${name}: ${first} on ${card.targetSessionId} (${suffix})`;
}

export { MAX_TASK_CHARS };
