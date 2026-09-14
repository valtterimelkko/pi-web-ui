/**
 * The server-side voice talker harness (Drive Mode Two-Lane plan, H1).
 *
 * The talker holds a spoken conversation with the operator while a reasoning
 * worker runs, and relays the operator's instruction to that worker only
 * after explicit confirmation. One instance serves one worker session.
 *
 * THE GATE IS MECHANICAL (plan §10.9 — the non-negotiables):
 *   1. The talker (model) has no send path. The ONLY code that can hand text
 *      to the worker is the release branch inside handleOperatorTurn, and it
 *      runs only when (a) a pending proposal exists — harness state, holding
 *      the operator's verbatim utterance — and (b) the operator's new
 *      utterance mechanically classifies as a confirmation. Model output is
 *      never an input to this decision, so no model behaviour — compliant or
 *      not — can move the gate.
 *   2. The relay text is the draft's stored text: the operator's own words
 *      (P25 semi-verbatim: minus the channel and the disfluency — normalised
 *      mechanically at draft time by relay-normalise.ts, removal only, never
 *      model-composed), referenced by id in the verbatim log. The model
 *      decides whether and when to ask; it never composes what is sent. The
 *      transform happens BEFORE approval: the card shows exactly the bytes a
 *      confirmation will release.
 *   3. The system prompt justifies the gate (see prompt.ts / v3-harness.txt).
 *   4. The operator-pushback turn is a mandatory test (talker-gate.test.ts).
 *   5. Input hygiene: the only writes into the talker's context are the
 *      per-turn projection built here. The public surface has no injection
 *      API (pinned by test).
 *   6. History is a bounded rolling window, trimmed only at turn boundaries,
 *      never below the pending floor while a proposal is alive. No LLM
 *      summariser in v1.
 *   7. Acknowledgements are fixed strings produced by the harness after the
 *      delivery outcome is known — "sending that now" only after a confirmed
 *      release that the adapter reports as delivered; honest failure and
 *      queue wording otherwise. The talker never claims the worker finished.
 *
 * The operator's draft (plan §4.2, interleaved composition):
 *   8. Statements and worker-directed questions ACCUMULATE into the draft —
 *      the operator's composing thread. Nothing is ever silently replaced or
 *      aged out of existence; supersession holds both parts and the state
 *      view tells the talker, who asks which. (P22 narrowing: a statement
 *      the model marked as addressed to the talker itself — [[to-talker]] —
 *      does not join; suppression only ever shrinks what a "yes" can reach.)
 *   9. Ageing expires the CONFIRMATION, not the draft. A confirmation that
 *      arrives after the window gets a mechanical refusal that quotes the
 *      draft verbatim and re-arms the window — never a model-composed
 *      answer, and never a silent drop. A released or explicitly abandoned
 *      ("forget that") draft is gone; a lapsed one is always surfaced.
 *  10. A release takes verbatim text by id — the whole draft, or a single
 *      part via the fixed ordinal vocabulary ("just the second one"). An
 *      unresolved selection is ambiguous: it never acts.
 *
 * Turn flow:
 *   utterance → verbatim log → mechanical classification →
 *     confirm + live fresh draft  → release: deliver verbatim → fixed ack (no model call)
 *     confirm + lapsed draft      → mechanical refusal + surfacing + re-arm (no model call)
 *     confirm, nothing pending    → conversational model turn ("send what?")
 *     cancel                      → clear draft → conversational model turn
 *     otherwise                   → conversational model turn, then the
 *                                   utterance joins the draft — unless the
 *                                   model marked it addressed to the talker
 *                                   ([[to-talker]], P22): nothing is held
 *   Every conversational turn rebuilds the state view fresh and sees the
 *   draft (parts, age, needs-re-confirmation) and the last release.
 */

