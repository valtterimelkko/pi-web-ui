/**
 * Talker turn-result bus (brief H7 — client transport minimum).
 *
 * A tiny module-level listener bus so a hook can receive
 * `talker_turn_result` messages without routing them through the main
 * session store. The tap point is useWebSocket's onMessage, which forwards
 * here BEFORE handleServerMessage — the store does not know this message
 * type and would otherwise record it as protocol drift.
 *
 * Deliberately kept out of client/src/lib/websocket.ts (owned by the socket
 * durability work) and out of sessionStore.
 */

import { reportClientError } from './clientDiagnosticsReporter.js';

/** Which runtime adapter relays for a worker session (client mirror). */
export type TalkerRuntime = 'pi' | 'claude' | 'antigravity';

/**
 * Client-side mirror of the server's TalkerTurnResultMessage wire shape
 * (server/src/websocket/protocol.ts). Mirrored locally, matching the existing
 * convention in client/src/lib/websocket.ts — do not restructure the server
 * shape without updating this mirror (guarded by the structural check below).
 */
export type TalkerTurnResult = {
  type: 'talker_turn_result';
  requestId?: string;
  workerSessionId: string;
  runtime: 'pi' | 'claude' | 'antigravity';
  reply: string;
  phase: 'answered' | 'proposed' | 'released' | 'refused';
  /**
   * The harness's mechanical classification of the operator's utterance (P18).
   * Used for one decision only: an ELICITED reply (the answer to a question
   * the operator just asked) speaks at the answer tier; unprompted commentary
   * stays at the chatter tier. Absent on older/refused turns — never guessed.
   */
  utteranceClass?: 'confirm' | 'cancel' | 'question' | 'statement';
  refused?: 'prompt_injection' | 'model_unconfigured' | 'deliveries_unavailable';
  released: {
    utteranceId: number;
    text: string;
    delivery:
      | { outcome: 'delivered'; mechanism: 'steer' | 'prompt'; disclosure?: string }
      | { outcome: 'queued'; mechanism: 'follow_up'; disclosure: string }
      | { outcome: 'refused'; reason: string };
  } | null;
  cancelled: boolean;
  /**
   * Present only when the server reported phase === 'proposed' (mirror of the
   * server's `proposal` shape, P26/D1). `text` is the exact bytes a default
   * Confirm releases; `cleaned` is true only when tidying removed VISIBLE
   * content; `removed` carries the removed FRAGMENTS; `original` (D2) carries
   * the raw bytes an original-variant release sends. Absent on an older
   * server — never guessed.
   */
  proposal?: { text: string; cleaned: boolean; removed?: string; original?: string };
  /** Harness receipt ack (§4.1 rule 2) — mirror of the server wire shape. */
  receiptAck?: string;
  error?: string;
};

type Listener = (result: TalkerTurnResult) => void;

const listeners = new Set<Listener>();

/** Last result seen, so a late-mounting surface can hydrate (e.g. after a
 *  reconnect remount). Cleared never — it is one small object. */
let lastResult: TalkerTurnResult | null = null;

/** True when the message is a talker turn result (structural, wire-safe). */
export function isTalkerTurnResultMessage(message: unknown): message is TalkerTurnResult {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  return (
    msg.type === 'talker_turn_result' &&
    typeof msg.workerSessionId === 'string' &&
    typeof msg.reply === 'string' &&
    typeof msg.phase === 'string' &&
    ['answered', 'proposed', 'released', 'refused'].includes(msg.phase as string)
  );
}

/** Feed one wire message into the bus. Returns true when it was consumed. */
export function emitTalkerTurnResult(message: unknown): boolean {
  if (!isTalkerTurnResultMessage(message)) return false;
  lastResult = message;
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.error('[talkerBus] listener failed:', error);
      // P13: a surface listener crashing on a talker result is a client-side
      // failure the server would never see — make it queryable too.
      void reportClientError({
        operation: 'talker_listener',
        message: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'Error',
        stack: error instanceof Error ? error.stack : undefined,
        runtime: message.runtime,
        workerSessionId: message.workerSessionId,
      });
    }
  }
  return true;
}

export function subscribeTalkerTurnResults(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastTalkerTurnResult(): TalkerTurnResult | null {
  return lastResult;
}

/** Test-only reset. */
export function resetTalkerTurnBus(): void {
  listeners.clear();
  lastResult = null;
}
