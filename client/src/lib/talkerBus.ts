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

import { recordBrowserDiagnostic } from './browserDiagnostics.js';
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

/** A lane subscription filter. Runtime is optional: omitted means "any
 *  runtime for this worker session" — but issuance always records a
 *  normalised runtime, so a lane that sends with the server default ('pi')
 *  still matches results that name it explicitly. */
export interface TalkerLaneIdentity {
  workerSessionId: string;
  runtime?: TalkerRuntime;
}

interface ListenerEntry {
  fn: Listener;
  lane?: TalkerLaneIdentity;
}

const listeners = new Set<ListenerEntry>();

/** Last result seen, so a late-mounting surface can hydrate (e.g. after a
 *  reconnect remount). Cleared never — it is one small object. Only ACCEPTED
 *  results land here; a stale or foreign result never overwrites it. */
let lastResult: TalkerTurnResult | null = null;

// ---------------------------------------------------------------------------
// Lane correlation (multi-lane voice, 2026-09-15).
//
// Results used to be filtered only by worker session, ignoring the request id
// and the runtime. With one lane per tab that was latent; with several lanes
// in ONE tab it is exactly how lane A's card appears in lane B, and how a late
// result from a previous request overwrites a newer card. The rule now:
//
//   A lane accepts a result only when the result
//     - carries a requestId THIS lane issued (the client generates one per
//       send — an existing optional wire field the server echoes back),
//     - has not been applied already (duplicate suppression), and
//     - is not OLDER than the newest result already applied (a late result
//       from a previous request never overwrites a newer card).
//
//   A result with NO requestId (an old server that drops the echo) is applied
//   only while the lane has nothing issued-and-unapplied and no correlated
//   card yet — it can never overwrite an id-correlated card.
//
// Identity is (workerSessionId, normalised runtime): a missing runtime means
// the server default 'pi', on both the send and the result side.
// ---------------------------------------------------------------------------

function normaliseRuntime(runtime: TalkerRuntime | undefined): TalkerRuntime {
  return runtime ?? 'pi';
}

function laneKeyOf(lane: TalkerLaneIdentity): string {
  return `${lane.workerSessionId}\u0000${normaliseRuntime(lane.runtime)}`;
}

/** Per-lane correlation record. One per (workerSessionId, runtime). */
export interface TalkerLaneRecord {
  /** Send-order sequence per issued requestId. */
  issued: Map<string, number>;
  /** RequestIds whose result has already been applied. */
  applied: Set<string>;
  /** Send-order sequence of the newest applied result; -1 when none. */
  lastAppliedSeq: number;
  /** True when the newest applied result was id-correlated. */
  lastWasCorrelated: boolean;
  /** The newest accepted result for this lane (hydration source). */
  last: TalkerTurnResult | null;
}

const laneRecords = new Map<string, TalkerLaneRecord>();
let requestCounter = 0;

function laneRecordFor(lane: TalkerLaneIdentity): TalkerLaneRecord {
  const key = laneKeyOf(lane);
  let record = laneRecords.get(key);
  if (!record) {
    record = { issued: new Map(), applied: new Set(), lastAppliedSeq: -1, lastWasCorrelated: false, last: null };
    laneRecords.set(key, record);
  }
  return record;
}

