/**
 * Tier 1 — the guarded native harness (L4, plan §16).
 *
 * "The current harness, minimum stack replaced": the shipped talker stack's
 * mechanical gate survives intact — the PURE policy core
 * (`decideOperatorTurn`, extracted in L3) decides every turn, exactly as
 * `TalkerSession` executes it — and the ONE thing replaced is the voice
 * leg: the operator's speech reaches a native Gemini Live session, whose own
 * audio and `outputTranscription` are the conversational reply. The gate
 * does not move:
 *
 *   - The model has no send path. The only branch that hands text to the
 *     worker is the `release` decision, and it can only fire against a
 *     live, fresh draft the operator confirmed.
 *   - The [[ask-worker]] / [[to-talker]] end-anchored text markers become the
 *     two declared functions `offer_ask_worker()` / `mark_addressed_to_talker()`
 *     (a tag inside spoken audio is not detectable and the output transcript
 *     is too late to gate on). Both are NON_BLOCKING and acknowledged SILENT;
 *     the harness interprets them by synthesising the marker-equivalent reply
 *     and handing it to the SAME policy function that judged text markers —
 *     one owner of the semantics, zero re-implementation.
 *   - Mechanical replies (refusals, dead ends, release acks) are spoken from
 *     the trusted mechanical voice at receipt tier, and the same text is
 *     injected as a context update so the model knows what the host said.
 *     Native audio queued before the gate decided is discarded (the operator
 *     never hears the model over a gated transition), with honest player
 *     accounting — received = rendered + discarded + queued.
 *
 * The commit rule (§16.3) is a pure state machine (`TranscriptCommitTracker`):
 * an utterance is committed only when the provider signalled the end of the
 * input turn (activityEnd in E; the 400 ms no-delta window in N), the input
 * transcript has been stable for ≥ 400 ms, and it is non-empty after
 * relay-normalise. Partials are logged (every delta is a `provider_content`
 * event) and never committed. The commit latency — the price of N2 — is
 * measured and reported on every turn.
 *
 * Two transcript conditions (§16.2): `native` (Gemini's inputTranscription
 * decides; the shadow ASR is a fidelity reference) and `sidecar` (the shadow
 * ASR decides; Gemini's inputTranscription is the shadow).
 */

import { EVENT, type EventLog, type MonotonicClock } from '../scheduler.js';
import type { EndpointLane, PcmInputFormat, ProviderInputSink } from '../speech-driver.js';
import { ReferencePlayer } from '../playback.js';
import { GeminiLiveProvider, type SchedulerFn, type Tier1ToolName } from '../providers/gemini-live.js';
import {
  decideAfterModelReply,
  decideOperatorTurn,
  type ConversationalPlan,
  type PolicyDecision,
  type SpokenDecision,
} from '../../../../server/src/talker/policy-core.js';
import {
  PendingProposalStore,
  UtteranceLog,
  joinDraftText,
  type ReleaseVariant,
  type TakenRelease,
} from '../../../../server/src/talker/pending-proposal.js';
import { TalkerHistory } from '../../../../server/src/talker/history.js';
import { MODEL_FAILURE_REPLY, ackForOutcome, receiptAckFor } from '../../../../server/src/talker/ack.js';
import { renderStateView } from '../../../../server/src/talker/state-view.js';
import { normaliseRelayText } from '../../../../server/src/talker/relay-normalise.js';
import { loadTalkerSystemPrompt } from '../../../../server/src/talker/prompt.js';
import type { DeliveryOutcome, UtteranceClass, WorkerDelivery, WorkerStateSnapshot } from '../../../../server/src/talker/types.js';

// ── Transcript commit rule (§16.3) ───────────────────────────────────────────

export type CommitBoundary = 'activity-end' | 'vad-silence' | 'flush';

/** A committed operator utterance: what the gate will decide on. */
export interface CommitOutcome {
  /** Relay-normalised, non-empty. */
  text: string;
  /** The transcript bytes as received. */
  rawText: string;
  boundary: CommitBoundary;
  /** Provider end-of-input signal (E: activityEnd; N: last delta seen). */
  speechEndAtMs: number;
  lastDeltaAtMs: number;
  commitAtMs: number;
  /** commitAtMs - speechEndAtMs: the measured price of the commit rule. */
  commitLatencyMs: number;
}

export interface TranscriptCommitTrackerOptions {
  lane: EndpointLane;
  /** Stability window. Default 400 ms (§16.3). */
  stabilityMs?: number;
  normalise?: typeof normaliseRelayText;
}

/**
 * Pure commit-rule state machine. Fed transcription deltas and the E lane's
 * activityEnd; polled with a monotonic clock. No timers of its own, so tests
 * drive it deterministically and the harness arms the real polls.
 */
export class TranscriptCommitTracker {
  private readonly lane: EndpointLane;
  private readonly stabilityMs: number;
  private readonly normalise: typeof normaliseRelayText;