import { classifyOperatorUtterance, extractPostCancelInstruction, isMetaSendQuestion, isWorkerDirectedQuestion, resolveDraftSelection } from './utterance-classifier.js';
import { isAskWorkerOffer, stripAskWorkerMarker } from './ask-worker.js';
import { PendingProposalStore, UtteranceLog } from './pending-proposal.js';
import type { DraftSelection, DraftSnapshot } from './pending-proposal.js';
import { createVoiceTurnRecorder, type VoiceTurnObservation, type VoiceTurnRecorder, type VoiceRuntime } from './observability.js';
import { renderStateView } from './state-view.js';
import { TalkerHistory } from './history.js';
import { loadTalkerSystemPrompt } from './prompt.js';
import { ackForOutcome, describeOutcome, MODEL_FAILURE_REPLY, NOTHING_PENDING_ACK, NOTHING_TO_CANCEL_ACK, receiptAckFor } from './ack.js';
import type {
  ChatMessage,
  TalkerModelClient,
  TalkerTurnResult,
  WorkerDelivery,
  WorkerStateSnapshot,
} from './types.js';

export interface TalkerSessionConfig {
  /**
   * Operator turns of absence after which the draft's confirmation window
   * lapses and the draft must be re-confirmed before it can release. The
   * draft itself NEVER expires (plan §4.2) — only the confirmation does.
   */
  maxPendingAgeTurns: number;
  historyMaxEntries: number;
  historyKeepEntries: number;
  historyMaxEntriesWhenPending: number;
  historyKeepEntriesWhenPending: number;
}

const DEFAULT_CONFIG: TalkerSessionConfig = {
  maxPendingAgeTurns: 6,
  historyMaxEntries: 30,
  historyKeepEntries: 16,
  historyMaxEntriesWhenPending: 60,
  historyKeepEntriesWhenPending: 40,
};

export interface TalkerSessionDeps {
  model: TalkerModelClient;
  delivery: WorkerDelivery;
  /** The worker session this talker relays to. */
  workerSessionId: string;
  /**
   * Fresh worker state material, called once per conversational turn. May be
   * async for runtimes whose state lives behind an async service (P11/F3:
   * Claude); a synchronous provider behaves exactly as before.
   */
  snapshotProvider: () => WorkerStateSnapshot | Promise<WorkerStateSnapshot>;
  config?: Partial<TalkerSessionConfig>;
  /** Which runtime adapter relays for this worker (observation label only; default 'pi'). */
  runtime?: VoiceRuntime;
  /**
   * P10 voice observability (observation only — it can never alter a turn).
   * Default: the global VoiceMode recorder bound to the shared registries.
   */
  observability?: VoiceTurnRecorder;
}

/**
 * Mechanical surfacing replies (plan §4.2). Like the release acks (ack.ts),
 * these are produced by the harness from harness state — the only
 * operator-facing words in them are the draft's own verbatim text — so the
 * model can never compose, soften or suppress the safety-critical
 * transitions: refusing a stale confirmation and asking for
 * re-confirmation, and clarifying an ambiguous selection. (ack.ts itself is
 * frozen for this package, so these live here.)
 */
function reconfirmAskReply(snapshot: DraftSnapshot): string {
  const quoted = snapshot.utterances.map(u => `"${u.text}"`).join(' ... ');
  return `You were composing something — still want that sent? Here is what I am holding: ${quoted}. Say yes and I will send it.`;
}

function selectionClarifyReply(snapshot: DraftSnapshot): string {
  const parts = snapshot.utterances.map((u, i) => `${i + 1}. "${u.text}"`).join(' ');
  return `I am holding ${snapshot.utterances.length} things — ${parts}. Which one?`;
}

