/**
 * useVoiceTurn — the talker lane of the Voice Mode surface (plan Phase 4).
 *
 * Composes three existing pieces and adds no capability of its own:
 *   - `useDictation`   capture (unconditional — never gated by playback);
 *   - `useTalkerTurn`  the `talker_turn` transport and its result bus;
 *   - `speechArbiter`  playback scheduling (the frozen §4.1 ladder).
 *
 * Responsibilities (and nothing more):
 *   - route a finished transcript to the talker VERBATIM (never to the
 *     worker directly — the confirm-gated release path on the server is the
 *     only way speech reaches the worker);
 *   - mirror the harness's pending proposal with the operator's verbatim
 *     words (client-side record of what THIS surface sent when the server
 *     reports a proposal is held — the server's own store remains the
 *     authority and releases its own text, never client text);
 *   - speak talker output through the arbiter at the ladder's tiers
 *     (receipt ack tier 2, conversational reply tier 4);
 *   - keep a failed send's words for retry (a dropped utterance is the
 *     failure the operator named);
 *   - feed the operator's floor to the arbiter (capture-side signal only).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDictation } from '../../hooks/useDictation';
import { useTalkerTurn } from '../../hooks/useTalkerTurn';
import {
  speechArbiter,
  TIER_RECEIPT_ACK,
  TIER_CHATTER,
} from '../../lib/speechArbiter';
import { spokenLedger } from '../../lib/spokenLedger';
import type { TalkerRuntime } from '../../lib/talkerBus';

/** The explicit confirm gesture — classified 'confirm' server-side, which
 *  releases the server's OWN stored verbatim proposal. The surface never
 *  sends proposal text as a new utterance. */
export const CONFIRM_UTTERANCE = 'yes, send that';
/** The explicit cancel gesture — classified 'cancel' server-side. */
export const CANCEL_UTTERANCE = 'no, cancel that';

/**
 * Event identity for the mechanical acks (P16).
 *
 * The receipt ack is a CONSTANT string, and §4.1 rule 2 promises one for every
 * unacknowledged utterance — so the same words must be allowed to speak again
 * on a later turn. Acks are therefore scoped to the turn-result EVENT: the same
 * event never speaks twice (a replayed/retained result is a duplicate, not new
 * speech), while a new event always may. Identity is the result object itself,
 * held weakly so the record cannot retain results.
 */
const eventScopes = new WeakMap<object, number>();
let nextEventScope = 0;
function turnScope(result: object): string {
  let id = eventScopes.get(result);
  if (id === undefined) {
    id = nextEventScope++;
    eventScopes.set(result, id);
  }
  return `turn-${id}`;
}

export interface ReleasedOutcome {
  text: string;
  outcome: string;
}

export interface UseVoiceTurnResult {
  /** Dictation pass-through. */
  state: 'idle' | 'recording' | 'processing' | 'error';
  errorMessage: string;
  /** Takes the floor (starts/stops capture). Never disabled by playback. */
  toggle: () => void;
  /** True while the operator holds the floor (§4.1 rule 1). */
  operatorSpeaking: boolean;

  /** Send an operator utterance to the talker verbatim. Typed-fallback and
   *  retry share this path — the surface never rewrites the operator's words.
   *  Returns false when the send was refused (words are kept for retry). */
  sendText: (text: string) => boolean;

  /** The pending proposal, verbatim — exactly what the surface sent and the
   *  server reports as held. Null when nothing is pending. */
  pendingProposal: { text: string } | null;
  confirmPending: () => boolean;
  cancelPending: () => boolean;

  /** Last released relay (verbatim text + delivery outcome) for display. */
  lastReleased: ReleasedOutcome | null;
  /** Last refusal code, surfaced honestly. */
  refusal: string | null;

  /** Failed-send retry (verbatim-keep). */
  pendingText: string | null;
  retryLastSend: () => boolean;
  discardPending: () => void;
}

function describeDelivery(
  delivery: NonNullable<import('../../lib/talkerBus').TalkerTurnResult['released']>['delivery']
): string {
  switch (delivery.outcome) {
    case 'delivered':
      return `delivered (${delivery.mechanism})`;
    case 'queued':
      return `queued (${delivery.mechanism})`;
    case 'refused':
      return `refused — ${delivery.reason}`;
  }
}

const REFUSAL_TEXT: Record<string, string> = {
  prompt_injection:
    'Blocked by the prompt-injection gate — that utterance never reached the talker.',
  model_unconfigured:
    'The talker model is not configured for this session.',
  deliveries_unavailable:
    'The talker could not reach the worker delivery channels.',
};

/** Map a session's sdkType onto the talker runtime (talker scope: pi, claude,
 *  antigravity — others fall back to the server default, which refuses
 *  honestly if unsupported). Exported for the digest path (P17), which
 *  correlates with the same runtime. */
export function talkerRuntimeFor(sdkType: string | undefined): TalkerRuntime | undefined {
  if (sdkType === 'pi' || sdkType === 'claude' || sdkType === 'antigravity') {
    return sdkType;
  }
  return undefined;
}

