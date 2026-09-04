/**
 * Structured SSE event-type registry (Task 12).
 *
 * A machine-readable catalogue of the normalized event kinds an agent can see on
 * the Internal API `/events` stream, so consumers no longer have to infer event
 * shapes from docs + source. The contracted types are derived from
 * {@link SSE_EVENT_TYPES} (single source of truth) so the registry cannot drift
 * from what the stream actually emits — enforced by tests.
 */

import { SSE_EVENT_TYPES } from './types.js';

export type EventCategory = 'agent' | 'message' | 'tool' | 'control';
export type StreamVerbosity = 'full' | 'tasks';

export interface EventTypeInfo {
  /** The `event:` name on the SSE stream (NormalizedEvent.type). */
  type: string;
  description: string;
  category: EventCategory;
  /** Stream verbosity levels that include this event (`full` = every event). */
  verbosity: StreamVerbosity[];
}

const FULL: StreamVerbosity[] = ['full'];
const BOTH: StreamVerbosity[] = ['full', 'tasks'];

export const EVENT_TYPE_REGISTRY: readonly EventTypeInfo[] = [
  { type: SSE_EVENT_TYPES.AGENT_START, description: 'A prompt turn started.', category: 'agent', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.AGENT_END, description: 'A prompt turn completed (carries token usage).', category: 'agent', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.TURN_START, description: 'Turn boundary start.', category: 'agent', verbosity: FULL },
  { type: SSE_EVENT_TYPES.TURN_END, description: 'Turn boundary end.', category: 'agent', verbosity: FULL },
  { type: SSE_EVENT_TYPES.MESSAGE_START, description: 'An assistant message started.', category: 'message', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.MESSAGE_UPDATE, description: 'Incremental assistant content (text delta).', category: 'message', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.MESSAGE_END, description: 'An assistant message finished.', category: 'message', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.TOOL_START, description: 'A tool call started (args included in full).', category: 'tool', verbosity: FULL },
  { type: SSE_EVENT_TYPES.TOOL_UPDATE, description: 'A tool call partial update.', category: 'tool', verbosity: FULL },
  { type: SSE_EVENT_TYPES.TOOL_END, description: 'A tool call finished (result included in full).', category: 'tool', verbosity: FULL },
  { type: SSE_EVENT_TYPES.TASK_STATUS, description: 'Human-readable tool status headline (tasks-mode rendering of tool_execution_start).', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.ERROR, description: 'An error during the turn.', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.COMPLETE, description: 'Terminal marker: the turn result is complete.', category: 'control', verbosity: FULL },
  // Documented runtime-emitted normalized events that also appear on the full stream:
  { type: 'stream_activity', description: 'Liveness heartbeat during long-running Claude channel turns.', category: 'control', verbosity: FULL },
  { type: 'session_compaction', description: 'Context compaction event.', category: 'control', verbosity: FULL },
  { type: 'permission_request', description: 'A tool permission/approval request (Claude channel / OpenCode).', category: 'control', verbosity: FULL },
  { type: 'ask_user_question_request', description: 'A Claude SDK AskUserQuestion dialog request awaiting a structured answer (answers/annotations or cancel).', category: 'control', verbosity: FULL },
  { type: 'ask_user_question_closed', description: 'A Claude SDK AskUserQuestion dialog closed for a non-answer reason (timeout/aborted/turn_end/disconnected). The reason is in data.reason.', category: 'control', verbosity: FULL },
  { type: SSE_EVENT_TYPES.GOAL_STATE, description: 'Goal function state snapshot (canonical projection, contract 1.27.0).', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.GOAL_END, description: 'Goal reached a terminal status (achieved|failed|cleared) — the watchable goal event.', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.MODEL_REBOUND, description: 'Dispatch re-applied the stored model binding before the turn (rehydration drift guard, contract 1.33.0).', category: 'control', verbosity: FULL },
  { type: SSE_EVENT_TYPES.BACKGROUND_CHILD_STATE, description: 'Background-subagent state changed on this session (launched/running/settled; contract 1.34.0).', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.CHILD_DISPATCHED, description: 'An Internal-API child session was created and linked to this parent session (contract 1.34.0).', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.CHILD_TURN_ENDED, description: 'A linked child session reached a terminal turn state (contract 1.34.0).', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.WATCH_REGISTERED, description: 'A durable watch was registered linking this session to a watched target (contract 1.34.0).', category: 'control', verbosity: BOTH },
  { type: SSE_EVENT_TYPES.WATCH_FIRED, description: 'A durable watch registered from this session fired and its wake was dispatched (contract 1.34.0).', category: 'control', verbosity: BOTH },
];

/** All registered event type names (drift-guard set). */
export const REGISTRY_EVENT_TYPES: readonly string[] = EVENT_TYPE_REGISTRY.map((e) => e.type);

/**
 * True iff every contracted {@link SSE_EVENT_TYPES} value is present in the
 * registry. Used by tests to prevent drift; exported for the route/tests.
 */
export function registryCoversSseEventTypes(): boolean {
  return Object.values(SSE_EVENT_TYPES).every((t) => REGISTRY_EVENT_TYPES.includes(t));
}