/**
 * P22 — the to-talker marker (the [[ask-worker]] mould, narrowed to drafting).
 *
 * The draft gate had a hole on the talker's own side of the relay: an
 * imperative addressed to the TALKER — "summarise what's been done", "read
 * that back" — is not a question, so it classified as `statement` and was
 * held, verbatim, as a pending WORKER instruction. The model then offered to
 * send the operator's own words back at them, and a stray "yes" could
 * release them.
 *
 * The repair is narrowing, in the [[ask-worker]] mould: the model may end a
 * reply with an end-anchored [[to-talker]] tag when it judged the utterance
 * was addressed to it and it answered from what it holds; the harness then
 * does not draft the utterance. The consequences are mechanical and one-way:
 *   - suppression only: the tag can keep words OUT of the draft, never put
 *     anything in and never release anything — a wrong guess reduces what a
 *     later "yes" can reach, so it is always the safe direction (the
 *     mis-marked instruction meets the mechanical nothing-pending reply);
 *   - honoured only on statement-classified turns — the harness passes a
 *     draft candidate nowhere else, so worker-directed questions and
 *     ask-the-worker offers keep their own classification-based paths and
 *     model behaviour cannot widen the gate;
 *   - the tag is stripped wherever it appears: a protocol marker is never
 *     spoken aloud, honoured or not.
 * A marked utterance joins no draft, so it opens no composition batch and
 * earns no receipt: the operator asked the talker, and the talker answered.
 */

const ADDRESSED_TAG_AT_END = /\[\[\s*to-talker\s*\]\]\s*$/i;
const ADDRESSED_TAG_ANYWHERE = /\[\[\s*to-talker\s*\]\]/gi;

/** True when the reply ENDS with the tag (trailing whitespace tolerated). */
function isAddressedToTalkerMark(reply: string): boolean {
  return ADDRESSED_TAG_AT_END.test(reply);
}

/** The reply as the operator should hear it: the tag removed. */
function stripTalkerAddressedMarker(reply: string): string {
  return reply.replace(ADDRESSED_TAG_ANYWHERE, '').trim();
}

export class TalkerSession {
  readonly utteranceLog: UtteranceLog;
  readonly proposals: PendingProposalStore;
  readonly history: TalkerHistory;

  private readonly model: TalkerModelClient;
  private readonly delivery: WorkerDelivery;
  private readonly workerSessionId: string;
  private readonly snapshotProvider: () => WorkerStateSnapshot | Promise<WorkerStateSnapshot>;
  private readonly config: TalkerSessionConfig;
  /** Observation label only — never used for routing or gate decisions. */
  private readonly runtime: VoiceRuntime;
  /** P10 voice observability. Emissions swallow their own failures. */
  private readonly observability: VoiceTurnRecorder;
  private turnCount = 0;

  constructor(deps: TalkerSessionDeps) {
    this.model = deps.model;
    this.delivery = deps.delivery;
    this.workerSessionId = deps.workerSessionId;
    this.snapshotProvider = deps.snapshotProvider;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.runtime = deps.runtime ?? 'pi';
    this.observability = deps.observability ?? createVoiceTurnRecorder();
    this.utteranceLog = new UtteranceLog();
    this.proposals = new PendingProposalStore({ maxPendingAgeTurns: this.config.maxPendingAgeTurns });
    this.history = new TalkerHistory({
      maxEntries: this.config.historyMaxEntries,
      keepEntries: this.config.historyKeepEntries,
      maxEntriesWhenPending: this.config.historyMaxEntriesWhenPending,
      keepEntriesWhenPending: this.config.historyKeepEntriesWhenPending,
    });
  }

