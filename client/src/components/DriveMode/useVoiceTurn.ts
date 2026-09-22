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
 *   - mirror the harness's pending proposal: the exact text Confirm will
 *     release — the server's reported outgoing text when it sends one, else
 *     this surface's verbatim record of what was spoken (the server's own
 *     store remains the authority and releases its own text, never client
 *     text);
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
  TIER_ANSWER,
  TIER_RECEIPT_ACK,
  TIER_CHATTER,
  type SpeechTier,
} from '../../lib/speechArbiter';
import { spokenLedger } from '../../lib/spokenLedger';
import { laneFloor } from './voiceLanes';
import type { TalkerRuntime, TalkerTurnResult } from '../../lib/talkerBus';

/**
 * P18/3 — which tier the talker's reply speaks at.
 *
 * The ladder's tier 4 held two different things: a reply to a question the
 * operator just asked, and unprompted commentary. A direct answer is not
 * chatter — it is the conversation — and it must not be the first thing
 * dropped when anything else speaks. So the split is by ELICITATION, using the
 * harness's own mechanical classification (never a client guess):
 *
 *   the operator asked a question → TIER_ANSWER (3): queued, never dropped
 *   anything else                  → TIER_CHATTER (4): dropped if it would
 *                                    defer higher speech (§4.1 rule 4)
 *
 * The mechanical acks keep their own tier-2 slot, and an absent class (an
 * older server, a refused turn) falls back to chatter — never to a guess.
 */
export function replyTier(result: Pick<TalkerTurnResult, 'phase' | 'utteranceClass'>): SpeechTier {
  if (result.phase === 'released') return TIER_RECEIPT_ACK;
  return result.utteranceClass === 'question' ? TIER_ANSWER : TIER_CHATTER;
}

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
  /**
   * The SERVER's delivery outcome — the only thing that may decide whether the
   * surface says "sent" (operator incident 2026-09-16: a refused relay was
   * displayed in a green "Sent to the worker" box).
   * 'unknown' = an older server that reported no outcome; never rendered as a
   * success.
   */
  status: 'delivered' | 'queued' | 'refused' | 'unknown';
  /** Detail for display: the mechanism, or the refusal reason. */
  outcome: string;
}

/**
 * The proposal held for the operator's confirmation (P26).
 *
 * `text` is the exact bytes Confirm will release. `cleaned`/`removed` exist
 * ONLY when the server reports the proposal was tidied — absent on an older
 * server or an untouched utterance, in which case the surface makes no claim
 * and the card's "your words, exactly" stays truthful.
 */
export interface PendingProposal {
  text: string;
  cleaned?: boolean;
  removed?: string;
  /**
   * D2 (card-contract brief): the operator's raw words — the exact bytes an
   * original-variant release sends. The store held them all along; the server
   * reports them only when the tidying removed visible content, so a clean
   * utterance (or an older server) surfaces none. Never invented client-side.
   */
  original?: string;
  /**
   * D-card identity of the exact bytes this proposal displays: the server's
   * draft version and content hash. The confirm gestures echo it back as
   * `proposalRef`; a mismatch refuses the release instead of sending bytes
   * the operator never saw. Absent on an older server — then the gesture
   * sends nothing extra and behaves exactly as before.
   */
  version?: number;
  hash?: string;
}

/**
 * P26 — the harness's cleaned proposal, read defensively off the turn result.
 *
 * The agreed interface: a `proposed` result may carry a `proposal` object
 * holding the exact outgoing `text`, whether it was `cleaned`, what was
 * `removed`, and (D-card) the identity — `version` + `hash` — of those exact
 * bytes. The server side (P25) had NOT landed when this was written, so
 * every field is validated independently and anything absent or malformed
 * falls back to today's behaviour — the surface's own verbatim record, with
 * no cleaning claim and no identity. An old server therefore renders exactly
 * as before, and a malformed one can never put junk on the card. If the wire
 * names change, this is the ONE function to reconcile.
 */
