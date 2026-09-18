/**
 * The talker's PURE policy core (Voice Mode on Native Gemini Live, Phase L3).
 *
 * This module is the mechanical gate extracted from TalkerSession, expressed
 * as data-in / decision-out functions:
 *
 *     decideOperatorTurn({ utterance, turn, proposals, opts })  →  what this
 *         operator turn must do (release, refuse, cancel, or speak);
 *     decideAfterModelReply(decision, rawReply)  →  the model turn's effects.
 *
 * It is deliberately free of model calls and I/O: no logging, no stores it
 * writes, no adapters, no async, no clock. Everything it decides is a pure
 * function of the state it is given (see PURE PROPERTIES below), so the same
 * decision can be replayed — and differentially tested — against the
 * session's live behaviour, and embedded by a live harness that owns its own
 * transport.
 *
 * The gate itself is unchanged and non-negotiable (plan §10.9): the model has
 * no send path. The only branch that hands text to the worker is the release
 * decision produced here — and it can only fire against a live, fresh draft
 * that the operator has confirmed. Model output is never an input to that
 * decision; `decideAfterModelReply` can only SUPPRESS a draft append (the
 * end-anchored [[to-talker]] mark) or CREATE A CANDIDATE that still needs the
 * operator's own confirmation (the end-anchored [[ask-worker]] offer). It can
 * never release, and it can never widen what a later "yes" can reach.
 *
 * PURE PROPERTIES (pinned by talker-policy-core.differential.test.ts):
 *   - no imports from model clients, delivery adapters, observability or any
 *     I/O-bearing module; both decision functions are synchronous and return
 *     plain data;
 *   - `decideOperatorTurn` never mutates its inputs (the state view is
 *     treated as read-only, frozen in tests);
 *   - same state + same input → byte-identical decision, every time.
 *
 * TALKER SESSION DELEGATION. TalkerSession.handleOperatorTurnBody() builds the
 * state view (policyStateView), calls decideOperatorTurn, and executes the
 * decision: it records utterances, mutates the stores, calls the model and
 * the delivery adapter, and writes history. All branch selection — which
 * refusal fires, whether a release is allowed, what joins the draft, whether
 * a receipt is due — is owned here. `policyStateView` is the one read-only
 * adapter: it reads the live PendingProposalStore through its public API
 * (snapshotDraft / isLapsed / describeCurrentProposal) and produces the plain
 * data the decision function consumes. The store form of the call
 * (`decideOperatorTurn({ utterance, turn, proposals, opts })`) applies that
 * adapter itself, so an embedding harness can call the core directly.
 */

import {
  classifyOperatorUtterance,
  extractPostCancelInstruction,
  isMetaSendQuestion,
  isWorkerDirectedQuestion,
  resolveDraftSelection,
} from './utterance-classifier.js';
import { describeProposal } from './proposal-store.js';
import { ProposalNotFoundError, ProposalStore, UnknownPromotionRouteError } from './proposal-store.js';
import type {
  DraftSelection,
  DraftSnapshot,
  DraftUtteranceEntry,
  OrdinalPosition,
  Proposal,
  ProposalIdentity,
  ReleaseVariant,
} from './proposal-store.js';
import { ThreadStore } from './thread-store.js';
import { ParkingLot } from './parking-lot.js';
import {
  AskWorkerOffers,
  createReadOnlyKernelOperations,
  type FileContextReader,
  type KernelReadOnlyOperations,
  type WorkerHistoryReader,
} from './kernel-operations.js';
import { ReleaseStore } from './release-store.js';
import type { ReleaseOutcome, ReleaseRecord } from './release-store.js';
import { NOTHING_PENDING_ACK, NOTHING_TO_CANCEL_ACK } from './ack.js';
import { isAskWorkerOffer, stripAskWorkerMarker } from './ask-worker.js';
import type { UtteranceClass } from './types.js';

// ── State in ───────────────────────────────────────────────────────────────

/**
 * The draft state a decision needs, as plain data. `identity` is the D-card
 * identity of the CURRENT proposal (version counter + content hash) and
 * `lapsed` is the confirmation-window fact as of the decision's turn — both
 * read from the store by the caller (policyStateView). A view with utterances
 * but no identity can only refuse an echoed proposal identity (the safe
 * direction), never release on one.
 */
export interface PolicyDraftView {
  utterances: ReadonlyArray<Readonly<DraftUtteranceEntry>>;
  identity: ProposalIdentity | null;
  lapsed: boolean;
}

/** Everything decideOperatorTurn reads. Immutable by contract. */
export interface PolicyStateView {
  /** The turn being decided (1-based, already ticked by the caller). */
  turn: number;
  draft: PolicyDraftView | null;
}

/**
 * The read-only slice of a PendingProposalStore the adapter needs. Structural
 * on purpose: the core never imports the store class, so any implementation
 * with the same three read methods can drive it.
 */
