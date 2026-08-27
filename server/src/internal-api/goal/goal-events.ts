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
        lastEmittedTerminal = projection.status;
        deps.publish({ type: 'goal_end', timestamp, data: projection });
      } else if (!isTerminalGoalStatus(projection.status)) {
        // A non-terminal observation re-arms terminal detection: a goal can be
        // achieved, cleared, then started again within one session.
        lastEmittedTerminal = null;
      }
    } catch {
      /* never break the caller (WebSocket fan-out) or the broker */
    }
  };
}

// The bridge is a plain async function so callers compose it freely.