  private text = '';
  private lastDeltaAtMs: number | null = null;
  private activityEndAtMs: number | null = null;
  private open = false;

  constructor(options: TranscriptCommitTrackerOptions) {
    this.lane = options.lane;
    this.stabilityMs = options.stabilityMs ?? 400;
    this.normalise = options.normalise ?? normaliseRelayText;
  }

  hasOpenTurn(): boolean {
    return this.open;
  }

  get rawText(): string {
    return this.text;
  }

  /** True when the end-of-turn signal for the open turn has been seen. */
  hasActivityEnd(): boolean {
    return this.activityEndAtMs !== null;
  }

  get stabilityWindowMs(): number {
    return this.stabilityMs;
  }

  /** A transcription delta for the open (or newly opened) turn. */
  onDelta(text: string, atMs: number): void {
    if (!this.open) {
      this.open = true;
      this.text = '';
      // NOTE: activityEndAtMs is deliberately preserved across reopen. In
      // the native flow the ASR finalises the transcript AFTER the provider
      // acknowledged the end of the input turn — those late deltas belong to
      // the SAME utterance, and only reset() (a commit) starts the next one.
    }
    this.text += text;
    this.lastDeltaAtMs = atMs;
  }

  /** The E lane's explicit end-of-input-turn signal. */
  onActivityEnd(atMs: number): void {
    this.activityEndAtMs = atMs;
  }

  /**
   * Commit when the rule is satisfied, else null (partials stay partial).
   * `force` closes the turn at attempt end (an explicit boundary) without
   * waiting for stability; it still refuses empty-after-normalise text.
   */
  poll(nowMs: number, options: { force?: boolean } = {}): CommitOutcome | null {
    if (!this.open || this.lastDeltaAtMs === null) return null;
    if (!options.force && nowMs - this.lastDeltaAtMs < this.stabilityMs) return null;
    if (this.lane === 'E' && this.activityEndAtMs === null && !options.force) return null;

    const rawText = this.text;
    const normalised = this.normalise(rawText).text.trim();
    if (normalised === '') {
      // Nothing speakable was recognised: never a turn. Reset so a following
      // utterance starts fresh.
      this.reset();
      return null;
    }

    const speechEndAtMs =
      this.lane === 'E' && this.activityEndAtMs !== null ? this.activityEndAtMs : this.lastDeltaAtMs;
    const boundary: CommitBoundary =
      this.lane === 'E' && this.activityEndAtMs !== null ? 'activity-end' : 'vad-silence';
    const outcome: CommitOutcome = {
      text: normalised,
      rawText,
      boundary,
      speechEndAtMs,
      lastDeltaAtMs: this.lastDeltaAtMs,
      commitAtMs: nowMs,
      commitLatencyMs: nowMs - speechEndAtMs,
    };
    this.reset();
    return outcome;
  }

  reset(): void {
    this.open = false;
    this.text = '';
    this.lastDeltaAtMs = null;
    this.activityEndAtMs = null;
  }
}

// ── Legs the harness owns ────────────────────────────────────────────────────

export interface ShadowAsrOutcome {
  text: string;
  provider: string;
  model: string;
  ms: number;
  usage?: Record<string, unknown>;
}

/** The shadow (or, in the sidecar condition, deciding) transcription leg. */
export interface ShadowAsr {
  transcribe(pcm: Buffer): Promise<ShadowAsrOutcome>;
}

export interface MechanicalVoiceOutcome {
  /** 24 kHz s16le mono PCM, as the player expects. */
  pcm: Buffer;
  provider: string;
  model: string;
  voice: string;
  ms: number;
}

/**
 * The trusted voice for gate-owned transitions. Production binds Supertonic;
 * dry runs bind a labelled silence mock with real byte accounting.
 */
export interface MechanicalVoice {
  synthesise(text: string): Promise<MechanicalVoiceOutcome>;
}

export type Tier1TranscriptCondition = 'native' | 'sidecar';

export interface Tier1HarnessOptions {
  log: EventLog;
  /** Same clock the log was built with — speech-end anchoring must share it. */
  clock: MonotonicClock;
  lane: EndpointLane;
  condition: Tier1TranscriptCondition;
  provider: GeminiLiveProvider;
  delivery: WorkerDelivery;
  workerSessionId: string;
  snapshotProvider: () => WorkerStateSnapshot | Promise<WorkerStateSnapshot>;
  /** Required for the sidecar condition; fidelity reference in native. */
  shadowAsr?: ShadowAsr;
  mechanicalVoice?: MechanicalVoice;
  player?: ReferencePlayer;
  /** Commit stability window. Default 400 ms (§16.3). */
  stabilityMs?: number;
  /** Injectable commit-poll scheduler. Default: real setTimeout. */
  schedulePoll?: SchedulerFn;
  /** Conversational model-turn wait ceiling. Default 30 s. */
  turnTimeoutMs?: number;
  /** Confirm-gesture variant. Default 'tidied'. */
  releaseVariant?: ReleaseVariant;
}

