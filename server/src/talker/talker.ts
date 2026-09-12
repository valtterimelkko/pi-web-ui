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
 *   2. The relay text is always the operator's raw utterance, referenced by
 *      id in the verbatim log. The model decides whether and when to ask;
 *      it never composes what is sent.
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
 * Turn flow:
 *   utterance → verbatim log → mechanical classification →
 *     confirm + live proposal  → release: deliver verbatim → fixed ack (no model call)
 *     cancel                   → clear proposal → conversational model turn
 *     otherwise                → record/update candidate → conversational model turn
 *   Every conversational turn rebuilds the state view fresh and sees the
 *   pending proposal and the last release as projection lines.
 */

import { classifyOperatorUtterance, isMetaSendQuestion, isWorkerDirectedQuestion } from './utterance-classifier.js';
import { PendingProposalStore, UtteranceLog } from './pending-proposal.js';
import { renderStateView } from './state-view.js';
import { TalkerHistory } from './history.js';
import { loadTalkerSystemPrompt } from './prompt.js';
import { ackForOutcome, describeOutcome, MODEL_FAILURE_REPLY } from './ack.js';
import type {
  ChatMessage,
  TalkerModelClient,
  TalkerTurnResult,
  WorkerDelivery,
  WorkerStateSnapshot,
} from './types.js';

export interface TalkerSessionConfig {
  /** Turns a candidate stays alive without resolution before it expires. */
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
  /** Fresh worker state material, called once per conversational turn. */
  snapshotProvider: () => WorkerStateSnapshot;
  config?: Partial<TalkerSessionConfig>;
}

export class TalkerSession {
  readonly utteranceLog: UtteranceLog;
  readonly proposals: PendingProposalStore;
  readonly history: TalkerHistory;

  private readonly model: TalkerModelClient;
  private readonly delivery: WorkerDelivery;
  private readonly workerSessionId: string;
  private readonly snapshotProvider: () => WorkerStateSnapshot;
  private readonly config: TalkerSessionConfig;
  private turnCount = 0;

  constructor(deps: TalkerSessionDeps) {
    this.model = deps.model;
    this.delivery = deps.delivery;
    this.workerSessionId = deps.workerSessionId;
    this.snapshotProvider = deps.snapshotProvider;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
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
   */
  async handleOperatorTurn(utterance: string): Promise<TalkerTurnResult> {
    if (!utterance || !utterance.trim()) {
      throw new Error('operator utterance must be non-empty');
    }

    this.turnCount += 1;
    const turn = this.turnCount;

    // Age/expire the live candidate at the boundary BEFORE this turn's events.
    this.proposals.tickTurn(turn);

    const record = this.utteranceLog.record(utterance, turn);
    const utteranceClass = classifyOperatorUtterance(utterance);

    if (utteranceClass === 'confirm') {
      const pending = this.proposals.pending;
      if (pending) {
        return this.release(utterance, turn);
      }
      // A confirmation with nothing pending falls through to conversation —
      // the model will ask "send what?". The "yes" itself is never recorded
      // as a candidate.
      return this.conversationalTurn(utterance, utteranceClass, turn, { recordedCandidate: false });
    }

    if (utteranceClass === 'cancel') {
      const cancelled = this.proposals.cancel('operator cancelled', turn);
      return this.conversationalTurn(utterance, utteranceClass, turn, { cancelled });
    }

    // A meta question about the send in flight ("did you send it?") keeps the
    // current proposal; a worker-directed question ("could you ask the worker
    // to rebase?") and every statement become/replace the candidate a later
    // confirmation would release; chat and status questions become nothing.
    if (utteranceClass === 'question') {
      if (!isMetaSendQuestion(utterance) && isWorkerDirectedQuestion(utterance)) {
        this.proposals.recordCandidate(utterance, turn, record.id);
      }
      return this.conversationalTurn(utterance, utteranceClass, turn, { recordedCandidate: false });
    }
    this.proposals.recordCandidate(utterance, turn, record.id);
    return this.conversationalTurn(utterance, utteranceClass, turn, { recordedCandidate: true });
  }

  /**
   * The single release path. Private by construction: reachable only from the
   * confirm branch above. It takes NO relay text — the text comes from the
   * pending-proposal store via takeForRelease(), which is null-safe, so even
   * a forced direct call cannot relay anything that was not a recorded,
   * unexpired, live proposal.
   */
  private async release(confirmingUtterance: string, turn: number): Promise<TalkerTurnResult> {
    const taken = this.proposals.takeForRelease(turn);
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
    flags: { recordedCandidate?: boolean; cancelled?: boolean }
  ): Promise<TalkerTurnResult> {
    const snapshot = this.snapshotProvider();
    const pending = this.proposals.pending;
    const lastReleased = this.proposals.lastReleased;
    const stateView = renderStateView(snapshot, {
      pendingUtterance: pending?.text ?? null,
      pendingAgeTurns: pending?.ageTurns ?? null,
      lastReleased: lastReleased ? { text: lastReleased.text, outcome: lastReleased.outcome } : null,
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

    this.history.append({ role: 'assistant', content: reply, kind: 'talker', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    return {
      reply,
      utteranceClass,
      released: null,
      cancelled: flags.cancelled ?? false,
      modelCalled: error === undefined,
      latency,
      ...(error !== undefined ? { error } : {}),
    };
  }
}

/**
 * Outcome description helper re-exported for the harness runner.
 */
export { describeOutcome };
