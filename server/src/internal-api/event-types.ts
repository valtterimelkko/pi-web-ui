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