/**
 * Everything the current operator turn has collected, from the previous
 * turn's close to this turn's close — model audio, output transcription and
 * tool calls may all arrive before or after the commit, and the window owns
 * them either way.
 */
interface TurnWindow {
  startedAtMs: number;
  firstDeltaAtMs: number | null;
  audioBytes: number;
  outputTranscript: string;
  toolCalls: Tier1ToolName[];
  modelTurnCompleteAtMs: number | null;
  interrupted: boolean;
  firstAudioAtMs: number | null;
}

export interface Tier1TurnRecord {
  turn: number;
  boundary: CommitBoundary;
  condition: Tier1TranscriptCondition;
  /** The transcript the gate decided on. */
  transcript: string;
  /** The Gemini input transcription for the turn. */
  nativeTranscript: string;
  /** The fidelity-reference transcript (whisper in native, Gemini in sidecar). */
  shadowTranscript: string | null;
  reply: string | null;
  utteranceClass: UtteranceClass | null;
  released: { utteranceId: number; text: string; delivery: DeliveryOutcome } | null;
  cancelled: boolean;
  receiptAck: string | null;
  draftSizeAfter: number;
  draftTextAfter: string;
  speechEndAtMs: number;
  firstAudioAtMs: number | null;
  ttfaMs: number | null;
  sttMs: number;
  modelMs: number | null;
  ttsMs: number;
  ttftMs: null;
  audioBytes: number;
  failedLeg: 'model' | 'tts' | null;
  commitLatencyMs: number;
  toolCalls: string[];
  modelTurnComplete: boolean;
  ttsProvider?: string;
  ttsModel?: string;
  ttsVoice?: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 30000;

function emptyWindow(startedAtMs: number): TurnWindow {
  return {
    startedAtMs,
    firstDeltaAtMs: null,
    audioBytes: 0,
    outputTranscript: '',
    toolCalls: [],
    modelTurnCompleteAtMs: null,
    interrupted: false,
    firstAudioAtMs: null,
  };
}

function draftSize(store: PendingProposalStore): number {
  return store.snapshotDraft()?.utterances.length ?? 0;
}

function draftText(store: PendingProposalStore): string {
  const snapshot = store.snapshotDraft();
  return snapshot ? joinDraftText(snapshot.utterances) : '';
}

// ── The harness ──────────────────────────────────────────────────────────────

export class Tier1GuardedHarness implements ProviderInputSink {
  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly lane: EndpointLane;
  private readonly condition: Tier1TranscriptCondition;
  private readonly provider: GeminiLiveProvider;
  private readonly delivery: WorkerDelivery;
  private readonly workerSessionId: string;
  private readonly snapshotProvider: () => WorkerStateSnapshot | Promise<WorkerStateSnapshot>;
  private readonly shadowAsr?: ShadowAsr;
  private readonly mechanicalVoice: MechanicalVoice;
  private readonly player: ReferencePlayer;
  private readonly tracker: TranscriptCommitTracker;
  private readonly schedulePoll: SchedulerFn;
  private readonly turnTimeoutMs: number;
  private readonly releaseVariant: ReleaseVariant;

  readonly utteranceLog: UtteranceLog;
  readonly proposals: PendingProposalStore;
  readonly history: TalkerHistory;

  private readonly turns: Tier1TurnRecord[] = [];
  private readonly turnPcm: Buffer[] = [];
  private window: TurnWindow;
  private chain: Promise<void> = Promise.resolve();
  private turnCount = 0;
  private started = false;
  private stopped = false;
  private pendingPollCancel: (() => void) | null = null;
  private readonly modelTurnWaiters: Array<() => void> = [];

  constructor(options: Tier1HarnessOptions) {
    if (options.condition === 'sidecar' && !options.shadowAsr) {
      throw new Error('the sidecar transcript condition requires a shadowAsr leg');
    }
    this.log = options.log;
    this.clock = options.clock;
    this.lane = options.lane;
    this.condition = options.condition;
    this.provider = options.provider;
    this.delivery = options.delivery;
    this.workerSessionId = options.workerSessionId;
    this.snapshotProvider = options.snapshotProvider;
    this.shadowAsr = options.shadowAsr;
    this.mechanicalVoice = options.mechanicalVoice ?? defaultMechanicalVoice();
    this.player = options.player ?? new ReferencePlayer({ log: options.log });
    this.tracker = new TranscriptCommitTracker({ lane: options.lane, stabilityMs: options.stabilityMs });
    this.schedulePoll = options.schedulePoll ?? defaultScheduler;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.releaseVariant = options.releaseVariant ?? 'tidied';
    this.utteranceLog = new UtteranceLog();
    this.proposals = new PendingProposalStore();
    this.history = new TalkerHistory();
    this.window = emptyWindow(this.clock.nowMs());
    this.provider.attachListener(this.listener());
  }

