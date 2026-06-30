import { randomUUID } from 'node:crypto';
import type { AntigravityTurn } from './antigravity-session-store.js';

const ERROR_FALLBACK_BODY = 'The agent run failed.';

/**
 * Synthesize the normalized replay event stream for a session's persisted turns.
 *
 * Per turn:
 *  - Always emit `agent_start` + the user `message_*` triple (the prompt is
 *    durable from the moment the turn was started).
 *  - A `done` (or legacy, no-status) turn emits the assistant reply + `agent_end`.
 *  - An `error` turn emits an assistant message whose body is the response, the
 *    error text, or a generic fallback — then a closing `agent_end`. This keeps
 *    failed/timed-out turns visible on replay (RC2) instead of a blank screen.
 *  - A `running` turn (only seen for an orphaned in-flight turn after a
 *    crash/restart) emits the user message and STOPS — no assistant message, no
 *    `agent_end`. The streaming indicator is driven by
 *    `replayAntigravityHistory`'s `isStreaming` flag (isRunning(sessionId)),
 *    not a synthetic close, so the UI keeps showing the turn as in-flight.
 */
export function turnsToReplayEvents(turns: AntigravityTurn[], sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  for (const turn of turns) {
    const userId = randomUUID();

    events.push({ type: 'agent_start', sessionId });

    events.push({ type: 'message_start', message: { id: userId, role: 'user' } });
    events.push({
      type: 'message_update',
      message: { id: userId },
      assistantMessageEvent: { type: 'text_delta', delta: turn.prompt },
    });
    events.push({ type: 'message_end', message: { id: userId, role: 'user' } });

    // An in-flight turn has no assistant output yet; do not close it. The UI's
    // streaming indicator is set from isRunning() at the replay boundary.
    if (turn.status === 'running') {
      continue;
    }

    const assistantId = randomUUID();
    // error turns without a captured response surface the error text (or a
    // generic fallback) so the failure is visible instead of a blank screen.
    const assistantBody = turn.status === 'error'
      ? (turn.response || turn.error || ERROR_FALLBACK_BODY)
      : turn.response;

    events.push({ type: 'message_start', message: { id: assistantId, role: 'assistant' } });
    events.push({
      type: 'message_update',
      message: { id: assistantId },
      assistantMessageEvent: { type: 'text_delta', delta: assistantBody },
    });
    events.push({ type: 'message_end', message: { id: assistantId, role: 'assistant' } });

    events.push({ type: 'agent_end', result: null, usage: {} });
  }

  return events;
}