export interface PolicyDraftSource {
  snapshotDraft(): DraftSnapshot | null;
  isLapsed(turn: number): boolean;
  describeCurrentProposal(): { version: number; hash: string } | null;
}

/** Per-turn input: the operator's utterance and the confirm gesture's options. */
export interface PolicyTurnInput {
  utterance: string;
  /** D-card: which bytes a release sends ('tidied' default). */
  releaseVariant?: ReleaseVariant;
  /** D-card: the identity the confirming card displayed, echoed back. */
  proposalRef?: { version: number; hash: string };
}

/**
 * The store form of the call (the shape a harness embeds): the core reads the
 * draft source itself via policyStateView. Pure in the same sense — the
 * source is only read, never written.
 */
export interface OperatorTurnRequest {
  utterance: string;
  turn: number;
  /** A live PendingProposalStore, or anything with the same read methods. */
  proposals: PolicyDraftSource;
  /** The confirm gesture's options. */
  opts?: {
    releaseVariant?: ReleaseVariant;
    proposalRef?: { version: number; hash: string };
  };
}

// ── Decisions out ──────────────────────────────────────────────────────────

/**
 * The five conversational shapes, each with exactly the mechanical effects
 * the session must execute. `draft`/`residue` append AFTER the model turn
 * unless the reply ends [[to-talker]]; `worker-directed` appends BEFORE the
 * model turn (so the projection the model reads includes the question it is
 * answering); `offer` appends only when the reply ends [[ask-worker]];
 * `plain` never appends.
 */
export type ConversationalPath = 'draft' | 'residue' | 'worker-directed' | 'offer' | 'plain';

export interface ConversationalPlan {
  path: ConversationalPath;
  /** True when this turn's utterance abandoned a held draft. */
  cancelled: boolean;
  /**
   * A post-cancel instruction residue located by the classifier, if any.
   * `draftable: false` residues are not recorded and never join a draft; they
   * only exist to explain why a cancel with no held draft is still
   * conversational (the operator did say something after the boundary).
   */
  cancelResidue: { text: string; draftable: boolean } | null;
  /**
   * Text that joins the draft after the model turn unless the reply ends
   * with the [[to-talker]] mark (null on paths that do not draft).
   */
  draftCandidate: { text: string; source: 'utterance' | 'residue' } | null;
  /**
   * The operator's own question, held as a draft candidate iff the reply ends
   * with the [[ask-worker]] offer marker (null on paths that cannot offer).
   */
  offerCandidate: { text: string } | null;
  /**
   * Whether this turn's batch is open (a receipt is due) when the model turn
   * keeps it — i.e. for `draft`/`residue` unless marked [[to-talker]] and for
   * `offer` iff the offer fires. Receipts are one per relay, never one per
   * utterance (plan §4.1 rule 2).
   */
  opensBatchWhenKept: boolean;
}

/** Per-decision metadata every executor needs. */
interface PolicyDecisionBase {
  /** The turn being decided (1-based). */
  turn: number;
  utterance: string;
  utteranceClass: UtteranceClass;
}

/**
 * The complete mechanical decision for one operator turn. Every branch the
 * old handleOperatorTurnBody took is one kind here; the executor switches on
 * `kind` and performs only the I/O the decision names. Exactly one release
 * kind exists — the single send path.
 */
export type PolicyDecision =
  | (PolicyDecisionBase & {
      kind: 'release';
      selection: DraftSelection | null;
      variant: ReleaseVariant;
    })
  | (PolicyDecisionBase & { kind: 'refuse-lapsed'; reply: string })
  | (PolicyDecisionBase & { kind: 'refuse-stale-card'; reply: string })
  | (PolicyDecisionBase & { kind: 'refuse-original-not-offered'; reply: string })
  | (PolicyDecisionBase & { kind: 'clarify-selection'; reply: string })
  | (PolicyDecisionBase & { kind: 'nothing-pending'; reply: string })
  | (PolicyDecisionBase & { kind: 'nothing-to-cancel'; reply: string })
  /** A cancel breath: clear the old draft; `plan` says whether a residue composes. */
  | (PolicyDecisionBase & { kind: 'cancel'; plan: ConversationalPlan })
  /** A conversational turn (statement, question, offer or markup-only). */
  | (PolicyDecisionBase & { kind: 'conversational'; plan: ConversationalPlan });

/** A decision whose whole turn is a model-free, fixed-vocabulary reply. */
export type MechanicalDecision = Extract<PolicyDecision, { reply: string }>;

/** Whether a decision is a model-free mechanical reply. */
export function isMechanicalDecision(decision: PolicyDecision): decision is MechanicalDecision {
  switch (decision.kind) {
    case 'refuse-lapsed':
    case 'refuse-stale-card':
    case 'refuse-original-not-offered':
    case 'clarify-selection':
    case 'nothing-pending':
    case 'nothing-to-cancel':
      return true;
    default:
      return false;
  }
}