  private listener() {
    return {
      onInputTranscriptionDelta: (text: string, atMs: number) => {
        const wasOpen = this.tracker.hasOpenTurn();
        this.tracker.onDelta(text, atMs);
        if (!wasOpen) {
          this.window.firstDeltaAtMs = atMs;
          // Speech is active from the provider's point of view: context
          // updates are never injected mid-utterance (§16.2). In the N lane
          // the transcript itself marks the operator's floor.
          this.provider.setSpeechActive(true);
          if (this.lane === 'N') this.player.setOperatorFloor(true);
        }
        this.armCommitPoll();
      },
      onOutputTranscriptionDelta: (text: string) => {
        this.window.outputTranscript += text;
      },
      onAudioPcm: (pcm: Buffer, _mimeType: string, atMs: number) => {
        this.window.audioBytes += pcm.byteLength;
        if (this.window.firstAudioAtMs === null) this.window.firstAudioAtMs = atMs;
        this.player.receive(pcm);
      },
      onTurnComplete: (atMs: number) => {
        this.window.modelTurnCompleteAtMs = atMs;
        const waiters = this.modelTurnWaiters.splice(0);
        for (const waiter of waiters) waiter();
      },
      onInterrupted: () => {
        this.window.interrupted = true;
        // Duck profile records the interruption as ignored; native-interrupt
        // flushes the queue — the player owns the profile distinction.
        this.player.interrupt('provider-interrupted');
      },
      onToolCall: (call: { name: string }) => {
        if (call.name === 'mark_addressed_to_talker' || call.name === 'offer_ask_worker') {
          this.window.toolCalls.push(call.name);
        }
      },
    };
  }

