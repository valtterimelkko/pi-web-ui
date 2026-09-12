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
  subscribeTalkerTurnResults,
  type TalkerRuntime,
  type TalkerTurnResult,
} from '../lib/talkerBus';

export interface SendTalkerTurnInput {
  workerSessionId: string;
  utterance: string;
  runtime?: TalkerRuntime;
}

export function useTalkerTurn() {
  const { sendMessage } = useWebSocket();
  const [lastResult, setLastResult] = useState<TalkerTurnResult | null>(getLastTalkerTurnResult());
  const pendingCount = useRef(0);
  const [awaitingReply, setAwaitingReply] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeTalkerTurnResults((result) => {
      setLastResult(result);
      pendingCount.current = Math.max(0, pendingCount.current - 1);
      if (pendingCount.current === 0) setAwaitingReply(false);
    });
    return unsubscribe;
  }, []);

  const sendTalkerTurn = useCallback(
    (input: SendTalkerTurnInput): boolean => {
      if (!input.utterance || !input.utterance.trim()) return false;
      // E1 changed sendMessage's contract from boolean to
      // 'sent' | 'queued' | 'failed'. A queued message is still an accepted
      // send (it flushes on reconnect), so only 'failed' is a refusal here.
      const result = sendMessage({
        type: 'talker_turn',
        workerSessionId: input.workerSessionId,
        utterance: input.utterance,
        ...(input.runtime ? { runtime: input.runtime } : {}),
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
