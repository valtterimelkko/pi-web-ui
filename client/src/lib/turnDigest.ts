/**
 * turnDigest — the client half of the talker's digest transport (P17).
 *
 * The reading levels need the TALKER to digest a turn, so the surface needs a
 * way to ask for one that carries the worker's text and returns words for the
 * operator. This is deliberately NOT the operator-turn channel
 * (`talker_turn`): nothing here carries an operator utterance, so nothing here
 * can reach the operator's draft or the confirm-gated relay path. Summarising
 * runs in ONE direction only — the worker's words to the operator may be
 * condensed; the operator's words to the worker never may.
 *
 * Every wait is bounded. A talker that never answers must not leave the surface
 * silent forever: the caller falls back to reading the turn verbatim, which is
 * always available because it needs no model at all.
 */

/**
 * Bounded wait for a digest. Beyond this the model call is a failure, not
 * latency, and the raw answer is the honest fallback.
 *
 * Measured against the production talker model (google/gemma-4-26b-a4b-it,
 * thinking off) on 2026-09-14: 2.5s for a Headlines line, 4.7s for a Summary of
 * a four-sentence turn, 5.7s for a mid-flip remainder on a longer prompt. The
 * design's "~1s later first word" is the first TOKEN; this client waits for the
 * finished digest, so the bound is set with room above the measured worst case
 * rather than at the design's optimistic figure.
 */
export const DIGEST_TIMEOUT_MS = 12_000;

export type TurnDigestKind = 'summary' | 'headlines';
export type TurnDigestRuntime = 'pi' | 'claude' | 'antigravity';

/** Client → Server: digest this text for the operator. Additive message; the
 *  relay gate is untouched because this message has no delivery path. */
export interface TurnDigestRequestMessage {
  type: 'talker_digest';
  requestId: string;
  workerSessionId: string;
  runtime?: TurnDigestRuntime;
  kind: TurnDigestKind;
  /** The text to digest (the unplayed remainder, when the digest follows a
   *  partially heard turn). */
  text: string;
  /** What the operator has already heard, for context only: the digest must
   *  never repeat it. */
  spokenPrefix?: string;
}

export type TurnDigestRefusal = 'model_unconfigured' | 'unsafe_input' | 'empty_text';

/** Server → Client: the digest, or an honest statement that there is none. */
export interface TurnDigestResultMessage {
  type: 'talker_digest_result';
  requestId?: string;
  workerSessionId?: string;
  kind?: TurnDigestKind;
  /** Null when the talker could not produce one (see `refused` / `error`). */
  digest: string | null;
  refused?: TurnDigestRefusal;
  error?: string;
}

export type TurnDigestOutcome =
  | { ok: true; digest: string }
  | { ok: false; reason: 'refused' | 'failed' | 'timeout' };

let requestSeq = 0;

/** Unique per request, so a late answer can never be mistaken for the current
 *  one (the surface may re-plan mid-answer when the level changes). */
export function nextTurnDigestRequestId(): string {
  requestSeq += 1;
  return `digest-${Date.now().toString(36)}-${requestSeq}`;
}

interface PendingDigest {
  resolve: (outcome: TurnDigestOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingDigest>();

/** Structural wire check — a malformed frame is never mistaken for a digest. */
export function isTurnDigestResultMessage(message: unknown): message is TurnDigestResultMessage {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  return (
    msg.type === 'talker_digest_result' &&
    (msg.digest === null || typeof msg.digest === 'string') &&
    (msg.requestId === undefined || typeof msg.requestId === 'string')
  );
}

/**
 * Feed one wire message in. Returns true when it was consumed — the tap point in
 * useWebSocket consumes it before the session store, which does not know this
 * message type. A late or unknown-request answer is still consumed (and
 * dropped): it belongs to nothing.
 */
export function emitTurnDigestResult(message: unknown): boolean {
  if (!isTurnDigestResultMessage(message)) return false;
  const requestId = message.requestId;
  if (requestId === undefined) return true;
  const entry = pending.get(requestId);
  if (!entry) return true;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  const digest = typeof message.digest === 'string' ? message.digest.trim() : '';
  if (digest.length > 0) {
    entry.resolve({ ok: true, digest });
  } else {
    entry.resolve({ ok: false, reason: message.refused ? 'refused' : 'failed' });
  }
  return true;
}

/** Wait for the digest that answers `requestId`; always settles. */
export function awaitTurnDigest(
  requestId: string,
  timeoutMs: number = DIGEST_TIMEOUT_MS
): Promise<TurnDigestOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, reason: 'timeout' });
    }, Math.max(0, timeoutMs));
    pending.set(requestId, { resolve, timer });
  });
}

/** Test / teardown seam: settle everything waitlessly and forget it. */
export function resetTurnDigestBus(): void {
  for (const [requestId, entry] of pending) {
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, reason: 'failed' });
  }
}