  /** Open the live session and inject the initial state view (§16.2). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.provider.connect();
    const snapshot = await this.snapshotProvider();
    this.provider.updateStateView(renderStateView(snapshot, this.harnessView()));
  }

  private harnessView() {
    const draftSnap = this.proposals.snapshotDraft();
    const lastReleased = this.proposals.lastReleased;
    return {
      draft: draftSnap
        ? {
            utterances: draftSnap.utterances.map((u) => u.text),
            ageTurns: draftSnap.ageTurns,
            needsReConfirmation: draftSnap.needsReConfirmation,
          }
        : null,
      lastReleased: lastReleased ? { text: lastReleased.text, outcome: lastReleased.outcome } : null,
    };
  }

  // ── ProviderInputSink ──────────────────────────────────────────────────────

  pushAudio(frame: Buffer, format: PcmInputFormat, inputSequence: number): void {
    if (this.stopped) throw new Error('cannot push audio to a stopped Tier1GuardedHarness');
    this.turnPcm.push(Buffer.from(frame));
    this.provider.pushAudio(frame, format, inputSequence);
  }

  activityStart(atMs?: number): void {
    // The operator holds the floor: in-flight model audio ducks.
    this.player.setOperatorFloor(true);
    this.provider.activityStart(atMs);
  }

  activityEnd(atMs?: number): void {
    this.provider.activityEnd(atMs);
    this.player.setOperatorFloor(false);
    if (this.lane === 'E') {
      this.tracker.onActivityEnd(atMs ?? this.clock.nowMs());
      this.armCommitPoll();
    }
  }

  private armCommitPoll(): void {
    this.pendingPollCancel?.();
    this.pendingPollCancel = this.schedulePoll(() => {
      this.pendingPollCancel = null;
      this.pollCommits();
    }, this.tracker.stabilityWindowMs + 2);
  }

  private pollCommits(options: { force?: boolean } = {}): void {
    const outcome = this.tracker.poll(this.clock.nowMs(), options);
    if (!outcome) return;
    if (this.lane === 'N') this.player.setOperatorFloor(false);
    this.provider.setSpeechActive(false);
    this.enqueue(outcome);
  }

  private enqueue(outcome: CommitOutcome): void {
    this.chain = this.chain
      .then(() => this.executeTurn(outcome))
      .catch(() => {
        /* executeTurn never rejects; this guard keeps the chain alive */
      });
  }

  // ── Settling and teardown ─────────────────────────────────────────────────

  /**
   * True while a commit can still be reached by waiting: an E-lane turn with
   * no activityEnd can only ever be closed by flush's force, so waiting for
   * it in settle would deadlock the attempt.
   */
  private trackerCommittable(): boolean {
    if (!this.tracker.hasOpenTurn()) return true;
    if (this.lane === 'E' && !this.tracker.hasActivityEnd()) return false;
    return true;
  }

  /** Await every enqueued turn; commits anything whose window has elapsed. */
  async settle(): Promise<void> {
    for (;;) {
      this.pollCommits();
      await this.chain;
      if (!this.tracker.hasOpenTurn()) break;
      if (!this.trackerCommittable()) break;
      await settleTick();
    }
  }

  /**
   * Settle, then close any open turn as an explicit attempt-end boundary —
   * an utterance the attempt ended inside its stability window still counts;
   * silence-only residue does not.
   */
  async flush(): Promise<void> {
    await this.settle();
    if (this.tracker.hasOpenTurn()) {
      const outcome = this.tracker.poll(this.clock.nowMs(), { force: true });
      if (outcome) {
        const forced: CommitOutcome = { ...outcome, boundary: 'flush' };
        this.enqueue(forced);
      }
    }
    await this.chain;
  }

  async stop(reason = 'attempt-end'): Promise<void> {
    if (this.stopped) return;
    await this.flush();
    this.stopped = true;
    this.pendingPollCancel?.();
    this.player.stop(reason);
    this.provider.close(reason);
    this.log.append({
      source: 'harness',
      kind: EVENT.LIFECYCLE,
      id: `harness:stop:${this.turns.length}`,
      payload: { reason, turns: this.turns.length },
    });
  }

  get turnRecords(): readonly Tier1TurnRecord[] {
    return this.turns;
  }

  get completedTurns(): number {
    return this.turns.length;
  }

  get releases(): number {
    return this.turns.filter((t) => t.released !== null).length;
  }

  // ── Turn execution: the policy core, executed as the session does ─────────

  private async executeTurn(outcome: CommitOutcome): Promise<void> {
    const turn = ++this.turnCount;
    const speechAudio = Buffer.concat(this.turnPcm);
    this.turnPcm.length = 0;

    // The confirmation window ages at the boundary BEFORE this turn's events.
    this.proposals.tickTurn(turn);
    const record = this.utteranceLog.record(outcome.text, turn);

    // Shadow ASR runs on the operator's own audio every turn: fidelity
    // reference in native, the deciding transcript in sidecar.
    let shadow: ShadowAsrOutcome | null = null;
    let shadowMs = 0;
    if (this.shadowAsr) {
      const shadowStartedMs = this.clock.nowMs();
      shadow = await this.shadowAsr.transcribe(speechAudio);
      shadowMs = this.clock.nowMs() - shadowStartedMs;
    }
    const decidingText = this.condition === 'sidecar' ? (shadow?.text ?? outcome.text) : outcome.text;

    // THE GATE lives in policy-core (pure, model-free). The commit rule fed
    // it the deciding transcript; execution below only does what the
    // decision names.
    const decision: PolicyDecision = decideOperatorTurn({
      utterance: decidingText,
      turn,
      proposals: this.proposals,
      opts: { releaseVariant: this.releaseVariant },
    });

    await this.executeDecided(decision, outcome, turn, record.id, shadow, shadowMs, speechAudio.byteLength, decidingText);
  }

  private async executeDecided(
    decision: PolicyDecision,
    outcome: CommitOutcome,
    turn: number,
    recordId: number,
    shadow: ShadowAsrOutcome | null,
    shadowMs: number,
    audioBytes: number,
    decidingText: string
  ): Promise<void> {
    const window = this.window;

    // A gated turn must not leave the model's native audio in the operator's
    // ears: what was queued before the decision is discarded with honest
    // accounting, and the trusted voice speaks instead.
    const gated = decision.kind !== 'conversational' && decision.kind !== 'cancel';
    if (gated) this.player.stop('mechanical-gate');

    let record: Tier1TurnRecord;
    if (decision.kind === 'release') {
      record = await this.executeRelease(decision, outcome, turn, window);
    } else if (isMechanical(decision)) {
      record = await this.executeMechanical(decision, outcome, turn, window);
    } else {
      record = await this.executeSpoken(decision, outcome, turn, recordId, window);
    }
    if (gated) this.player.stop('mechanical-gate-tail');

    // Identity and measurement facts.
    record.turn = turn;
    record.boundary = outcome.boundary;
    record.commitLatencyMs = outcome.commitLatencyMs;
    record.condition = this.condition;
    record.transcript = decidingText;
    record.nativeTranscript = outcome.rawText;
    record.shadowTranscript =
      this.condition === 'native' ? (shadow?.text ?? null) : outcome.rawText;
    record.audioBytes = audioBytes;
    record.speechEndAtMs = outcome.speechEndAtMs;
    const firstAudio = record.firstAudioAtMs ?? window.firstAudioAtMs;
    record.firstAudioAtMs = firstAudio;
    record.ttfaMs = firstAudio !== null ? firstAudio - outcome.speechEndAtMs : null;

    // provider_content for the completed turn (scorer + fidelity analysis).
    this.log.append({
      source: 'provider',
      kind: EVENT.PROVIDER_CONTENT,
      id: `provider:tier1-turn:${turn}`,
      payload: {
        leg: 'tier1-turn',
        condition: this.condition,
        inputTranscription: decidingText,
        nativeTranscript: outcome.rawText,
        ...(record.shadowTranscript !== null ? { shadowTranscript: record.shadowTranscript } : {}),
        outputTranscription: record.reply,
        parts: window.audioBytes > 0 ? [{ mimeType: 'audio/pcm;rate=24000', audioBytes: window.audioBytes }] : [],
        legTimings: {
          sttMs: record.sttMs,
          modelMs: record.modelMs,
          ttsMs: record.ttsMs,
          commitLatencyMs: outcome.commitLatencyMs,
        },
        toolCalls: [...window.toolCalls],
        interrupted: window.interrupted,
      },
    });

    // provider_usage: the metered facts per leg, plus the shadow leg.
    this.log.append({
      source: 'provider',
      kind: EVENT.PROVIDER_USAGE,
      id: `provider:usage:turn:${turn}`,
      payload: {
        turn,
        stt:
          this.condition === 'sidecar' && shadow
            ? {
                provider: shadow.provider,
                model: shadow.model,
                ms: shadowMs,
                audioMs: (audioBytes / 2 / 16000) * 1000,
                deciding: true,
                ...(shadow.usage ?? {}),
              }
            : {
                provider: 'gemini-live',
                model: this.provider.modelName,
                ms: record.sttMs,
                audioMs: (audioBytes / 2 / 16000) * 1000,
                deciding: true,
              },
        ...(shadow && this.condition === 'native'
          ? {
              shadow: {
                provider: shadow.provider,
                model: shadow.model,
                ms: shadowMs,
                role: 'fidelity-reference',
                ...(shadow.usage ?? {}),
              },
            }
          : {}),
        ...(shadow && this.condition === 'sidecar'
          ? { nativeShadow: { provider: 'gemini-live', role: 'fidelity-reference' } }
          : {}),
        model: {
          modelCalled: !gated,
          totalMs: record.modelMs,
          replyChars: (record.reply ?? '').length,
          toolCalls: [...window.toolCalls],
          modelTurnComplete: record.modelTurnComplete,
        },
        ...(record.ttsProvider
          ? {
              tts: {
                provider: record.ttsProvider,
                model: record.ttsModel,
                voice: record.ttsVoice,
                ms: record.ttsMs,
                chars: (record.reply ?? '').length,
              },
            }
          : {}),
        audioMs: (audioBytes / 2 / 16000) * 1000,
      },
    });

    this.log.append({
      source: 'provider',
      kind: EVENT.TURN_COMPLETE,
      id: `provider:turn-complete:${turn}`,
      payload: {
        turn,
        lane: this.lane,
        condition: this.condition,
        boundary: record.boundary,
        transcript: record.transcript,
        nativeTranscript: record.nativeTranscript,
        ...(record.shadowTranscript !== null ? { shadowTranscript: record.shadowTranscript } : {}),
        reply: record.reply,
        utteranceClass: record.utteranceClass,
        released: record.released,
        cancelled: record.cancelled,
        receiptAck: record.receiptAck,
        draftSizeAfter: record.draftSizeAfter,
        draftTextAfter: record.draftTextAfter,
        speechEndAtMs: record.speechEndAtMs,
        firstAudioAtMs: record.firstAudioAtMs,
        ttfaMs: record.ttfaMs,
        sttMs: record.sttMs,
        modelMs: record.modelMs,
        ttsMs: record.ttsMs,
        ttftMs: null,
        audioBytes: record.audioBytes,
        failedLeg: record.failedLeg,
        commitLatencyMs: record.commitLatencyMs,
        toolCalls: [...window.toolCalls],
        modelTurnComplete: record.modelTurnComplete,
      },
    });
    this.turns.push(record);

    // Close the turn's window: the next utterance collects into a fresh one.
    this.window = emptyWindow(this.clock.nowMs());

    // §16.2: a context update after every harness transition (draft appended
    // / released / cancelled / lapsed). The provider coalesces (≥ 2 s apart)
    // and defers while speech is active.
    const snapshot = await this.snapshotProvider();
    this.provider.updateStateView(renderStateView(snapshot, this.harnessView()));
  }

  private async executeRelease(
    decision: Extract<PolicyDecision, { kind: 'release' }>,
    outcome: CommitOutcome,
    turn: number,
    window: TurnWindow
  ): Promise<Tier1TurnRecord> {
    const taken: TakenRelease | null = this.proposals.takeForRelease(
      turn,
      decision.selection ?? undefined,
      decision.variant
    );
    if (!taken) {
      // Defensive (unreachable through the commit rule): plain conversation.
      return this.executeSpoken(plainConversational(decision.utterance, decision.utteranceClass, turn), outcome, turn, 0, window);
    }
    const delivery = await this.delivery.deliver({ workerSessionId: this.workerSessionId, text: taken.text });
    this.proposals.recordReleased({
      utteranceId: taken.utteranceId,
      text: taken.text,
      outcome: describeOutcome(delivery),
      turn,
    });
    const reply = ackForOutcome(delivery);
    this.history.append({ role: 'user', content: decision.utterance, kind: 'operator', turn });
    this.history.append({ role: 'assistant', content: reply, kind: 'mechanical', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    const record = this.blankRecord(outcome, turn, window);
    record.utteranceClass = decision.utteranceClass;
    const ttsStartedMs = this.clock.nowMs();
    const spoken = await this.mechanicalVoice.synthesise(reply);
    record.ttsMs = this.clock.nowMs() - ttsStartedMs;
    record.firstAudioAtMs = this.clock.nowMs();
    record.ttsProvider = spoken.provider;
    record.ttsModel = spoken.model;
    record.ttsVoice = spoken.voice;
    this.player.receive(spoken.pcm);

    this.log.append({
      source: 'harness',
      kind: EVENT.HARNESS_RELEASE,
      id: `harness:release:turn:${turn}`,
      payload: {
        utteranceId: taken.utteranceId,
        text: taken.text,
        outcome: delivery.outcome,
        mechanism: delivery.mechanism,
        ack: reply,
      },
    });
    record.reply = reply;
    record.released = { utteranceId: taken.utteranceId, text: taken.text, delivery };
    record.draftSizeAfter = draftSize(this.proposals);
    record.draftTextAfter = draftText(this.proposals);
    return record;
  }

  private async executeMechanical(
    decision: MechanicalDecisionShape,
    outcome: CommitOutcome,
    turn: number,
    window: TurnWindow
  ): Promise<Tier1TurnRecord> {
    if (decision.kind === 'refuse-lapsed') this.proposals.markResurfaced(turn);
    const reply = decision.reply;
    this.history.append({ role: 'user', content: decision.utterance, kind: 'operator', turn });
    this.history.append({ role: 'assistant', content: reply, kind: 'mechanical', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    const record = this.blankRecord(outcome, turn, window);
    record.utteranceClass = decision.utteranceClass;
    const ttsStartedMs = this.clock.nowMs();
    const spoken = await this.mechanicalVoice.synthesise(reply);
    record.ttsMs = this.clock.nowMs() - ttsStartedMs;
    record.firstAudioAtMs = this.clock.nowMs();
    record.ttsProvider = spoken.provider;
    record.ttsModel = spoken.model;
    record.ttsVoice = spoken.voice;
    this.player.receive(spoken.pcm);

    this.log.append({
      source: 'harness',
      kind: EVENT.HARNESS_MECHANICAL,
      id: `harness:mechanical:turn:${turn}`,
      payload: { kind: 'mechanical', reply, decision: decision.kind },
    });
    record.reply = reply;
    record.draftSizeAfter = draftSize(this.proposals);
    record.draftTextAfter = draftText(this.proposals);
    return record;
  }

  private async executeSpoken(
    decision: SpokenDecision,
    outcome: CommitOutcome,
    turn: number,
    recordId: number,
    window: TurnWindow
  ): Promise<Tier1TurnRecord> {
    const plan: ConversationalPlan = decision.plan;

    // Pre-model state effects, exactly as the session orders them: a cancel
    // clears the old draft (a draftable residue composes fresh); a
    // worker-directed question joins the draft BEFORE the model turn.
    let draftRecordId = recordId;
    if (decision.kind === 'cancel') {
      this.proposals.cancel('operator cancelled', turn);
      if (plan.cancelResidue?.draftable) {
        draftRecordId = this.utteranceLog.record(plan.cancelResidue.text, turn).id;
      }
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_MECHANICAL,
        id: `harness:cancel:turn:${turn}`,
        payload: { kind: 'cancel' },
      });
    } else if (plan.path === 'worker-directed') {
      this.proposals.appendToDraft(recordId, decision.utterance, turn);
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_DRAFT_APPEND,
        id: `harness:draft:turn:${turn}:predraft`,
        payload: { source: 'utterance', path: 'worker-directed', text: decision.utterance },
      });
    }

    this.history.append({ role: 'user', content: decision.utterance, kind: 'operator', turn });

    // The conversational reply IS the native model's own turn: wait for the
    // turnComplete the provider's listener recorded. A ceiling keeps an
    // unattended run honest — a timeout is a failed leg, never silence.
    const completed = await this.waitForModelTurn(window);

    // The declared functions are the native equivalents of the end-anchored
    // markers: synthesise the marker-equivalent reply and let the ONE policy
    // function decide the effects — suppression and candidates only, never a
    // release.
    let markerEquivalent = window.outputTranscript;
    if (window.toolCalls.includes('mark_addressed_to_talker')) markerEquivalent += ' [[to-talker]]';
    if (window.toolCalls.includes('offer_ask_worker')) markerEquivalent += ' [[ask-worker]]';
    const post = decideAfterModelReply(decision, markerEquivalent);
    if (post.append) {
      this.proposals.appendToDraft(draftRecordId, post.append.text, turn);
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_DRAFT_APPEND,
        id: `harness:draft:turn:${turn}`,
        payload: { source: post.append.source, text: post.append.text },
      });
    }
    const reply = post.reply;
    this.history.append({ role: 'assistant', content: reply, kind: 'talker', turn });
    this.history.maybeTrim(this.proposals.pending !== null);

    let receiptAck: string | null = null;
    if (post.opensBatch) {
      const ack = receiptAckFor(this.utteranceLog.takeReceipt() ?? 0);
      if (ack) {
        receiptAck = ack;
        this.log.append({
          source: 'harness',
          kind: EVENT.HARNESS_RECEIPT,
          id: `harness:receipt:turn:${turn}`,
          payload: { reply: ack },
        });
      }
    }

    const record = this.blankRecord(outcome, turn, window);
    record.utteranceClass = decision.utteranceClass;
    record.cancelled = plan.cancelled;
    record.modelMs = completed
      ? Math.max(0, (window.modelTurnCompleteAtMs ?? outcome.commitAtMs) - outcome.commitAtMs)
      : null;
    record.modelTurnComplete = completed;
    record.reply = completed ? reply : MODEL_FAILURE_REPLY;
    record.failedLeg = completed ? null : 'model';
    record.receiptAck = receiptAck;
    record.draftSizeAfter = draftSize(this.proposals);
    record.draftTextAfter = draftText(this.proposals);
    return record;
  }

  private waitForModelTurn(window: TurnWindow): Promise<boolean> {
    if (window.modelTurnCompleteAtMs !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = this.modelTurnWaiters.indexOf(wake);
        if (index !== -1) this.modelTurnWaiters.splice(index, 1);
        resolve(false);
      }, this.turnTimeoutMs);
      this.modelTurnWaiters.push(wake);
    });
  }

  private blankRecord(outcome: CommitOutcome, turn: number, window: TurnWindow): Tier1TurnRecord {
    return {
      turn,
      boundary: outcome.boundary,
      condition: this.condition,
      transcript: outcome.text,
      nativeTranscript: outcome.rawText,
      shadowTranscript: null,
      reply: null,
      utteranceClass: null,
      released: null,
      cancelled: false,
      receiptAck: null,
      draftSizeAfter: draftSize(this.proposals),
      draftTextAfter: draftText(this.proposals),
      speechEndAtMs: outcome.speechEndAtMs,
      firstAudioAtMs: window.firstAudioAtMs,
      ttfaMs: null,
      sttMs:
        window.firstDeltaAtMs !== null
          ? Math.max(0, outcome.lastDeltaAtMs - window.firstDeltaAtMs)
          : 0,
      modelMs: null,
      ttsMs: 0,
      ttftMs: null,
      audioBytes: 0,
      failedLeg: null,
      commitLatencyMs: outcome.commitLatencyMs,
      toolCalls: [...window.toolCalls],
      modelTurnComplete: window.modelTurnCompleteAtMs !== null,
    };
  }
}