/** A decision that proceeds to a conversational model turn. */
export type SpokenDecision = Extract<PolicyDecision, { plan: ConversationalPlan }>;

/**
 * The model turn's mechanically-decided effects. The session executes these;
 * the model never supplies anything but its reply text, and the reply it
 * supplies cannot create a send (append only ever adds a candidate).
 */
export interface PostModelPlan {
  /** The reply as the operator should hear it: protocol markers stripped. */
  reply: string;
  /** True when the reply offered to ask the worker (end-anchored marker). */
  askWorkerOffer: boolean;
  /** True when the reply marked the utterance addressed to the talker. */
  addressedToTalker: boolean;
  /** Text to append to the draft after the model turn (null when none). */
  append: { text: string; source: 'utterance' | 'residue' | 'offer' } | null;
  /** Final receipt condition: a composition batch is open after this turn. */
  opensBatch: boolean;
}

// ── Mechanical operator-facing replies ─────────────────────────────────────
//
// Like the release acks (ack.ts), these are produced by the harness from
// harness state — the only operator-facing words in them are the draft's own
// verbatim text — so the model can never compose, soften or suppress the
// safety-critical transitions: refusing a stale confirmation and asking for
// re-confirmation, clarifying an ambiguous selection, and refusing a
// confirm gesture whose echoed identity is out of date. The exact bytes of
// these strings are part of the pinned surface; they moved here verbatim when
// the policy core was extracted.

/** Quote the held draft's relay parts, in composition order. */
function quoteDraft(utterances: ReadonlyArray<{ text: string }>): string {
  return utterances.map(u => `"${u.text}"`).join(' ... ');
}

/** The lapsed-window refusal: quote the draft, re-ask, keep it. */
export function reconfirmAskReply(utterances: ReadonlyArray<{ text: string }>): string {
  return `You were composing something — still want that sent? Here is what I am holding: ${quoteDraft(utterances)}. Say yes and I will send it.`;
}

/** The ambiguous-selection clarification: number the parts, ask which. */
export function selectionClarifyReply(utterances: ReadonlyArray<{ text: string }>): string {
  const parts = utterances.map((u, i) => `${i + 1}. "${u.text}"`).join(' ');
  return `I am holding ${utterances.length} things — ${parts}. Which one?`;
}

/**
 * D-card — the stale-card refusal. The confirming gesture echoed the identity
 * of bytes that are no longer what is held (the draft moved underneath the
 * card: append-after-render, another lane or tab, a replace). Mechanical:
 * nothing is released, the draft is untouched, and the reply quotes the
 * CURRENT text so the operator can confirm against what is really held.
 */
export function staleProposalReply(utterances: ReadonlyArray<{ text: string }>): string {
  return `That card is out of date — the wording has changed since it was shown, so I sent nothing. Here is what I am holding now: ${quoteDraft(utterances)}. Confirm this current version and I will send it.`;
}

/**
 * D-card — the original-variant gate refusal. The current proposal advertised
 * no original (no visible removal happened), so the operator's raw words are
 * not a separate offer; a stale or buggy client cannot release raw bytes the
 * card never showed as a choice. Mechanical: nothing released, draft intact.
 */
export function originalNotOfferedReply(utterances: ReadonlyArray<{ text: string }>): string {
  return `Your exact raw words are not on offer here — nothing visible was taken out of what I am holding: ${quoteDraft(utterances)}. Say yes and I will send it as shown.`;
}

// ── The [[to-talker]] mark (P22) ───────────────────────────────────────────
//
// The draft gate had a hole on the talker's own side of the relay: an
// imperative addressed to the TALKER — "summarise what's been done", "read
// that back" — is not a question, so it classified as `statement` and was
// held, verbatim, as a pending WORKER instruction. The model then offered to
// send the operator's own words back at them, and a stray "yes" could
// release them.
//
// The repair is narrowing, in the [[ask-worker]] mould: the model may end a
// reply with an end-anchored [[to-talker]] tag when it judged the utterance
// was addressed to it and it answered from what it holds; the harness then
// does not draft the utterance. The consequences are mechanical and one-way:
//   - suppression only: the tag can keep words OUT of the draft, never put
//     anything in and never release anything — a wrong guess reduces what a
//     later "yes" can reach, so it is always the safe direction (the
//     mis-marked instruction meets the mechanical nothing-pending reply);
//   - honoured only on statement/residue turns — the core passes a draft
//     candidate nowhere else, so worker-directed questions and ask-the-worker
//     offers keep their own classification-based paths and model behaviour
//     cannot widen the gate;
//   - the tag is stripped wherever it appears: a protocol marker is never
//     spoken aloud, honoured or not.
// A marked utterance joins no draft, so it opens no composition batch and
// earns no receipt: the operator asked the talker, and the talker answered.