export function useVoiceTurn(
  workerSessionId: string,
  sdkType?: string | null
): UseVoiceTurnResult {
  const { sendTalkerTurn, lastResult } = useTalkerTurn();
  const runtime = talkerRuntimeFor(sdkType ?? undefined);

  const [pendingProposal, setPendingProposal] = useState<{ text: string } | null>(null);
  const [lastReleased, setLastReleased] = useState<ReleasedOutcome | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);

  // Verbatim record of the most recent utterance this surface sent — the
  // candidate a 'proposed' result refers to. Object reference, never
  // reconstructed from the reply text.
  const lastSentRef = useRef<string | null>(null);

  const attemptSend = useCallback(
    (text: string): boolean => {
      const accepted = sendTalkerTurn({
        workerSessionId,
        utterance: text,
        ...(runtime ? { runtime } : {}),
      });
      if (!accepted) {
        setPendingText(text);
        return false;
      }
      setPendingText(null);
      lastSentRef.current = text;
      return true;
    },
    [sendTalkerTurn, workerSessionId, runtime]
  );

  const sendText = useCallback(
    (text: string): boolean => {
      if (!text || !text.trim()) return false;
      return attemptSend(text);
    },
    [attemptSend]
  );

  // React to talker results for THIS worker session only (the bus is global).
  useEffect(() => {
    if (!lastResult || lastResult.workerSessionId !== workerSessionId) return;

    if (lastResult.phase === 'refused') {
      const code = lastResult.refused ?? '';
      setRefusal(REFUSAL_TEXT[code] ?? `The talker refused the turn (${code || 'unknown'}).`);
      return; // the utterance never reached the talker; pending state untouched
    }
    setRefusal(null);

    if (lastResult.cancelled) {
      setPendingProposal(null);
    }

    if (lastResult.phase === 'proposed') {
      // The server holds a proposal. Show THIS surface's verbatim record of
      // what was sent — compared text, not the model's paraphrase in `reply`.
      if (lastSentRef.current) setPendingProposal({ text: lastSentRef.current });
    } else if (lastResult.phase === 'answered') {
      // Mechanically derived server-side: nothing pending after this turn.
      setPendingProposal(null);
    } else if (lastResult.phase === 'released' && lastResult.released) {
      setPendingProposal(null);
      setLastReleased({
        text: lastResult.released.text,
        outcome: describeDelivery(lastResult.released.delivery),
      });
    }

    // Speak what the operator hears, at the ladder's tier (playback only —
    // this never gates capture). §4.1 rule 2: the harness's mechanical
    // receipt ack speaks FIRST (tier 2, before anything else). The
    // conversational reply stays tier 4: per the decided ladder, chatter is
    // dropped, not queued, when it would delay tiers 1–3 — so on a receipt
    // turn the receipt is what the operator hears, and the reply remains in
    // the harness record. Release acks are tier 2; replies are tier 4.
    //
    // Every submission claims the shared spoken ledger first (P16): a
    // duplicate emission of THIS event is not repeated. The scope is the
    // event, not the words, because these mechanical acks are constant by
    // design and must speak again on the next turn.
    const scope = turnScope(lastResult);
    if (lastResult.receiptAck && spokenLedger.claim(lastResult.receiptAck, scope)) {
      speechArbiter.submit({
        id: `receipt-${workerSessionId}`,
        tier: TIER_RECEIPT_ACK,
        text: lastResult.receiptAck,
      });
    }
    if (lastResult.reply && spokenLedger.claim(lastResult.reply, scope)) {
      const tier =
        lastResult.phase === 'released' ? TIER_RECEIPT_ACK : TIER_CHATTER;
      speechArbiter.submit({
        id: lastResult.phase === 'released'
          ? `ack-${lastResult.released?.utteranceId ?? 'x'}`
          : `chat-${workerSessionId}-${lastResult.reply.length}`,
        tier,
        text: lastResult.reply,
      });
    }
  }, [lastResult, workerSessionId]);

  const confirmPending = useCallback((): boolean => {
    if (!pendingProposal) return false;
    return attemptSend(CONFIRM_UTTERANCE);
  }, [pendingProposal, attemptSend]);

  const cancelPending = useCallback((): boolean => {
    if (!pendingProposal) return false;
    return attemptSend(CANCEL_UTTERANCE);
  }, [pendingProposal, attemptSend]);

  const retryLastSend = useCallback((): boolean => {
    if (pendingText === null) return true;
    return attemptSend(pendingText);
  }, [pendingText, attemptSend]);

  const discardPending = useCallback((): void => {
    setPendingText(null);
  }, []);

  // Capture, with the transcript routed to the talker (verbatim). Capture is
  // unconditional: nothing here reads playback state.
  const handleTranscript = useCallback(
    (text: string) => {
      if (workerSessionId) attemptSend(text);
    },
    [workerSessionId, attemptSend]
  );
  const dictation = useDictation(handleTranscript, { runtime, workerSessionId });

  /** §4.1 rule 1 — the operator's floor. Flows INTO the arbiter only. */
  const operatorSpeaking = dictation.state === 'recording';

  useEffect(() => {
    speechArbiter.setOperatorSpeaking(operatorSpeaking);
    return () => {
      speechArbiter.setOperatorSpeaking(false);
    };
  }, [operatorSpeaking]);

  return {
    state: dictation.state,
    errorMessage: dictation.errorMessage,
    toggle: dictation.toggle,
    operatorSpeaking,
    sendText,
    pendingProposal,
    confirmPending,
    cancelPending,
    lastReleased,
    refusal,
    pendingText,
    retryLastSend,
    discardPending,
  };
}