// ── Mechanical helpers ───────────────────────────────────────────────────────

type MechanicalDecisionShape = Extract<PolicyDecision, { reply: string }>;

function isMechanical(decision: PolicyDecision): decision is MechanicalDecisionShape {
  return (
    decision.kind === 'refuse-lapsed' ||
    decision.kind === 'refuse-stale-card' ||
    decision.kind === 'refuse-original-not-offered' ||
    decision.kind === 'clarify-selection' ||
    decision.kind === 'nothing-pending' ||
    decision.kind === 'nothing-to-cancel'
  );
}

function plainConversational(utterance: string, utteranceClass: UtteranceClass, turn: number): SpokenDecision {
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

function describeOutcome(outcome: { outcome: string; mechanism?: string; disclosure?: string; reason?: string }): string {
  if (outcome.outcome === 'delivered') return `delivered (${outcome.mechanism})`;
  if (outcome.outcome === 'queued') return `queued (${outcome.mechanism})`;
  return `not delivered (${outcome.reason ?? 'unknown reason'})`;
}

function defaultMechanicalVoice(): MechanicalVoice {
  return {
    async synthesise(text: string) {
      const words = Math.max(1, text.trim().split(/\s+/).length);
      return {
        pcm: Buffer.alloc(Math.round((24000 * words * 60) / 1000) * 2),
        provider: 'unbound-mechanical-voice',
        model: 'none',
        voice: 'none',
        ms: 0,
      };
    },
  };
}

function defaultScheduler(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

function settleTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

// ── System instruction (§16.2 wiring) ────────────────────────────────────────

const MARKER_LINES = /\[\[\s*(?:to-talker|ask-worker)\s*\]\]/i;

/**
 * The tier-1 system instruction: the v3-harness prompt minus the text-marker
 * lines (the tags are undetectable in spoken audio; the two declared
 * functions replace them), plus the function contract and the never-send rule.
 */
export function buildTier1SystemInstruction(promptText: string = loadTalkerSystemPrompt()): string {
  const kept = promptText
    .split('\n')
    .filter((line) => !MARKER_LINES.test(line))
    .join('\n')
    .trim();
  return [
    kept,
    '',
    'Bookkeeping functions (silent; calling them never speaks): call mark_addressed_to_talker when your reply is addressed to you, the talker itself, so the harness does not hold the operator\'s words for the worker; call offer_ask_worker when you cannot answer and want to offer asking the worker. The harness holds the operator\'s OWN question, which still needs their explicit confirmation.',
    'You never send; the host sends.',
  ].join('\n');
}
