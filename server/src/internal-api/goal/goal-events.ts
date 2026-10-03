/**
 * Cross-runtime goal function (contract 1.27.0) — broker event bridge (Pi).
 *
 * The Pi goal-engine extension reports state changes through the WebSocket
 * extension-UI channel (`extension_status` key 'goal-engine', `widget_content`
 * /`widget_cleared` key 'goal-engine-status'). Those messages historically
 * never reached the Internal API event broker, so agents watching a session
 * could not see goal progress. This bridge listens to the same messages and,
 * treating the on-disk goal state as truth, publishes:
 *
 *  - `goal_state` — the full canonical projection after every UI notification;
 *  - `goal_end`   — once per transition into a terminal status
 *                   ('achieved' | 'failed' | 'cleared'), the watchable event.
 *
 * All errors are swallowed: the browser channel must never be disrupted by
 * broker-side problems, and missing disk state is answered with silence rather
 * than an invented projection.
 */

import type { SessionGoalProjection } from './types.js';
import { isTerminalGoalStatus } from './types.js';

export interface PiGoalEventBridge {
  (message: unknown): Promise<void>;
}

export interface CreatePiGoalEventBridgeDeps {
  /** Read the current authoritative projection; null/throw = unreadable → stay silent. */
  readProjection: () => Promise<SessionGoalProjection | null>;
  /** Broker publish callback (already bound to the right broker key). */
  publish: (event: { type: string; timestamp: number; data: unknown }) => void;
  /**
   * Wave K (contract 1.59.0, R6): live interruption hook. Invoked after the
   * `goal_state` publish whenever the projection reads paused/failed — the
   * server-side interruption sweep classifies it and continues once on
   * positive provider-abort evidence. Absent = no live handling (plain
   * bridging, byte-identical to pre-wave behaviour). Must never throw into
   * the bridge's caller.
   */
  /**
   * Wave K (contract 1.59.0, R6; correction 02 F4): live interception hook,
   * invoked BEFORE any terminal event is emitted whenever the projection is
   * paused or failed. Return true when this stop was INTERCEPTED (a typed,
   * positively auto-continuable provider stop whose continue was dispatched
   * and verified): the bridge then publishes only `goal_state` and suppresses
   * this stop's `goal_end`. Return false/undefined (or throw) for everything
   * else — the bridge emits exactly the pre-wave events. Must never break the
   * bridge's caller.
   */
  onPausedOrFailed?: (projection: SessionGoalProjection) => Promise<boolean | void>;
}

/** Extension UI keys owned by the goal engine. */
export const GOAL_STATUS_KEY = 'goal-engine';
export const GOAL_WIDGET_KEY = 'goal-engine-status';

function isGoalUiMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  if (m.type === 'extension_status') {
    const status = m.status as { key?: unknown } | undefined;
    return status?.key === GOAL_STATUS_KEY;
  }
  if (m.type === 'widget_content' || m.type === 'widget_cleared') {
    return m.key === GOAL_WIDGET_KEY;
  }
  return false;
}

export function createPiGoalEventBridge(deps: CreatePiGoalEventBridgeDeps): PiGoalEventBridge {
  let lastEmittedTerminal: string | null = null;

  return async (message: unknown): Promise<void> => {
    try {
      if (!isGoalUiMessage(message)) return;
      const projection = await deps.readProjection();
      if (!projection) return;

      const timestamp = Date.now();
      deps.publish({ type: 'goal_state', timestamp, data: projection });

      if (isTerminalGoalStatus(projection.status) && lastEmittedTerminal !== projection.status) {
        // F4: classify BEFORE the terminal event. An intercepted provider stop
        // (typed, fresh evidence; continue dispatched and verified) is not an
        // end — the sweep published the truthful auto_continued goal_state; the
        // goal_end for this stop is suppressed. Anything else ends as today.
        if (deps.onPausedOrFailed && (projection.status === 'paused' || projection.status === 'failed')) {
          let intercepted = false;
          try {
            intercepted = (await deps.onPausedOrFailed(projection)) === true;
          } catch { /* interception is best-effort */ }
          if (intercepted) return;
        }
        lastEmittedTerminal = projection.status;
        deps.publish({ type: 'goal_end', timestamp, data: projection });
      } else if (!isTerminalGoalStatus(projection.status)) {
        // A non-terminal observation re-arms terminal detection: a goal can be
        // achieved, cleared, then started again within one session.
        lastEmittedTerminal = null;
        if (deps.onPausedOrFailed && (projection.status === 'paused' || projection.status === 'failed')) {
          await deps.onPausedOrFailed(projection);
        }
      }
    } catch {
      /* never break the caller (WebSocket fan-out) or the broker */
    }
  };
}

// The bridge is a plain async function so callers compose it freely.