const ADDRESSED_TAG_AT_END = /\[\[\s*to-talker\s*\]\]\s*$/i;
const ADDRESSED_TAG_ANYWHERE = /\[\[\s*to-talker\s*\]\]/gi;

/** True when the reply ENDS with the tag (trailing whitespace tolerated). */
export function isAddressedToTalkerMark(reply: string): boolean {
  return ADDRESSED_TAG_AT_END.test(reply);
}

/** The reply as the operator should hear it: the tag removed. */
export function stripTalkerAddressedMarker(reply: string): string {
  return reply.replace(ADDRESSED_TAG_ANYWHERE, '').trim();
}

// ── Selection arithmetic (pure; mirrors proposal-store.ts) ───────────────

const ORDINAL_ORDER: OrdinalPosition[] = ['first', 'second', 'third', 'fourth', 'fifth'];

/**
 * Resolve an ordinal position to an index into a draft of `count` parts; null
 * when it selects nothing. The exact mirror of the store's private resolver —
 * an unresolved selection is ambiguous and never acts (§4.2 invariant 6).
 */
export function resolveOrdinalIndex(position: OrdinalPosition, count: number): number | null {
  if (count === 0) return null;
  if (position === 'last') return count - 1;
  const idx = ORDINAL_ORDER.indexOf(position);
  if (idx < 0 || idx >= count) return null;
  return idx;
}

/** Whether a selection resolves against a draft of `count` parts. */
export function selectionResolves(selection: DraftSelection, count: number): boolean {
  return resolveOrdinalIndex(selection.position, count) !== null;
}

/** Whether an echoed D-card identity still describes the current draft. */
function identityMatches(draft: PolicyDraftView, echo: { version: number; hash: string }): boolean {
  return draft.identity !== null && draft.identity.version === echo.version && draft.identity.hash === echo.hash;
}

// ── The pre-model decision ─────────────────────────────────────────────────

/**
 * Decide what one operator turn does, from harness state alone.
 *
 * Branch order is the gate: lapsed → stale identity → original variant →
 * ambiguous selection → release; a confirmation with nothing held is the
 * mechanical dead end; a cancel clears and (with a draftable residue) opens a
 * fresh composition batch; a worker-directed question drafts pre-model; every
 * other question may offer; a statement drafts post-model.
 *
 * There are no model calls and no I/O here: the returned decision is executed
 * by the session (or by any harness that embeds this core). The store form
 * (`decideOperatorTurn({ utterance, turn, proposals, opts })`) reads the
 * draft source through policyStateView and delegates to the same logic.
 */
export function decideOperatorTurn(request: OperatorTurnRequest): PolicyDecision;
export function decideOperatorTurn(state: PolicyStateView, input: PolicyTurnInput): PolicyDecision;
export function decideOperatorTurn(
  stateOrRequest: PolicyStateView | OperatorTurnRequest,
  input?: PolicyTurnInput
): PolicyDecision {
  if (isOperatorTurnRequest(stateOrRequest)) {
    const { utterance, turn, proposals, opts } = stateOrRequest;
    return decideFromState(policyStateView(proposals, turn), {
      utterance,
      ...(opts?.releaseVariant !== undefined ? { releaseVariant: opts.releaseVariant } : {}),
      ...(opts?.proposalRef !== undefined ? { proposalRef: opts.proposalRef } : {}),
    });
  }
  // The overloads guarantee the input is present here.
  return decideFromState(stateOrRequest, input as PolicyTurnInput);
}

function isOperatorTurnRequest(value: PolicyStateView | OperatorTurnRequest): value is OperatorTurnRequest {
  return (value as OperatorTurnRequest).proposals !== undefined;
}

