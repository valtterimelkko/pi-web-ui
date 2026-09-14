/**
 * useTurnDigest — ask the talker to digest a turn (P17 reading levels).
 *
 * Small on purpose: this hook only carries the request. What the digest is for
 * (and what happens when there is none) belongs to the answer reader, so this
 * seam can never grow into a second speech path.
 *
 * The gate is untouched by construction: the message carries text FROM the
 * worker TO the operator, and the server's digest handler has no delivery path
 * at all.
 */
import { useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import {
  awaitTurnDigest,
  nextTurnDigestRequestId,
  type TurnDigestKind,
  type TurnDigestOutcome,
  type TurnDigestRequestMessage,
  type TurnDigestRuntime,
} from '../lib/turnDigest';

export interface TurnDigestRequest {
  kind: TurnDigestKind;
  /** The text to digest — the unplayed remainder when the flip cut a turn short. */
  text: string;
  /** What the operator has already heard; never repeated by the digest. */
  spokenPrefix?: string;
}

export function useTurnDigest(workerSessionId: string, runtime?: TurnDigestRuntime | null) {
  const { sendMessage } = useWebSocket();

  const requestDigest = useCallback(
    (request: TurnDigestRequest): Promise<TurnDigestOutcome> => {
      const text = request.text.trim();
      // Nothing to digest, or nowhere to send it: the caller reads it verbatim.
      if (!workerSessionId || text.length === 0) {
        return Promise.resolve({ ok: false, reason: 'failed' });
      }
      const requestId = nextTurnDigestRequestId();
      // Typed against the mirrored wire shape so the client and the server
      // cannot drift apart silently.
      const message: TurnDigestRequestMessage = {
        type: 'talker_digest',
        requestId,
        workerSessionId,
        ...(runtime ? { runtime } : {}),
        kind: request.kind,
        text,
        ...(request.spokenPrefix ? { spokenPrefix: request.spokenPrefix } : {}),
      };
      const sent = sendMessage(message);
      if (sent === 'failed') {
        return Promise.resolve({ ok: false, reason: 'failed' });
      }
      // Register the wait only after an accepted send, so a refused send leaves
      // no timer behind.
      return awaitTurnDigest(requestId);
    },
    [sendMessage, workerSessionId, runtime]
  );

  return { requestDigest };
}
