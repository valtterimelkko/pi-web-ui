/**
 * useTalkerTurn — the browser's minimum voice-talker surface (brief H7,
 * transport seam; the finished Drive Mode UI is out of scope).
 *
 * Send an operator utterance to a worker session's talker and receive what
 * the operator hears. Replies arrive as `talker_turn_result` messages on the
 * talker bus (see lib/talkerBus.ts) — NOT through the session store, which
 * does not know this message type.
 *
 * The server applies the prompt-injection gate and the confirm-gated release
 * path; this hook adds no capability. `phase` distinguishes answered /
 * proposed / released / refused so a caller can speak the reply and know
 * whether the worker was touched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import {
  emitTalkerTurnResult,
  getLastTalkerTurnResult,
  getLastTalkerTurnResultFor,
  noteTalkerRequestIssued,
  subscribeTalkerTurnResults,
  type TalkerLaneIdentity,
  type TalkerRuntime,
  type TalkerTurnResult,
} from '../lib/talkerBus';

export interface SendTalkerTurnInput {
  workerSessionId: string;
  utterance: string;
  runtime?: TalkerRuntime;
  /** P18: the operator's focus/hold control, when it is on. Projection input
   *  for the talker only (it may suggest leaving focus); it can never switch
   *  the control and never touches the gate. */
  operatorFocus?: boolean;
  /**
   * D2: which bytes a confirmation releases — 'tidied' (default) the relay
   * text, 'original' the operator's raw words (the card's "Send my exact
   * words"). Sent only by the explicit original action; the server honours it
   * only on the confirm branch.
   */
  releaseVariant?: 'tidied' | 'original';
  /**
   * D-card: the identity of the proposal the confirming card displayed (the
   * `version` + `hash` the proposed payload carried). The server refuses the
   * release when it no longer matches the current draft. Transport only: this
   * hook passes it through verbatim and never derives it.
   */
  proposalRef?: { version: number; hash: string };
}

/**
 * One talker lane's transport.
 *
 * Multi-lane (2026-09-15): every send generates a client correlation id — an
 * existing optional wire field the server echoes on the result — and the bus
 * applies a result to this lane only when it carries this lane's id (see
 * lib/talkerBus.ts). With `lane` given, the subscription and the hydration
 * source are lane-scoped, so lane A never sees lane B's results and a late
 * result from a previous request never overwrites a newer card. Without
 * `lane`, behaviour is today's: unfiltered subscription, global hydration.
 */
export function useTalkerTurn(lane?: TalkerLaneIdentity) {
  const { sendMessage } = useWebSocket();
  const [lastResult, setLastResult] = useState<TalkerTurnResult | null>(
    lane ? getLastTalkerTurnResultFor(lane) : getLastTalkerTurnResult()
  );
  const pendingCount = useRef(0);
  const [awaitingReply, setAwaitingReply] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeTalkerTurnResults(
      (result) => {
        setLastResult(result);
        pendingCount.current = Math.max(0, pendingCount.current - 1);
        if (pendingCount.current === 0) setAwaitingReply(false);
      },
      lane
    );
    return unsubscribe;
  }, [lane?.workerSessionId, lane?.runtime]);

  const sendTalkerTurn = useCallback(
    (input: SendTalkerTurnInput): boolean => {
      if (!input.utterance || !input.utterance.trim()) return false;
      // Client-generated correlation id: the server echoes it on the result,
      // which is how THIS lane recognises (and only accepts) its own turn's
      // answer. Additive optional field — an old server just drops it.
      const laneId: TalkerLaneIdentity = {
        workerSessionId: input.workerSessionId,
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      };
      const requestId = noteTalkerRequestIssued(laneId);
      // E1 changed sendMessage's contract from boolean to
      // 'sent' | 'queued' | 'failed'. A queued message is still an accepted
      // send (it flushes on reconnect), so only 'failed' is a refusal here.
      const result = sendMessage({
        type: 'talker_turn',
        workerSessionId: input.workerSessionId,
        utterance: input.utterance,
        requestId,
        ...(input.runtime ? { runtime: input.runtime } : {}),
        ...(input.operatorFocus !== undefined ? { operatorFocus: input.operatorFocus } : {}),
        ...(input.releaseVariant !== undefined ? { releaseVariant: input.releaseVariant } : {}),
        // D-card: the echoed identity rides the same additive pattern — an old
        // server drops the field harmlessly (its guard never sees it).
        ...(input.proposalRef !== undefined ? { proposalRef: input.proposalRef } : {}),
      });
      const accepted = result !== 'failed';
      if (accepted) {
        pendingCount.current += 1;
        setAwaitingReply(true);
      }
      return accepted;
    },
    [sendMessage]
  );

  return { sendTalkerTurn, lastResult, awaitingReply };
}

/** Wire-side tap used by useWebSocket's onMessage: consumes talker results
 *  before the session store sees them (it would log them as drift). */
export function tapTalkerTurnMessage(message: unknown): boolean {
  return emitTalkerTurnResult(message);
}