function decideFromState(state: PolicyStateView, input: PolicyTurnInput): PolicyDecision {
  const utterance = input.utterance;
  const classified = classifyOperatorUtterance(utterance);
  const selection = resolveDraftSelection(utterance);
  // A selection shape ("just the second one") is mechanically a confirmation
  // of part of the draft — harness classification, same nature as the confirm
  // patterns, never model output; a release still requires a live fresh draft.
  const utteranceClass: UtteranceClass =
    selection !== null && classified === 'statement' ? 'confirm' : classified;

  const base = { turn: state.turn, utterance, utteranceClass };

  if (utteranceClass === 'confirm') {
    const draft = state.draft;
    if (draft && draft.lapsed) {
      // Stale confirmation (plan §4.2): refuse, quote the draft verbatim,
      // re-arm the window. Mechanical — the model never owns this transition
      // and never interprets the stale yes.
      return { ...base, kind: 'refuse-lapsed', reply: reconfirmAskReply(draft.utterances) };
    }
    if (draft) {
      // D-card identity gate: a mismatch means the draft moved under the card
      // (append-after-render, another lane or tab, a replace) — refuse the
      // send, keep the draft, quote the current text. A bare spoken "yes"
      // carries no echo and keeps today's semantics.
      if (input.proposalRef && !identityMatches(draft, input.proposalRef)) {
        return { ...base, kind: 'refuse-stale-card', reply: staleProposalReply(draft.utterances) };
      }
      // D-card variant gate: 'original' exists only where the CURRENT
      // proposal advertised one — a visible removal happened. A stale or
      // buggy client cannot release raw bytes the card never offered.
      const variant = input.releaseVariant ?? 'tidied';
      if (variant === 'original' && !describeProposal(draft.utterances).original) {
        return { ...base, kind: 'refuse-original-not-offered', reply: originalNotOfferedReply(draft.utterances) };
      }
      // Ambiguous selection: never acts (invariant 6). Mechanical
      // clarification; the draft is untouched.
      if (selection && !selectionResolves(selection, draft.utterances.length)) {
        return { ...base, kind: 'clarify-selection', reply: selectionClarifyReply(draft.utterances) };
      }
      return { ...base, kind: 'release', selection, variant };
    }
    // A confirmation with nothing pending is a DEAD END, and the harness owns
    // it (finding F2, P7): the fixed mechanical string — the truth, the way
    // out, no promise — with no model call. Nothing could be sent, so nothing
    // is promised.
    return { ...base, kind: 'nothing-pending', reply: NOTHING_PENDING_ACK };
  }

  if (utteranceClass === 'cancel') {
    // Finding F1 (P7): the cancel boundary ends the OLD draft, but an
    // instruction spoken AFTER the boundary in the same breath is captured —
    // the residue composes fresh instead of vanishing from the harness. The
    // residue is the operator's verbatim words; a release still needs its own
    // confirmation, so the gate is untouched.
    const cancelled = state.draft !== null;
    const residue = extractPostCancelInstruction(utterance);
    if (residue) {
      const residueClass = classifyOperatorUtterance(residue);
      const draftable =
        residueClass === 'statement' ||
        (residueClass === 'question' && !isMetaSendQuestion(residue) && isWorkerDirectedQuestion(residue));
      if (draftable) {
        return {
          ...base,
          kind: 'cancel',
          plan: {
            path: 'residue',
            cancelled,
            cancelResidue: { text: residue, draftable: true },
            draftCandidate: { text: residue, source: 'residue' },
            offerCandidate: null,
            // The residue opens a fresh composition batch (the cancel cleared
            // any held draft), so its answer-ready moment owes one receipt —
            // unless the model marks it addressed to the talker.
            opensBatchWhenKept: true,
          },
        };
      }
      // A residue that cannot be drafted is still operator speech: the turn
      // stays conversational (the model may answer it), and nothing joins.
      return {
        ...base,
        kind: 'cancel',
        plan: {
          path: 'plain',
          cancelled,
          cancelResidue: { text: residue, draftable: false },
          draftCandidate: null,
          offerCandidate: null,
          opensBatchWhenKept: false,
        },
      };
    }
    if (!cancelled) {
      // The F2 neighbouring dead-end: a cancel with nothing held reached the
      // model, which could claim a cancellation that never happened.
      // Mechanical honesty — there was nothing to cancel. A cancel that DID
      // clear a draft stays conversational: the model may truthfully
      // acknowledge it.
      return { ...base, kind: 'nothing-to-cancel', reply: NOTHING_TO_CANCEL_ACK };
    }
    return {
      ...base,
      kind: 'cancel',
      plan: { path: 'plain', cancelled, cancelResidue: null, draftCandidate: null, offerCandidate: null, opensBatchWhenKept: false },
    };
  }

  if (utteranceClass === 'question') {
    const metaSend = isMetaSendQuestion(utterance);
    const workerDirected = isWorkerDirectedQuestion(utterance);
    if (!metaSend && workerDirected) {
      // A draft-opening question is a receipt moment like any append
      // (§4.1 rule 2). Worker-directed questions join the draft BEFORE the
      // model turn (the projection the model answers includes the question).
      return {
        ...base,
        kind: 'conversational',
        plan: {
          path: 'worker-directed',
          cancelled: false,
          cancelResidue: null,
          draftCandidate: null,
          offerCandidate: null,
          opensBatchWhenKept: state.draft === null,
        },
      };
    }
    // P18/1: a question the talker was asked to ANSWER may be offered for
    // relay if the talker cannot answer it. Whether the offer fires is
    // decided after the model turn (the marker) and it only ever creates a
    // candidate: a delivery still needs the operator's own confirmation.
    // A meta question about the send in flight ("did you send it?") keeps
    // the draft untouched and can never become a candidate.
    const offerCandidate = !metaSend && !workerDirected ? { text: utterance } : null;
    return {
      ...base,
      kind: 'conversational',
      plan: {
        path: 'offer',
        cancelled: false,
        cancelResidue: null,
        draftCandidate: null,
        offerCandidate,
        opensBatchWhenKept: offerCandidate !== null && state.draft === null,
      },
    };
  }

  // A statement ACCUMULATES into the draft — the operator's composing thread
  // (plan §4.2). The append happens after the model turn (in the session's
  // executor) so the model can first judge whether the utterance was
  // addressed to the talker itself ([[to-talker]], P22). Unmarked, the
  // operator's verbatim words join the draft and the batch this utterance
  // opened still owes its one receipt; marked, nothing is held and no batch
  // opened — no receipt either.
  return {
    ...base,
    kind: 'conversational',
    plan: {
      path: 'draft',
      cancelled: false,
      cancelResidue: null,
      draftCandidate: { text: utterance, source: 'utterance' },
      offerCandidate: null,
      opensBatchWhenKept: state.draft === null,
    },
  };
}