  /**
   * The only entry point. Operator speech in; what the operator hears out.
   * There is deliberately no other public method: nothing can inject context
   * and nothing can trigger a delivery outside the confirmed release path.
   *
   * `opts.operatorFocus` is the operator's focus/hold control, pressed on the
   * client (P18 package C). It is per-turn INPUT for the state view only — the
   * talker is told, so that it can suggest leaving focus when something needs
   * the operator. There is no session state and no method that switches it, and
   * it is never an input to the gate.
   */
  async handleOperatorTurn(utterance: string, opts?: { operatorFocus?: boolean }): Promise<TalkerTurnResult> {
    if (!utterance || !utterance.trim()) {
      throw new Error('operator utterance must be non-empty');
    }

    this.turnCount += 1;
    const turn = this.turnCount;

    // P10 voice observability: pure pre-state reads around the turn (snapshot
    // copies and mechanical recomputation of the same formulas the branches
    // below use). The gate is neither consulted nor altered by these, and
    // every emission is swallow-failed — here and inside the recorder.
    const observation: VoiceTurnObservation = {
      runtime: this.runtime,
      workerSessionId: this.workerSessionId,
      turn,
      utterance,
      draftBefore: this.proposals.snapshotDraft(),
      draftAfter: null,
      lapsedBefore: this.proposals.isLapsed(turn),
      selection: resolveDraftSelection(utterance),
      selectionResolvable: null,
    };
    if (observation.selection !== null) {
      observation.selectionResolvable = this.proposals.canResolveSelection(observation.selection);
    }
    const startedAtMs = Date.now();
    try {
      const result = await this.handleOperatorTurnBody(utterance, turn, {
        ...(opts?.operatorFocus !== undefined ? { operatorFocus: opts.operatorFocus } : {}),
      });
      observation.draftAfter = this.proposals.snapshotDraft();
      try {
        this.observability.observeTurn(observation, result, Date.now() - startedAtMs);
      } catch { /* observation must never alter the turn */ }
      return result;
    } catch (error) {
      observation.draftAfter = this.proposals.snapshotDraft();
      try {
        this.observability.observeCrash(observation, error, Date.now() - startedAtMs);
      } catch { /* observation must never alter the turn */ }
      throw error;
    }
  }