function proposalFromResult(
  result: TalkerTurnResult
): Pick<PendingProposal, 'cleaned' | 'removed' | 'original' | 'version' | 'hash'> & { text?: string } | null {
  const raw = (result as { proposal?: unknown }).proposal;
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as { text?: unknown; cleaned?: unknown; removed?: unknown; original?: unknown; version?: unknown; hash?: unknown };
  const proposal: { text?: string; cleaned?: boolean; removed?: string; original?: string; version?: number; hash?: string } = {};
  if (typeof p.text === 'string' && p.text.length > 0) proposal.text = p.text;
  if (typeof p.cleaned === 'boolean') proposal.cleaned = p.cleaned;
  if (typeof p.removed === 'string') proposal.removed = p.removed;
  if (typeof p.original === 'string' && p.original.length > 0) proposal.original = p.original;
  if (typeof p.version === 'number' && Number.isFinite(p.version)) proposal.version = p.version;
  if (typeof p.hash === 'string' && p.hash.length > 0) proposal.hash = p.hash;
  return Object.keys(proposal).length > 0 ? proposal : null;
}

export interface UseVoiceTurnResult {
  /** Dictation pass-through. `starting` is the acquisition window: the browser
   *  may already be capturing while the recorder is still being set up, so the
   *  surface must show it rather than read as idle. */
  state: 'idle' | 'starting' | 'recording' | 'processing' | 'error';
  errorMessage: string;
  /** Takes the floor (starts/stops capture). Never disabled by playback. */
  toggle: () => void;
  /** True while the operator holds the floor (§4.1 rule 1). */
  operatorSpeaking: boolean;

  /** Send an operator utterance to the talker verbatim. Typed-fallback and
   *  retry share this path — the surface never rewrites the operator's words.
   *  Returns false when the send was refused (words are kept for retry). */
  sendText: (text: string) => boolean;

  /** The pending proposal — the exact text Confirm will release, plus the
   *  harness's cleaning facts when the server reports them (P26), the raw
   *  words the operator may choose instead (D2), and the identity of the
   *  exact bytes displayed (D-card), echoed on confirm. Null when nothing is
   *  pending. */
  pendingProposal: PendingProposal | null;
  confirmPending: () => boolean;
  cancelPending: () => boolean;
  /** D2 — release the operator's ORIGINAL words instead of the tidied relay
   *  text: the same confirm gesture carrying `releaseVariant: 'original'`.
   *  No-ops without a live proposal, exactly like confirmPending. */
  releaseOriginal: () => boolean;

  /** Last released relay (verbatim text + delivery outcome) for display. */
  lastReleased: ReleasedOutcome | null;
  /** Last refusal code, surfaced honestly. */
  refusal: string | null;