// ── The post-model decision ────────────────────────────────────────────────

/**
 * Decide the mechanical effects of the model's reply for a spoken turn
 * (conversational or cancel-with-model): which protocol markers are honoured,
 * what (if anything) joins the draft, the reply the operator actually hears,
 * and whether a receipt is due.
 *
 * The honouring rules are deliberately narrow and one-way:
 *   - [[to-talker]] is honoured only where a draft candidate existed (never
 *     on worker-directed questions, offers or plain questions) and only when
 *     it ENDS the reply; it can only suppress an append, never create one;
 *   - [[ask-worker]] is honoured only on the offer path and only when it
 *     ENDS the reply; it creates a candidate holding the OPERATOR'S question
 *     — never the model's words — which still needs the operator's own
 *     confirmation;
 *   - both markers are always stripped from what the operator hears.
 */
export function decideAfterModelReply(decision: PolicyDecision, rawReply: string): PostModelPlan {
  if (decision.kind !== 'conversational' && decision.kind !== 'cancel') {
    throw new Error(`decideAfterModelReply requires a spoken decision, got '${decision.kind}'`);
  }
  const plan = decision.plan;

  const addressedToTalker =
    (plan.path === 'draft' || plan.path === 'residue') &&
    plan.draftCandidate !== null &&
    isAddressedToTalkerMark(rawReply);
  const askWorkerOffer = plan.path === 'offer' && plan.offerCandidate !== null && isAskWorkerOffer(rawReply);

  let append: PostModelPlan['append'] = null;
  if ((plan.path === 'draft' || plan.path === 'residue') && !addressedToTalker && plan.draftCandidate) {
    append = { text: plan.draftCandidate.text, source: plan.draftCandidate.source };
  } else if (askWorkerOffer && plan.offerCandidate) {
    append = { text: plan.offerCandidate.text, source: 'offer' };
  }

  let opensBatch: boolean;
  if (plan.path === 'worker-directed') {
    // Appended before the model turn; no marker can change the batch state.
    opensBatch = plan.opensBatchWhenKept;
  } else if (plan.path === 'offer') {
    opensBatch = askWorkerOffer && plan.opensBatchWhenKept;
  } else if (plan.path === 'draft' || plan.path === 'residue') {
    opensBatch = !addressedToTalker && plan.opensBatchWhenKept;
  } else {
    opensBatch = false;
  }

  return {
    reply: stripTalkerAddressedMarker(stripAskWorkerMarker(rawReply)),
    askWorkerOffer,
    addressedToTalker,
    append,
    opensBatch,
  };
}

/**
 * A plain (never-drafting, never-offering) conversational decision.
 *
 * Used only by TalkerSession.release()'s defensive branch: a direct call to
 * the release path that finds nothing to take (unreachable through
 * handleOperatorTurn, which checks the same state first) falls back to a
 * conversational turn — it must not crash and it must not relay. Keeping the
 * decision shape here keeps policy-core the single owner of what a turn
 * decision looks like.
 */
export function plainConversationalDecision(
  utterance: string,
  utteranceClass: UtteranceClass,
  turn: number
): SpokenDecision {
  return {
    turn,
    utterance,
    utteranceClass,
    kind: 'conversational',
    plan: {
      path: 'plain',
      cancelled: false,
      cancelResidue: null,
      draftCandidate: null,
      offerCandidate: null,
      opensBatchWhenKept: false,
    },
  };
}

// ── The read-only store adapter ────────────────────────────────────────────

/**
 * Build the plain-data state view from a live PendingProposalStore (or any
 * object with the same three read-only methods). Pure by construction: it
 * reads, never writes, and the store's `isLapsed(turn)` arithmetic stays the
 * single source of truth for the confirmation window.
 */