  /**
   * The turn body exactly as before (P10 only moved it behind the observation
   * wrapper above — no behaviour change; the gate suites pin every branch).
   */
  private async handleOperatorTurnBody(
    utterance: string,
    turn: number,
    opts: { operatorFocus?: boolean } = {}
  ): Promise<TalkerTurnResult> {
    // P18/2: the operator's focus control is projection input for every
    // conversational turn this turn takes (and for nothing else — the
    // mechanical release/refusal paths never build a projection).
    const focusFlag = opts.operatorFocus !== undefined ? { operatorFocus: opts.operatorFocus } : {};
    // Age the draft's confirmation at the boundary BEFORE this turn's events.
    // Marks needs-re-confirmation; never drops the draft (plan §4.2).
    this.proposals.tickTurn(turn);

    const record = this.utteranceLog.record(utterance, turn);
    const classified = classifyOperatorUtterance(utterance);
    const selection = resolveDraftSelection(utterance);
    // A selection shape ("just the second one") is mechanically a
    // confirmation of part of the draft. It is harness classification — the
    // same nature as the confirm patterns — never model output, so the gate
    // is not widened: a release still requires a live, fresh draft.
    const utteranceClass: TalkerTurnResult['utteranceClass'] =
      selection !== null && classified === 'statement' ? 'confirm' : classified;

    if (utteranceClass === 'confirm') {
      const draftSnap = this.proposals.snapshotDraft();
      if (draftSnap && this.proposals.isLapsed(turn)) {
        // Stale confirmation (plan §4.2): refuse, quote the draft verbatim,
        // re-arm the window. Mechanical — the model never owns this
        // transition and never interprets the stale yes.
        this.proposals.markResurfaced(turn);
        const reply = reconfirmAskReply(draftSnap);
        this.history.append({ role: 'user', content: utterance, kind: 'operator', turn });
        this.history.append({ role: 'assistant', content: reply, kind: 'mechanical', turn });
        this.history.maybeTrim(this.proposals.pending !== null);
        return { reply, utteranceClass, released: null, cancelled: false, modelCalled: false, latency: null };
      }
      if (draftSnap) {
        if (selection && !this.proposals.canResolveSelection(selection)) {
          // Ambiguous selection: never acts (invariant 6). Mechanical
          // clarification; the draft is untouched.
          const reply = selectionClarifyReply(draftSnap);
          this.history.append({ role: 'user', content: utterance, kind: 'operator', turn });
          this.history.append({ role: 'assistant', content: reply, kind: 'mechanical', turn });
          this.history.maybeTrim(this.proposals.pending !== null);
          return { reply, utteranceClass, released: null, cancelled: false, modelCalled: false, latency: null };
        }
        return this.release(utterance, turn, selection ?? undefined);
      }
      // A confirmation with nothing pending is a DEAD END, and the harness
      // owns it (finding F2, P7): the model's conversational answer promised
      // a send that could not happen — "OK. I'll send that instruction to
      // the worker." Nothing could be sent: the gate held. The answer is now
      // the fixed mechanical string — the truth, the way out, no promise —
      // with no model call, exactly like the release acks and the lapsed
      // refusal. The "yes" itself is never recorded as a candidate.
      this.history.append({ role: 'user', content: utterance, kind: 'operator', turn });
      this.history.append({ role: 'assistant', content: NOTHING_PENDING_ACK, kind: 'mechanical', turn });
      this.history.maybeTrim(this.proposals.pending !== null);
      return { reply: NOTHING_PENDING_ACK, utteranceClass, released: null, cancelled: false, modelCalled: false, latency: null };
    }

    if (utteranceClass === 'cancel') {
      // Finding F1 (P7): the cancel boundary ends the OLD draft, but an
      // instruction spoken AFTER the boundary in the same breath is captured
      // — the residue composes fresh instead of vanishing from the harness.
      // The residue is the operator's verbatim words; it joins the draft and
      // still needs its own confirmation to release. The gate is untouched.
      const residue = extractPostCancelInstruction(utterance);
      const cancelled = this.proposals.cancel('operator cancelled', turn);
      if (residue) {
        const residueClass = classifyOperatorUtterance(residue);
        const residueIsDraftable =
          residueClass === 'statement' ||
          (residueClass === 'question' && !isMetaSendQuestion(residue) && isWorkerDirectedQuestion(residue));
        if (residueIsDraftable) {
          // The residue opens a fresh composition batch (the cancel cleared
          // any held draft), so its answer-ready moment owes one receipt —
          // unless the model marks the residue addressed to the talker
          // ([[to-talker]], P22): then nothing is held and nothing opened.
          // The append happens in conversationalTurn, after the model turn.
          const residueRecord = this.utteranceLog.record(residue, turn);
          return this.conversationalTurn(utterance, utteranceClass, turn, {
            cancelled,
            draftCandidate: { utteranceId: residueRecord.id, text: residue },
            opensBatch: true,
            ...focusFlag,
          });
        }
      }
      if (!cancelled && !residue) {
        // The F2 neighbouring dead-end (checked and closed in the same
        // package): a cancel with nothing held reached the model, which could
        // claim a cancellation that never happened. Mechanical honesty —
        // there was nothing to cancel. A cancel that DID clear a draft stays
        // conversational: the model may truthfully acknowledge it.
        this.history.append({ role: 'user', content: utterance, kind: 'operator', turn });
        this.history.append({ role: 'assistant', content: NOTHING_TO_CANCEL_ACK, kind: 'mechanical', turn });
        this.history.maybeTrim(this.proposals.pending !== null);
        return { reply: NOTHING_TO_CANCEL_ACK, utteranceClass, released: null, cancelled: false, modelCalled: false, latency: null };
      }
      return this.conversationalTurn(utterance, utteranceClass, turn, { cancelled, ...focusFlag });
    }

    // A meta question about the send in flight ("did you send it?") keeps the
    // draft untouched; a worker-directed question ("could you ask the worker
    // to rebase?") and every statement ACCUMULATE into the draft — the
    // operator's composing thread (plan §4.2). Nothing is ever replaced:
    // supersession holds both, and the state view tells the talker.
    if (utteranceClass === 'question') {
      const metaSend = isMetaSendQuestion(utterance);
      const workerDirected = isWorkerDirectedQuestion(utterance);
      if (!metaSend && workerDirected) {
        // A draft-opening question is a receipt moment like any append
        // (§4.1 rule 2) — the ack travels on this turn's result.
        const opensBatch = this.proposals.snapshotDraft() === null;
        this.proposals.appendToDraft(record.id, utterance, turn);
        return this.conversationalTurn(utterance, utteranceClass, turn, { recordedCandidate: false, opensBatch, ...focusFlag });
      }
      // P18/1: a question the talker was asked to ANSWER may be offered for
      // relay if the talker cannot answer it. The candidate is the operator's
      // own utterance, by id — the harness stays the only source of relay
      // text. Whether the offer actually fires is decided after the model
      // turn (the marker), and it only ever creates a candidate: a delivery
      // still needs the operator's own confirmation.
      const offerCandidate =
        !metaSend && !workerDirected
          ? { utteranceId: record.id, text: utterance }
          : undefined;
      return this.conversationalTurn(utterance, utteranceClass, turn, { recordedCandidate: false, offerCandidate, ...focusFlag });
    }
    // P22: the statement still ACCUMULATES into the draft — but the append
    // now happens after the model turn (in conversationalTurn), so the model
    // can first judge whether the utterance was addressed to the talker
    // itself. Unmarked, the behaviour is exactly as before: the operator's
    // verbatim words join the draft, and the batch this utterance opened
    // (opensBatch, taken pre-turn) still owes its one receipt. Marked
    // [[to-talker]], nothing is held and no batch opened — no receipt either.
    const opensBatch = this.proposals.snapshotDraft() === null;
    return this.conversationalTurn(utterance, utteranceClass, turn, {
      recordedCandidate: true,
      draftCandidate: { utteranceId: record.id, text: utterance },
      opensBatch,
      ...focusFlag,
    });
  }