  /** Failed-send retry (verbatim-keep). */
  pendingText: string | null;
  /** Why the words are still here: the link was down, or the worker refused
   *  the relay (the two need different words on screen). */
  pendingReason: 'connection' | 'refused' | null;
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
  sdkType?: string | null,
  /** P18/2 — the operator's focus control. Projection input for the talker
   *  (so it can suggest leaving focus); it never gates capture or the send. */
  operatorFocus = false,
  /** Multi-lane: this surface is one lane of the in-page lane set. The floor
   *  signal then flows through the lane coordinator (one writer for the whole
   *  tab) and taking the mic hands the floor over from a capturing lane.
   *  Undefined = the shipped single-lane behaviour, byte for byte. */
  laneId?: string,
  /** Native-primary (Phase 2): when another engine (the native voice lane)
   *  owns capture, this hook owns NO floor — it registers with neither the
   *  lane coordinator nor the arbiter, so the two engines can never fight over
   *  the operator's floor signal. Default true = today's behaviour untouched. */
  floorEnabled = true,
): UseVoiceTurnResult {
  const runtime = talkerRuntimeFor(sdkType ?? undefined);
  // The lane identity: results are correlated on requestId plus THIS identity
  // (lib/talkerBus.ts), so another lane's answer can never become this
  // surface's card, and a late result from an older request cannot overwrite
  // a newer one.
  const { sendTalkerTurn, lastResult } = useTalkerTurn({
    workerSessionId,
    ...(runtime ? { runtime } : {}),
  });

  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null);
  const [lastReleased, setLastReleased] = useState<ReleasedOutcome | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [pendingReason, setPendingReason] = useState<'connection' | 'refused' | null>(null);

  // Verbatim record of the most recent utterance this surface sent — the
  // candidate a 'proposed' result refers to. Object reference, never
  // reconstructed from the reply text.
  const lastSentRef = useRef<string | null>(null);

  const attemptSend = useCallback(
    (
      text: string,
      opts?: {
        releaseVariant?: 'tidied' | 'original';
        /** D-card: the identity of the proposal the confirming card displayed. */
        proposalRef?: { version: number; hash: string };
      }
    ): boolean => {
      const accepted = sendTalkerTurn({
        workerSessionId,
        utterance: text,
        ...(runtime ? { runtime } : {}),
        // Sent only when focus is ON: the flag tells the talker the worker's
        // answers are not being spoken, so it can suggest leaving focus.
        ...(operatorFocus ? { operatorFocus: true } : {}),
        // D2: sent only for the explicit original action; the default confirm
        // path stays byte-identical to before (no field at all).
        ...(opts?.releaseVariant !== undefined ? { releaseVariant: opts.releaseVariant } : {}),
        // D-card: sent only by the confirming gestures, and only when the
        // server reported an identity to echo (an old server gets none).
        ...(opts?.proposalRef !== undefined ? { proposalRef: opts.proposalRef } : {}),
      });
      if (!accepted) {
        setPendingText(text);
        setPendingReason('connection');
        return false;
      }
      setPendingText(null);
      setPendingReason(null);
      lastSentRef.current = text;
      return true;
    },
    [sendTalkerTurn, workerSessionId, runtime, operatorFocus]
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
      // The server holds a proposal. Prefer the harness's exact outgoing text
      // (P25: the released bytes will equal what the card showed); fall back
      // to THIS surface's verbatim record of what was sent — which on an old
      // server, where the relay is verbatim, IS exactly what will go. The
      // cleaning facts and the identity (D-card) ride along only when the
      // server actually reported them; they are never guessed. On a stale-card
      // refusal the server sends THIS result with the CURRENT text and a new
      // identity, so the card re-shows what is really held.
      if (lastSentRef.current) {
        const fromServer = proposalFromResult(lastResult);
        setPendingProposal({
          text: fromServer?.text ?? lastSentRef.current,
          ...(fromServer?.cleaned !== undefined ? { cleaned: fromServer.cleaned } : {}),
          ...(fromServer?.removed !== undefined ? { removed: fromServer.removed } : {}),
          ...(fromServer?.original !== undefined ? { original: fromServer.original } : {}),
          ...(fromServer?.version !== undefined ? { version: fromServer.version } : {}),
          ...(fromServer?.hash !== undefined ? { hash: fromServer.hash } : {}),
        });
      }
    } else if (lastResult.phase === 'answered') {
      // Mechanically derived server-side: nothing pending after this turn.
      setPendingProposal(null);
    } else if (lastResult.phase === 'released' && lastResult.released) {
      setPendingProposal(null);
      setLastReleased({
        text: lastResult.released.text,
        status: lastResult.released.delivery.outcome,
        outcome: describeDelivery(lastResult.released.delivery),
      });
      // A REFUSED relay is not a delivered one, and the operator's words must
      // not vanish with it (operator incident 2026-09-16: the instruction was
      // lost and the surface looked like it had been sent). Keeping them puts
      // the retry path in reach.
      if (lastResult.released.delivery.outcome === 'refused') {
        setPendingText(lastResult.released.text);
        setPendingReason('refused');
      }
    }

    // Speak what the operator hears, at the ladder's tier (playback only —
    // this never gates capture). §4.1 rule 2: the harness's mechanical
    // receipt ack speaks FIRST (tier 2, before anything else). The
    // conversational reply speaks at the tier its elicitation earns (P18/3):
    // the answer to a question the operator just asked is the conversation and
    // QUEUES at the answer tier, while unprompted commentary stays at the
    // chatter tier, where it is dropped rather than delaying tiers 1–3 — so on
    // a receipt turn the receipt is what the operator hears, and the reply
    // remains in the harness record. Release acks are tier 2.
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
      // P18/3 — elicited reply vs unprompted commentary (see replyTier).
      const tier = replyTier(lastResult);
      speechArbiter.submit({
        id: lastResult.phase === 'released'
          ? `ack-${workerSessionId}-${lastResult.released?.utteranceId ?? 'x'}`
          : `chat-${workerSessionId}-${lastResult.reply.length}`,
        tier,
        text: lastResult.reply,
      });
    }
  }, [lastResult, workerSessionId]);

  /**
   * The confirm gestures echo the identity of the exact bytes the card
   * displayed (D-card): the server refuses the release when the draft no
   * longer matches them, instead of sending something the operator never
   * saw. No identity (an older server) → no echo, byte-identical behaviour.
   */
  const identityEcho = useCallback(
    (): { proposalRef: { version: number; hash: string } } | undefined =>
      pendingProposal?.version !== undefined && pendingProposal?.hash !== undefined
        ? { proposalRef: { version: pendingProposal.version, hash: pendingProposal.hash } }
        : undefined,
    [pendingProposal]
  );

  const confirmPending = useCallback((): boolean => {
    if (!pendingProposal) return false;
    return attemptSend(CONFIRM_UTTERANCE, identityEcho());
  }, [pendingProposal, attemptSend, identityEcho]);

  const cancelPending = useCallback((): boolean => {
    if (!pendingProposal) return false;
    return attemptSend(CANCEL_UTTERANCE);
  }, [pendingProposal, attemptSend]);

  /** D2 — the operator chose his own words. One gesture, one variant field:
   *  the server's single release path does the rest — and the D-card identity
   *  rides along, gated on what the card actually displayed. */
  const releaseOriginal = useCallback((): boolean => {
    if (!pendingProposal) return false;
    return attemptSend(CONFIRM_UTTERANCE, { releaseVariant: 'original', ...identityEcho() });
  }, [pendingProposal, attemptSend, identityEcho]);

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

  // Multi-lane: register this lane with the in-page floor coordinator so the
  // tab has ONE writer for the arbiter's floor and capture can be handed over
  // between lanes. Undefined laneId = today's single-lane path, untouched.
  // floorEnabled=false (native-primary): the native lane is the capture owner;
  // this hook stays mounted only for an explicit fallback and claims nothing.
  useEffect(() => {
    if (!laneId || !floorEnabled) return;
    laneFloor.registerLane(laneId);
    return () => laneFloor.unregisterLane(laneId);
  }, [laneId, floorEnabled]);

  useEffect(() => {
    if (!laneId || !floorEnabled) return;
    return laneFloor.setCaptureControls(laneId, { stopCapture: dictation.stopRecording });
  }, [laneId, floorEnabled, dictation.stopRecording]);

  /** §4.1 rule 1 — the operator's floor. Flows INTO the arbiter only. In
   *  lane mode it flows through the coordinator (one writer per tab: no
   *  lane's effect cycle can release another lane's floor). */
  const operatorSpeaking = dictation.state === 'recording';

  useEffect(() => {
    if (!floorEnabled) return;
    if (!laneId) {
      speechArbiter.setOperatorSpeaking(operatorSpeaking);
      return () => {
        speechArbiter.setOperatorSpeaking(false);
      };
    }
    laneFloor.setLaneCapture(laneId, operatorSpeaking);
    return () => {
      laneFloor.setLaneCapture(laneId, false);
    };
  }, [operatorSpeaking, laneId, floorEnabled]);

  /** The mic toggle. In lane mode, taking the mic while ANOTHER lane captures
   *  is the floor-handoff gesture (§4.4): the capturing lane's words are
   *  finalised into its own talker (never dropped), then capture starts here. */
  const handleToggle = useCallback(() => {
    if (floorEnabled && laneId && (dictation.state === 'idle' || dictation.state === 'error')) {
      laneFloor.yieldFloorTo(laneId);
    }
    dictation.toggle();
  }, [floorEnabled, laneId, dictation.state, dictation.toggle]);

  return {
    state: dictation.state,
    errorMessage: dictation.errorMessage,
    toggle: handleToggle,
    operatorSpeaking,
    sendText,
    pendingProposal,
    confirmPending,
    cancelPending,
    releaseOriginal,
    lastReleased,
    refusal,
    pendingText,
    pendingReason,
    retryLastSend,
    discardPending,
  };
}
