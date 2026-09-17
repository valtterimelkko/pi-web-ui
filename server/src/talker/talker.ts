/**
 * The server-side voice talker harness (Drive Mode Two-Lane plan, H1).
 *
 * The talker holds a spoken conversation with the operator while a reasoning
 * worker runs, and relays the operator's instruction to that worker only
 * after explicit confirmation. One instance serves one worker session.
 *
 * THE GATE IS MECHANICAL (plan §10.9 — the non-negotiables):
 *   1. The talker (model) has no send path. The only code that can hand text
 *      to the worker is the release branch inside handleOperatorTurn, and it
 *      runs only when (a) a pending proposal exists — harness state, holding
 *      the operator's verbatim utterance — and (b) the operator's new
 *      utterance mechanically classifies as a confirmation. Model output is
 *      never an input to this decision, so no model behaviour — compliant or
 *      not — can move the gate. (Phase L3: every branch decision itself —
 *      release, refusal, cancel, draft/offer candidates, receipts — is made
 *      by the pure policy-core.ts; this file builds the state view, executes
 *      the decision and owns all I/O.)
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

import { resolveDraftSelection } from './utterance-classifier.js';
import { PendingProposalStore, UtteranceLog } from './pending-proposal.js';
import type { DraftSelection, ReleaseVariant } from './pending-proposal.js';
import { createVoiceTurnRecorder, type VoiceTurnObservation, type VoiceTurnRecorder, type VoiceRuntime } from './observability.js';
import { renderStateView } from './state-view.js';
import { TalkerHistory } from './history.js';
import { loadTalkerSystemPrompt } from './prompt.js';
import { ackForOutcome, describeOutcome, MODEL_FAILURE_REPLY, receiptAckFor } from './ack.js';
import { decideAfterModelReply, decideOperatorTurn, plainConversationalDecision, policyStateView, type SpokenDecision } from './policy-core.js';
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
  async handleOperatorTurn(
    utterance: string,
    opts?: {
      operatorFocus?: boolean;
      releaseVariant?: ReleaseVariant;
      /** D-card: the identity the confirming card displayed, echoed back. */
      proposalRef?: { version: number; hash: string };
    }
  ): Promise<TalkerTurnResult> {
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
        ...(opts?.releaseVariant !== undefined ? { releaseVariant: opts.releaseVariant } : {}),
        ...(opts?.proposalRef !== undefined ? { proposalRef: opts.proposalRef } : {}),
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
   * The turn body: build the state view, ask the pure policy core what the
   * turn does, then execute that decision (P10 only moved it behind the
   * observation wrapper above; L3 only replaced its branch logic with the
   * core's decision — the gate suites pin every branch).
   */
  private async handleOperatorTurnBody(
    utterance: string,
    turn: number,
    opts: {
      operatorFocus?: boolean;
      releaseVariant?: ReleaseVariant;
      proposalRef?: { version: number; hash: string };
    } = {}
  ): Promise<TalkerTurnResult> {
    // P18/2: the operator's focus control is projection input for every
    // conversational turn this turn takes (and for nothing else — the
    // mechanical release/refusal paths never build a projection).
    const focusFlag = opts.operatorFocus !== undefined ? { operatorFocus: opts.operatorFocus } : {};
    // Age the draft's confirmation at the boundary BEFORE this turn's events.
    // Marks needs-re-confirmation; never drops the draft (plan §4.2).
    this.proposals.tickTurn(turn);

    // Every operator utterance is recorded before anything reads state; the
    // residual/duplicate records a decision may need are the executor's job.
    const record = this.utteranceLog.record(utterance, turn);

    // THE GATE lives in policy-core (pure, model-free): given the harness
    // state — draft, confirmation window, D-card identity — and the turn's
    // input, it returns what this turn must do. Nothing below re-decides it;
    // this method only executes the decision (state mutations, model call,
    // delivery, history, receipts).
    const decision = decideOperatorTurn(
      policyStateView(this.proposals, turn),
      {
        utterance,
        ...(opts.releaseVariant !== undefined ? { releaseVariant: opts.releaseVariant } : {}),
        ...(opts.proposalRef !== undefined ? { proposalRef: opts.proposalRef } : {}),
      }
    );

    if (decision.kind === 'release') {
      return this.release(utterance, turn, decision.selection ?? undefined, decision.variant);
    }

    if (decision.kind === 'cancel' || decision.kind === 'conversational') {
      // Spoken turn. First its PRE-model state effects, exactly as the
      // decision ordered them: a cancel clears the old draft and a draftable
      // residue composes fresh (recorded verbatim before the model sees it);
      // a worker-directed question joins the draft BEFORE the model turn, so
      // the projection the model answers includes it.
      const plan = decision.plan;
      let draftRecordId = record.id;
      if (decision.kind === 'cancel') {
        this.proposals.cancel('operator cancelled', turn);
        if (plan.cancelResidue?.draftable) {
          draftRecordId = this.utteranceLog.record(plan.cancelResidue.text, turn).id;
        }
      } else if (plan.path === 'worker-directed') {
        this.proposals.appendToDraft(record.id, utterance, turn);
      }
      return this.conversationalTurn(decision, turn, { ...focusFlag, draftRecordId });
    }

    // Gate-owned dead ends and refusals: fixed vocabulary, no model call.
    // The lapsed-confirmation refusal re-arms the window as it surfaces.
    if (decision.kind === 'refuse-lapsed') this.proposals.markResurfaced(turn);
    this.history.append({ role: 'user', content: utterance, kind: 'operator', turn });
    this.history.append({ role: 'assistant', content: decision.reply, kind: 'mechanical', turn });
    this.history.maybeTrim(this.proposals.pending !== null);
    return {
      reply: decision.reply,
      utteranceClass: decision.utteranceClass,
      released: null,
      cancelled: false,
      modelCalled: false,
      latency: null,
    };
  }

  /**
   * The single release path. Private by construction: reachable only from the
   * confirm branch above. It takes NO relay text — the text comes from the
   * pending-proposal store via takeForRelease(), which is null-safe, so even
   * a forced direct call cannot relay anything that was not a recorded,
   * unexpired, live draft part.
   *
   * `variant` (card-contract brief, R6/R7/R8) is a PARAMETER of this one path,
   * never a second door: 'tidied' releases the relay text the card quoted,
   * 'original' releases the operator's raw bytes per part. Nothing else on the
   * path changes — the same store call, the same gates, the same delivery.
   */
  private async release(
    confirmingUtterance: string,
    turn: number,
    selection: DraftSelection | undefined,
    variant: ReleaseVariant
  ): Promise<TalkerTurnResult> {
    const taken = this.proposals.takeForRelease(turn, selection, variant);
    if (!taken) {
      // Defensive: cannot happen from handleOperatorTurn (it checks the same
      // state first), and cannot relay anything either way. The fallback is a
      // plain conversational turn — no draft effect and no offer — so a
      // forced direct call behaves exactly as it did before the extraction.
      return this.conversationalTurn(plainConversationalDecision(confirmingUtterance, 'confirm', turn), turn, {
        draftRecordId: 0,
      });
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
    decision: SpokenDecision,
    turn: number,
    flags: {
      /** The verbatim-log record this turn's draft candidate (or offer) references. */
      draftRecordId: number;
      /** P18/2: the operator's focus control, projection input only. */
      operatorFocus?: boolean;
    }
  ): Promise<TalkerTurnResult> {
    if (decision.kind !== 'conversational' && decision.kind !== 'cancel') {
      // By construction: callers pass a spoken decision.
      throw new Error('conversationalTurn requires a spoken decision');
    }
    const plan = decision.plan;
    const utterance = decision.utterance;

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

    // The post-model plan is policy-core's: the ONLY effects model text can
    // have on the draft. [[to-talker]] (end-anchored, statement/residue paths
    // only) suppresses the append; [[ask-worker]] (end-anchored, offer path
    // only) creates a candidate holding the OPERATOR'S OWN question — which
    // still needs the operator's own confirmation. Neither can release
    // anything, and both markers are stripped from what the operator hears.
    const post = decideAfterModelReply(decision, reply);
    if (post.append) {
      this.proposals.appendToDraft(flags.draftRecordId, post.append.text, turn);
    }
    reply = post.reply;

    this.history.append({ role: 'assistant', content: reply, kind: 'talker', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    // The receipt (§4.1 rule 2) is emitted here — at the answer-ready moment
    // for the utterance that opened the batch — from the fixed vocabulary,
    // chosen purely by how many recorded utterances are outstanding. The
    // model's reply is never an input; a model failure cannot suppress it.
    let receiptAck: string | undefined;
    if (post.opensBatch) {
      const ack = receiptAckFor(this.utteranceLog.takeReceipt() ?? 0);
      if (ack) receiptAck = ack;
    }

    return {
      reply,
      utteranceClass: decision.utteranceClass,
      released: null,
      cancelled: plan.cancelled,
      modelCalled: error === undefined,
      latency,
      ...(receiptAck !== undefined ? { receiptAck } : {}),
      ...(post.askWorkerOffer ? { askWorkerOffer: true } : {}),
      ...(post.addressedToTalker ? { addressedToTalker: true } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}

/**
 * Outcome description helper re-exported for the harness runner.
 */
export { describeOutcome };