  /**
   * The single release path. Private by construction: reachable only from the
   * confirm branch above. It takes NO relay text — the text comes from the
   * pending-proposal store via takeForRelease(), which is null-safe, so even
   * a forced direct call cannot relay anything that was not a recorded,
   * unexpired, live draft part.
   */
  private async release(confirmingUtterance: string, turn: number, selection?: DraftSelection): Promise<TalkerTurnResult> {
    const taken = this.proposals.takeForRelease(turn, selection);
    if (!taken) {
      // Defensive: cannot happen from handleOperatorTurn (it checks pending
      // first), and cannot relay anything either way.
      return this.conversationalTurn(confirmingUtterance, 'confirm', turn, { recordedCandidate: false });
    }
    const delivery = await this.delivery.deliver({ workerSessionId: this.workerSessionId, text: taken.text });
    this.proposals.recordReleased({
      utteranceId: taken.utteranceId,
      text: taken.text,
      outcome: describeOutcome(delivery),
      turn,
    });

    this.history.append({ role: 'user', content: confirmingUtterance, kind: 'operator', turn });
    this.history.append({ role: 'assistant', content: ackForOutcome(delivery), kind: 'mechanical', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    return {
      reply: ackForOutcome(delivery),
      utteranceClass: 'confirm',
      released: { utteranceId: taken.utteranceId, text: taken.text, delivery },
      cancelled: false,
      modelCalled: false,
      latency: null,
    };
  }

  private async conversationalTurn(
    utterance: string,
    utteranceClass: TalkerTurnResult['utteranceClass'],
    turn: number,
    flags: {
      recordedCandidate?: boolean;
      cancelled?: boolean;
      opensBatch?: boolean;
      /** P18/1: the operator's unanswered question, held verbatim if the model offers. */
      offerCandidate?: { utteranceId: number; text: string };
      /** P22: a statement/residue that joins the draft unless the model marks it addressed to the talker. */
      draftCandidate?: { utteranceId: number; text: string };
      /** P18/2: the operator's focus control, projection input only. */
      operatorFocus?: boolean;
    }
  ): Promise<TalkerTurnResult> {
    const snapshot = await this.snapshotProvider();
    const draftSnap = this.proposals.snapshotDraft();
    const lastReleased = this.proposals.lastReleased;
    const stateView = renderStateView(snapshot, {
      draft: draftSnap
        ? {
            utterances: draftSnap.utterances.map(u => u.text),
            ageTurns: draftSnap.ageTurns,
            needsReConfirmation: draftSnap.needsReConfirmation,
          }
        : null,
      lastReleased: lastReleased ? { text: lastReleased.text, outcome: lastReleased.outcome } : null,
      ...(flags.operatorFocus !== undefined ? { operatorFocus: flags.operatorFocus } : {}),
    });

    // History carries the plain conversational turns; the projection is
    // rebuilt fresh every turn and never persisted.
    const window = this.history
      .entries()
      .map<ChatMessage>(e => ({ role: e.role, content: e.content }));
    const messages: ChatMessage[] = [
      { role: 'system', content: loadTalkerSystemPrompt() },
      ...window,
      { role: 'user', content: `${stateView}\n\nOPERATOR (out loud): ${utterance}` },
    ];

    this.history.append({ role: 'user', content: utterance, kind: 'operator', turn });

    let reply: string;
    let latency: TalkerTurnResult['latency'] = null;
    let error: string | undefined;
    try {
      const result = await this.model.completeTurn(messages);
      reply = result.text;
      latency = { ttftMs: result.ttftMs, totalMs: result.totalMs };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      reply = MODEL_FAILURE_REPLY;
    }

    // P18/1 — the offer. The model PROPOSES (the end-anchored marker); the
    // harness converts that proposal into a relay candidate holding the
    // operator's own question, verbatim, by utterance id. This is the only
    // effect model text can have on the draft, and it is deliberately narrow:
    // it creates a candidate that still needs the operator's own confirmation,
    // it can never deliver anything, and it fires only on a turn that was an
    // answerable question in the first place (callers pass no candidate
    // otherwise). The marker is stripped in every case — a protocol tag must
    // never be spoken aloud, whether or not it was honoured.
    const offered = flags.offerCandidate !== undefined && isAskWorkerOffer(reply);
    // P22 — the narrowed draft decision. A statement (or cancel residue)
    // joins the draft unless the model marked the utterance as addressed to
    // the talker itself; the tag is honoured only here, only end-anchored,
    // and it can only SUPPRESS a draft — never create or release one.
    const addressedToTalker = flags.draftCandidate !== undefined && isAddressedToTalkerMark(reply);
    let opensBatch = flags.opensBatch ?? false;
    if (addressedToTalker) {
      // A marked utterance joins nothing: no batch opens, so no receipt —
      // the operator asked the talker, and the talker answered it.
      opensBatch = false;
    } else if (flags.draftCandidate) {
      // Unmarked: the exact pre-P22 behaviour — the operator's verbatim
      // words join the draft and still need their own confirmation.
      opensBatch = opensBatch || this.proposals.snapshotDraft() === null;
      this.proposals.appendToDraft(flags.draftCandidate.utteranceId, flags.draftCandidate.text, turn);
    }
    if (offered && flags.offerCandidate) {
      // A question that opens a composition batch is a receipt moment like any
      // append (§4.1 rule 2) — computed here because the batch exists only if
      // the model actually offered.
      opensBatch = opensBatch || this.proposals.snapshotDraft() === null;
      this.proposals.appendToDraft(flags.offerCandidate.utteranceId, flags.offerCandidate.text, turn);
    }
    reply = stripTalkerAddressedMarker(stripAskWorkerMarker(reply));

    this.history.append({ role: 'assistant', content: reply, kind: 'talker', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    // The receipt (§4.1 rule 2) is emitted here — at the answer-ready moment
    // for the utterance that opened the batch — from the fixed vocabulary,
    // chosen purely by how many recorded utterances are outstanding. The
    // model's reply is never an input; a model failure cannot suppress it.
    let receiptAck: string | undefined;
    if (opensBatch) {
      const ack = receiptAckFor(this.utteranceLog.takeReceipt() ?? 0);
      if (ack) receiptAck = ack;
    }

    return {
      reply,
      utteranceClass,
      released: null,
      cancelled: flags.cancelled ?? false,
      modelCalled: error === undefined,
      latency,
      ...(receiptAck !== undefined ? { receiptAck } : {}),
      ...(offered ? { askWorkerOffer: true } : {}),
      ...(addressedToTalker ? { addressedToTalker: true } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}

/**
 * Outcome description helper re-exported for the harness runner.
 */
export { describeOutcome };