export function policyStateView(source: PolicyDraftSource, turn: number): PolicyStateView {
  const snapshot = source.snapshotDraft();
  if (!snapshot) return { turn, draft: null };
  const identity = source.describeCurrentProposal();
  return {
    turn,
    draft: {
      utterances: snapshot.utterances,
      identity: identity ? { version: identity.version, hash: identity.hash } : null,
      lapsed: source.isLapsed(turn),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOST AUTHORITY KERNEL (Voice Mode execution plan, Phase 2 / Track A)
//
// The four objects — Thread, Parking Lot, Proposal, Release — live here
// together for the first time, orchestrated by this module. The kernel owns
// no transport and no prompt authority: authority is the mechanical path
// below, and everything a caller can do is one of:
//
//   threads.append(...)          conversation (unsendable; no route out)
//   ops.parkItem/...             parking and read-only retrieval
//   promote(...)                 one of the three explicit promotion routes,
//                                which creates the lane's one live Proposal
//   confirm(...)                 a card-identity-checked, idempotent Release
//   recordDelivery/reconcile     the receipt, including first-class 'unknown'
//
// `confirm` is the only method that can authorise a delivery, and it can only
// authorise a Proposal that a promotion route created. There is deliberately
// no method that accepts a ThreadTurn, and no route from a thread turn to a
// release (N1, N8) — pinned by four-objects.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Read sources the read-only operations may draw on (empty by default). */
export interface HostAuthorityKernelOptions {
  history?: WorkerHistoryReader;
  files?: FileContextReader;
  now?: () => number;
}

const EMPTY_HISTORY: WorkerHistoryReader = { recent: () => [], total: () => 0 };
const EMPTY_FILES: FileContextReader = { read: () => null };

/**
 * A proposal is created only by one of these three shapes (intent §18.1).
 * `direct_address` carries the operator's own bytes; `accepted_offer` and
 * `parked_item_promotion` take their bytes from the offer/parked item — never
 * from the caller, and never from the model.
 */
export type KernelPromotionInput =
  | {
      route: 'direct_address';
      laneId: string;
      tidied: string;
      original?: string;
      sourceUtteranceId: number;
      createdTurn: number;
    }
  | {
      route: 'accepted_offer';
      laneId: string;
      offerId: string;
      sourceUtteranceId: number;
      createdTurn: number;
    }
  | {
      route: 'parked_item_promotion';
      laneId: string;
      parkedItemId: string;
      sourceUtteranceId: number;
      createdTurn: number;
    };

export interface KernelConfirmationInput {
  proposalId: string;
  /** The identity the confirming card displayed, echoed back. */
  identity: { version: number; sha256: string };
  /** One release per proposal and per key; a repeat is a duplicate refusal. */
  idempotencyKey: string;
  variant?: ReleaseVariant;
}

export type KernelConfirmationResult =
  | { kind: 'authorised'; proposal: Proposal; idempotencyKey: string; targetLane: string }
  | { kind: 'duplicate_refusal'; proposalId: string; idempotencyKey: string; prior: ReleaseRecord | null }
  | {
      kind: 'refused';
      reason: 'not_found' | 'not_live' | 'stale' | 'original_not_offered';
      proposal: Proposal | null;
    };

export interface KernelDeliveryInput {
  proposalId: string;
  idempotencyKey: string;
  outcome: ReleaseOutcome;
  receiptTimestamp?: number;
}

export class HostAuthorityKernel {
  readonly threads: ThreadStore;
  readonly parkingLot: ParkingLot;
  readonly proposals: ProposalStore;
  readonly releases: ReleaseStore;
  readonly ops: KernelReadOnlyOperations;

  private readonly offers: AskWorkerOffers;
  private readonly now: () => number;
  /**
   * Idempotency keys reserved by a confirmation that has been AUTHORISED but
   * whose release receipt has not been appended yet (M1, review R). The release
   * store is only written after delivery resolves, so a check against it alone
   * left a check-then-act window: two concurrent confirms sharing one key could
   * both pass and deliver twice. `confirm` is synchronous, so reserving here is
   * atomic with respect to other confirms on the same event loop turn. A
   * refusal releases its reservation (a refusal consumes nothing); an
   * authorisation keeps it for the life of the kernel — the key is spent.
   */
  private readonly reservedIdempotencyKeys = new Map<string, string>();

  constructor(opts?: HostAuthorityKernelOptions) {
    this.now = opts?.now ?? Date.now;
    this.threads = new ThreadStore({ now: this.now });
    this.parkingLot = new ParkingLot({ now: this.now });
    this.proposals = new ProposalStore({ now: this.now });
    this.releases = new ReleaseStore();
    this.offers = new AskWorkerOffers({ now: this.now });
    this.ops = createReadOnlyKernelOperations({
      history: opts?.history ?? EMPTY_HISTORY,
      files: opts?.files ?? EMPTY_FILES,
      parkingLot: this.parkingLot,
      offers: this.offers,
    });
  }

  /**
   * The only path that creates a Proposal. The route is re-checked at runtime,
   * so an object smuggled in under another name (a thread turn, a raw string)
   * cannot become one. Accepted offers are consumed by the accept (a declined
   * offer can never be promoted); parked items are taken out of the lot.
   */
  promote(input: KernelPromotionInput): Proposal {
    switch (input.route) {
      case 'direct_address':
        return this.proposals.create({
          laneId: input.laneId,
          route: input.route,
          sourceUtteranceId: input.sourceUtteranceId,
          tidied: input.tidied,
          ...(input.original !== undefined ? { original: input.original } : {}),
          createdTurn: input.createdTurn,
        });
      case 'accepted_offer': {
        const offer = this.offers.accept(input.offerId);
        return this.proposals.create({
          laneId: input.laneId,
          route: input.route,
          sourceUtteranceId: input.sourceUtteranceId,
          tidied: offer.question,
          createdTurn: input.createdTurn,
        });
      }
      case 'parked_item_promotion': {
        const item = this.parkingLot.promote(input.parkedItemId);
        return this.proposals.create({
          laneId: input.laneId,
          route: input.route,
          sourceUtteranceId: input.sourceUtteranceId,
          tidied: item.text,
          createdTurn: input.createdTurn,
        });
      }
      default:
        throw new UnknownPromotionRouteError(String((input as { route?: unknown }).route));
    }
  }

  /**
   * The one confirmation path. Order is the safety order:
   *   1. an already-released proposal answers `duplicate_refusal` (never a
   *      second delivery);
   *   2. an unknown proposal refuses;
   *   3. an already-used OR already-reserved idempotency key answers
   *      `duplicate_refusal` WITHOUT consuming the proposal (the reservation
   *      closes the check-then-act window between authorisation and receipt);
   *   4. the ProposalStore gate validates live → version+sha256 → original
   *      variant and consumes atomically on success.
   * A refusal consumes nothing.
   */
  confirm(input: KernelConfirmationInput): KernelConfirmationResult {
    const proposal = this.proposals.get(input.proposalId);
    const prior = this.releases.findByProposal(input.proposalId);
    // Released already — whether or not its receipt has been recorded yet.
    // Either way the proposal was consumed by exactly one confirmation, so a
    // repeat is a duplicate refusal, never a second delivery.
    if (prior || proposal?.status === 'released') {
      return {
        kind: 'duplicate_refusal',
        proposalId: input.proposalId,
        idempotencyKey: input.idempotencyKey,
        prior,
      };
    }
    if (!proposal) return { kind: 'refused', reason: 'not_found', proposal: null };
    // M1: a key that is recorded OR reserved is spent. The reservation is taken
    // below BEFORE the proposal is consumed, so two confirms sharing a key can
    // never both reach delivery (review R probe 3).
    if (this.releases.hasIdempotencyKey(input.idempotencyKey) || this.reservedIdempotencyKeys.has(input.idempotencyKey)) {
      return {
        kind: 'duplicate_refusal',
        proposalId: input.proposalId,
        idempotencyKey: input.idempotencyKey,
        prior: this.releases.latest(input.idempotencyKey),
      };
    }
    this.reservedIdempotencyKeys.set(input.idempotencyKey, input.proposalId);
    const take = this.proposals.takeForConfirmation({
      proposalId: input.proposalId,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      identity: input.identity,
    });
    if (take.kind !== 'taken') {
      // A refusal consumes nothing — including its key reservation.
      this.reservedIdempotencyKeys.delete(input.idempotencyKey);
      return {
        kind: 'refused',
        reason: take.kind,
        proposal: 'proposal' in take ? take.proposal : null,
      };
    }
    return {
      kind: 'authorised',
      proposal: take.proposal,
      idempotencyKey: input.idempotencyKey,
      targetLane: take.proposal.laneId,
    };
  }

  /**
   * Append the delivery receipt for an authorised release. The outcome may be
   * `unknown` — a timeout after submission is not a refusal — which makes the
   * release a reconciliation obligation rather than a blind retry.
   */
  recordDelivery(input: KernelDeliveryInput): ReleaseRecord {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) throw new ProposalNotFoundError(input.proposalId);
    return this.releases.record({
      proposalId: proposal.id,
      sha256: proposal.sha256,
      idempotencyKey: input.idempotencyKey,
      targetLane: proposal.laneId,
      deliveryOutcome: input.outcome,
      receiptTimestamp: input.receiptTimestamp ?? this.now(),
    });
  }

  /** Resolve an unknown outcome; see ReleaseStore.reconcile. */
  reconcile(input: {
    idempotencyKey: string;
    outcome: Exclude<ReleaseOutcome, { status: 'unknown' }>;
    receiptTimestamp?: number;
  }): ReleaseRecord {
    return this.releases.reconcile({
      idempotencyKey: input.idempotencyKey,
      deliveryOutcome: input.outcome,
      receiptTimestamp: input.receiptTimestamp ?? this.now(),
    });
  }

  /** Releases whose latest outcome is `unknown` (reconciliation obligations). */
  pendingReconciliations(): ReleaseRecord[] {
    return this.releases.needsReconciliation();
  }
}