/** Generate one correlation id (visible shape only — never parsed). */
function generateRequestId(): string {
  requestCounter += 1;
  return `talker-req-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Record that THIS lane sent one talker turn; returns the correlation id to
 *  put on the wire (the server echoes it back on the result). */
export function noteTalkerRequestIssued(lane: TalkerLaneIdentity, requestId?: string): string {
  const record = laneRecordFor(lane);
  const id = requestId ?? generateRequestId();
  record.issued.set(id, record.issued.size);
  return id;
}

/** Decide — and record — whether this lane may apply one result. Mutates the
 *  record only on accept, so a rejected result changes nothing. */
function acceptTalkerResult(record: TalkerLaneRecord, result: TalkerTurnResult): boolean {
  const requestId = result.requestId;
  if (requestId !== undefined) {
    const seq = record.issued.get(requestId);
    if (seq === undefined) return false; // never issued by this lane
    if (record.applied.has(requestId)) return false; // duplicate delivery
    if (seq < record.lastAppliedSeq) return false; // late result from an older request
    record.applied.add(requestId);
    record.lastAppliedSeq = seq;
    record.lastWasCorrelated = true;
    record.last = result;
    return true;
  }
  // Legacy (no requestId): apply only when nothing correlated or in flight
  // could be contradicted by it.
  const hasInFlight = record.issued.size > record.applied.size;
  if (hasInFlight || record.lastWasCorrelated) return false;
  record.last = result;
  return true;
}

/** Lane membership of one delivered result. When the filter names a runtime
 *  it must match exactly; otherwise any runtime for the session belongs. */
function laneMatches(result: TalkerTurnResult, lane: TalkerLaneIdentity): boolean {
  if (result.workerSessionId !== lane.workerSessionId) return false;
  if (lane.runtime !== undefined && normaliseRuntime(result.runtime) !== lane.runtime) return false;
  return true;
}

/** Bounded observability for rejections (never text, never ids): which lane
 *  refused a result and why, so "why didn't my card update?" is answerable
 *  from the manual diagnostics bundle. */
function recordTalkerRejection(result: TalkerTurnResult): void {
  const record = laneRecords.get(laneKeyOf({ workerSessionId: result.workerSessionId, runtime: normaliseRuntime(result.runtime) }));
  let reason = 'unknown-lane';
  if (record) {
    if (result.requestId === undefined) reason = 'legacy-unattributable';
    else if (!record.issued.has(result.requestId)) reason = 'foreign-request';
    else if (record.applied.has(result.requestId)) reason = 'duplicate';
    else reason = 'stale-order';
  }
  try {
    recordBrowserDiagnostic({ kind: 'speech', operation: 'talker_result_rejected', state: reason });
  } catch {
    /* observation must never break the bus */
  }
}

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

/** Feed one wire message into the bus. Returns true when it was consumed.
 *  Consumption is not application: a result for an unknown lane, a duplicate,
 *  or a stale late arrival is consumed from the wire but REJECTED for every
 *  subscriber — it can never overwrite a lane's card. Rejections are observed
 *  in the browser diagnostic ring (bounded, no text, no ids). */
export function emitTalkerTurnResult(message: unknown): boolean {
  if (!isTalkerTurnResultMessage(message)) return false;
  const record = laneRecordFor({ workerSessionId: message.workerSessionId, runtime: normaliseRuntime(message.runtime) });
  if (!acceptTalkerResult(record, message)) {
    recordTalkerRejection(message);
    return true;
  }
  lastResult = message;
  for (const entry of listeners) {
    if (entry.lane && !laneMatches(message, entry.lane)) continue;
    try {
      entry.fn(message);
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

/** A filtered subscription delivers only this lane's accepted results (its
 *  worker session, and its runtime when the filter names one). */
export function subscribeTalkerTurnResults(listener: Listener, lane?: TalkerLaneIdentity): () => void {
  const entry: ListenerEntry = { fn: listener, ...(lane ? { lane } : {}) };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

export function getLastTalkerTurnResult(): TalkerTurnResult | null {
  return lastResult;
}

/** Hydration source for one lane: the newest result that lane applied. A
 *  late-mounting surface hydrates its OWN lane's result, never another
 *  lane's. */
export function getLastTalkerTurnResultFor(lane: TalkerLaneIdentity): TalkerTurnResult | null {
  return laneRecords.get(laneKeyOf(lane))?.last ?? null;
}

/** Test-only reset. */
export function resetTalkerTurnBus(): void {
  listeners.clear();
  lastResult = null;
  laneRecords.clear();
  requestCounter = 0;
}
