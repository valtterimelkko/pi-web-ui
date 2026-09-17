/**
 * Tier 3 orchestrator harness (L5, plan §17.4).
 *
 * Tier 3 has no talker and no relay gate: the live model IS the orchestrator,
 * and its authority is bounded by the tool allow-list and the confirmation
 * protocol enforced in `tier3-tools.ts`. This module owns the parts a live
 * model cannot own for itself:
 *
 *   - the connect config: audio out, both transcriptions, `sessionResumption:
 *     {}` and `contextWindowCompression: { slidingWindow: {}, triggerTokens:
 *     100000 }` on EVERY tier-3 connection;
 *   - lifetime handling: on `goAway`, finish in-flight `sendToolResponse`,
 *     close, reconnect with the last `sessionResumptionUpdate.newHandle`,
 *     increment `connectionGeneration`, and restore orchestration state from
 *     the HOST (tool ledger, pending confirmations, milestone log, children) —
 *     never from the model's memory;
 *   - the operator's committed utterance, which is what the confirmation
 *     protocol acts on (the model's claim never grants anything);
 *   - event logging in the lab's dense monotonic vocabulary, so the attempt
 *     record, the manifest and the offline verifier agree.
 *
 * Fully injectable: unit tests and the hermetic dry run supply a scripted
 * `LiveSessionFactory`, a scripted Internal API and a scripted command runner.
 */

import { createHash } from 'node:crypto';

import { EVENT, type EventLog, type MonotonicClock } from '../scheduler.js';
import {
  TIER3_FUNCTION_DECLARATIONS,
  TIER3_RESPONSE_SCHEDULING,
  Tier3ToolHost,
  type Tier3ToolExecution,
} from '../tier3-tools.js';
import type { PcmInputFormat, ProviderInputSink } from '../speech-driver.js';
import {
  TranscriptCommitTracker,
  type CommitOutcome,
} from './tier1-guarded.js';
import type {
  LiveCallbacks,
  LiveConnectConfigShape,
  LiveConnectRequest,
  LiveServerMessageShape,
  LiveSessionFactory,
  LiveSessionLike,
} from '../providers/gemini-live.js';
import { classifyOperatorUtterance } from '../../../../server/src/talker/utterance-classifier.js';
import type { UtteranceClass } from '../../../../server/src/talker/types.js';

export type Tier3OperatorUtterance = { text: string; kind: UtteranceClass };

// ── Frozen condition: connect config and system instruction ─────────────────

export const TIER3_DEFAULT_MODEL = 'gemini-3.8-live';
export const TIER3_SYSTEM_INSTRUCTION_VERSION = 'tier3-orchestrator-v1';
/** §17.4: compression triggers at 100k tokens on every tier-3 connection. */
export const TIER3_CONTEXT_TRIGGER_TOKENS = 100_000;
/** §21: budgets allow at most 3 reconnections per attempt. */
export const TIER3_MAX_RECONNECTIONS = 3;

export interface Tier3ConnectConfigShape extends LiveConnectConfigShape {
  contextWindowCompression?: {
    slidingWindow?: Record<string, never>;
    triggerTokens?: number;
  };
}

export interface Tier3ConnectConfigOptions {
  systemInstruction: string;
  triggerTokens?: number;
  /** Resume handle from the previous connection, when reconnecting. */
  resumeHandle?: string;
}

/**
 * The tier-3 connect config. `sessionResumption` carries the previous handle
 * when reconnecting; compression is configured on every connection, as §17.4
 * requires.
 */
export function buildTier3ConnectConfig(options: Tier3ConnectConfigOptions): Tier3ConnectConfigShape {
  return {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: options.resumeHandle ? { handle: options.resumeHandle } : {},
    contextWindowCompression: {
      slidingWindow: {},
      triggerTokens: options.triggerTokens ?? TIER3_CONTEXT_TRIGGER_TOKENS,
    },
    tools: [{ functionDeclarations: TIER3_FUNCTION_DECLARATIONS }],
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
  };
}

/**
 * The tier-3 system instruction: the two mandatory skills summarised in under
 * 600 words, plus the tool contract. The live model cannot read files, so the
 * operating discipline has to live in the context — and the exact text is
 * versioned and hashed into the attempt's condition, so a reworded prompt is a
 * different condition rather than a silent edit.
 */
export function buildTier3SystemInstruction(): string {
  return [
    'You orchestrate a small engineering task, speaking with the owner by voice. You do almost no implementation yourself: you brief children, verify what they produce, and report milestones.',
    '',
    'TWO SKILLS YOU FOLLOW. The pi-web-ui-internal-api-orchestration skill covers driving sessions, watches and receipts through the Internal API. The long-horizon-waiting-strategies skill covers waiting without burning turns: register a durable watch, end your turn, let the watch wake you. You cannot read files, so everything you need is here and in the children\'s results.',
    '',
    'WHO DOES WHAT. You create children with create_child, give them work, and read their results. Children run on a route the host fixes; you never choose a model. Child 1 owns repo-core; Child 2 owns repo-tools and then a later wiring change in repo-core. Work that touches a repository another child is editing is GATED until that child has committed and its tests pass. Un-gate it YOURSELF: do not ask the owner for permission to un-gate, and do not blanket-gate work with no conflicting writer.',
    '',
    'WAITING — THE RULE THAT MATTERS MOST. Never poll. Do not read status in a loop, do not re-read transcripts to pass the time, do not run sleeps. Register a watch with wait_for and end your turn; the host holds your result and returns it when the watch fires. Two child_status or read_child calls inside thirty seconds with no wait_for between them count as a poll and cost you points. While a wait_for is open you may still answer the owner, then go quiet again.',
    '',
    'QUALITY BEFORE UN-GATING. Inspect the dependency first: run_checked "git -C <dir> log --oneline" and run_checked "python3 -m unittest discover -s <repo>/tests". Un-gating without that inspection is a failure, not an efficiency.',
    '',
    'WHEN THE OWNER ASKS YOU SOMETHING. Answer from what you know. Asked whether you may do something you were already told to do, say it is your call — do not seek permission you already hold. Asked for a fact you should establish from the repository, say you will find out and go and do it; never guess and never ask them to supply it.',
    '',
    'TOOLS AND THEIR BOUNDS. The host enforces the allow-list; anything outside it is refused with a reason, so do not work around a refusal. run_checked accepts only: git -C <dir> log|status|diff inside the run directory, python3 -m unittest … with the run directory as the working directory, bash <path>/ctl.sh restart|health|status, and cat/ls inside the run directory. ctl.sh restart needs the owner\'s spoken confirmation, and only a confirmation the owner actually committed will do; asking twice does not grant it. Your first create_child needs their confirmation too.',
    '',
    'SPEAKING. Short, operational sentences. Say what you did and what happens next. Distinguish what a child SAID from what the repository SHOWS: never call work done because a child reported it — call it done when you have run the check. Milestones only at operational moments, via notify_owner. If you do not know, say so.',
    '',
    'IF THE CONNECTION IS INTERRUPTED the host reconnects and restores your state from its own ledger, telling you which tool calls are open and which children exist. Trust that message over your recollection.',
  ].join('\n');
}

export function tier3SystemInstructionHash(instruction = buildTier3SystemInstruction()): string {
  return createHash('sha256').update(instruction).digest('hex');
}

// ── Host-owned state across connection generations ──────────────────────────

export interface Tier3GenerationRecord {
  generation: number;
  startedAtMs: number;
  resumed: boolean;
  handle?: string;
  endedAtMs?: number;
  reason?: string;
  finishedInFlightResponses: number;
}

export interface Tier3OrchestratorOptions {
  log: EventLog;
  clock: MonotonicClock;
  lane: 'E' | 'N';
  model: string;
  systemInstruction: string;
  sessionFactory: LiveSessionFactory;
  toolHost: Tier3ToolHost;
  /** Commit-stability window for the operator's own utterance (default 400 ms). */
  stabilityMs?: number;
  triggerTokens?: number;
  maxReconnections?: number;
  /** Injectable sleep (watch deadlines in tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface Tier3ToolResponseRecord {
  callId: string;
  name: string;
  generation: number;
  delivered: boolean;
  /** Set when the response had to be re-issued as a context update. */
  reissued?: boolean;
  result: Tier3ToolExecution;
}

/**
 * The orchestrator. It implements `ProviderInputSink`, so the same speech
 * driver that measures tiers 1 and 2 drives the tier-3 operator.
 */
export class Tier3Orchestrator implements ProviderInputSink {
  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly lane: 'E' | 'N';
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly sessionFactory: LiveSessionFactory;
  private readonly toolHost: Tier3ToolHost;
  private readonly tracker: TranscriptCommitTracker;
  private readonly triggerTokens: number;
  private readonly maxReconnections: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private session: LiveSessionLike | null = null;
  private generation = 0;
  private handle: string | null = null;
  private closing = false;
  private stopped = false;
  private reconnecting = false;
  private messageSeq = 0;
  private pushedBytes = 0;

  private inFlightResponses = 0;
  private inFlightToolCalls = new Set<Promise<void>>();
  private contextUpdateQueue: string[] = [];

  readonly generations: Tier3GenerationRecord[] = [];
  readonly toolResponses: Tier3ToolResponseRecord[] = [];
  readonly commits: CommitOutcome[] = [];
  readonly operatorUtterances: Tier3OperatorUtterance[] = [];
  stopReason: string | null = null;

  /**
   * The committed-utterance hook. Wired by default to the tool host's
   * confirmation registry, so only a committed `confirm` grants a pending
   * request — and any other committed utterance grants nothing.
   */
  confirmationHook: ((utterance: Tier3OperatorUtterance) => boolean) | null;

  constructor(options: Tier3OrchestratorOptions) {
    this.log = options.log;
    this.clock = options.clock;
    this.lane = options.lane;
    this.model = options.model;
    this.systemInstruction = options.systemInstruction;
    this.sessionFactory = options.sessionFactory;
    this.toolHost = options.toolHost;
    this.triggerTokens = options.triggerTokens ?? TIER3_CONTEXT_TRIGGER_TOKENS;
    this.maxReconnections = options.maxReconnections ?? TIER3_MAX_RECONNECTIONS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tracker = new TranscriptCommitTracker({
      lane: options.lane,
      stabilityMs: options.stabilityMs ?? 400,
    });
    this.confirmationHook = (utterance) => this.toolHost.confirmationRegistry.noteOperatorUtterance(utterance);
    // §17.2: the host injects "the owner must confirm; ask them" as a context
    // update when a consequential tool call needs a confirmation. Wiring it
    // here means a hold can never be silent.
    this.toolHost.confirmationRegistry.setRequestSink((request) => this.sendContextUpdate(request.text));
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  get resumptionHandle(): string | null {
    return this.handle;
  }

  get isConnected(): boolean {
    return this.session !== null && !this.closing;
  }

  get pushedMs(): number {
    return (this.pushedBytes / 2 / 16_000) * 1000;
  }

  /** Open the first connection (generation 1). */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('cannot start a stopped Tier3Orchestrator');
    await this.openSession(false);
  }

  private async openSession(resumed: boolean): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const record: Tier3GenerationRecord = {
      generation,
      startedAtMs: this.clock.nowMs(),
      resumed,
      ...(resumed && this.handle ? { handle: this.handle } : {}),
      finishedInFlightResponses: 0,
    };
    this.generations.push(record);
    this.reconnecting = false;

    const config = buildTier3ConnectConfig({
      systemInstruction: this.systemInstruction,
      triggerTokens: this.triggerTokens,
      ...(resumed && this.handle ? { resumeHandle: this.handle } : {}),
    });
    const request: LiveConnectRequest = {
      model: this.model,
      config,
      callbacks: this.callbacksFor(generation),
    };
    this.session = await this.sessionFactory(request);
    this.log.append({
      source: 'tier3',
      kind: EVENT.LIFECYCLE,
      id: `tier3:connect:${this.messageSeq += 1}`,
      payload: {
        event: resumed ? 'reconnected' : 'connected',
        generation,
        model: this.model,
        lane: this.lane,
        resumedWithHandle: resumed ? this.handle : null,
        contextWindowCompression: { slidingWindow: true, triggerTokens: this.triggerTokens },
      },
    });

    if (resumed) {
      // One context update restores orchestration state from the host (§17.4).
      this.sendContextUpdate(`${this.toolHost.snapshotForReconnect()}`);
      this.flushHeldToolResults();
    }
  }

  /**
   * Re-issue, as a context update tagged with the original call id, every tool
   * result that could not go out as a function response because the socket was
   * down. §17.4 makes "does an unanswered NON_BLOCKING call survive a resume?"
   * a probe; re-issuing unconditionally is the deterministic host-side
   * behaviour, and it is idempotent.
   */
  private flushHeldToolResults(): void {
    for (const record of this.toolResponses) {
      if (record.delivered || record.reissued) continue;
      record.reissued = true;
      this.sendContextUpdate(
        `Tool ${record.name} (call id ${record.callId}) completed while the connection was re-establishing. ` +
          `Result: ${JSON.stringify(record.result.response)}`
      );
    }
  }

  private callbacksFor(generation: number): LiveCallbacks {
    return {
      onOpen: () => {
        this.log.append({
          source: 'tier3',
          kind: EVENT.PROVIDER_CONTENT,
          id: `tier3:open:${this.messageSeq += 1}`,
          payload: { event: 'open', generation },
        });
      },
      onMessage: (message) => this.handleMessage(message, generation),
      onError: (error) => {
        this.log.append({
          source: 'tier3',
          kind: EVENT.PROVIDER_ERROR,
          id: `tier3:socket-error:${this.messageSeq += 1}`,
          payload: { leg: 'socket', generation, message: error instanceof Error ? error.message : String(error) },
        });
      },
      onClose: () => {
        this.log.append({
          source: 'tier3',
          kind: EVENT.LIFECYCLE,
          id: `tier3:socket-closed:${this.messageSeq += 1}`,
          payload: { event: 'socketClosed', generation },
        });
      },
    };
  }

  // ── ProviderInputSink (the operator path) ──────────────────────────────────

  pushAudio(frame: Buffer, _format: PcmInputFormat, _inputSequence: number): void {
    if (!this.session) throw new Error('Tier3Orchestrator: not connected');
    this.pushedBytes += frame.byteLength;
    this.session.sendRealtimeInput({
      audio: { mimeType: 'audio/pcm;rate=16000', data: frame.toString('base64') },
    });
  }

  activityStart(_atMs?: number): void {
    if (this.lane === 'E') this.session?.sendRealtimeInput({ activityStart: {} });
    this.flushContextUpdates();
  }

  /**
   * The E lane's end-of-input boundary. The `atMs` argument is IGNORED: the
   * speech driver passes the stream's *duration* there, not a clock reading,
   * and a commit rule anchored on a duration would be nonsense.
   */
  activityEnd(_atMs?: number): void {
    const now = this.clock.nowMs();
    this.tracker.onActivityEnd(now);
    if (this.lane === 'E') this.session?.sendRealtimeInput({ activityEnd: {} });
  }

  /**
   * Commit any stable operator utterance and return it. The driver calls this
   * after streaming a beat; it is also the point at which a committed
   * `confirm` can satisfy a pending confirmation request.
   */
  settle(options: { force?: boolean } = {}): CommitOutcome | null {
    const committed = this.tracker.poll(this.clock.nowMs(), options);
    if (!committed) return null;
    this.commits.push(committed);
    this.noteOperatorUtterance(committed.text);
    return committed;
  }

  /**
   * Feed a committed operator utterance into the host. Only a committed
   * `confirm` grants a pending confirmation; the model's own words never do.
   */
  noteOperatorUtterance(text: string): { kind: UtteranceClass; granted: boolean } {
    const kind = classifyOperatorUtterance(text);
    this.operatorUtterances.push({ text, kind });
    this.log.append({
      source: 'tier3',
      kind: EVENT.TURN_COMPLETE,
      id: `tier3:operator:${this.messageSeq += 1}`,
      payload: {
        leg: 'operator-utterance',
        kind,
        text,
        chars: text.length,
        generation: this.generation,
        committedAtMs: this.clock.nowMs(),
      },
    });
    const granted = this.confirmationHook ? this.confirmationHook({ text, kind }) : false;
    return { kind, granted };
  }
  // ── Server-message handling ────────────────────────────────────────────────

  private handleMessage(message: LiveServerMessageShape, generation: number): void {
    if (generation !== this.generation) {
      // A message from a generation that has already been superseded must not
      // mutate current state; it is recorded and dropped.
      this.log.append({
        source: 'tier3',
        kind: EVENT.LIFECYCLE,
        id: `tier3:stale-generation-message:${this.messageSeq += 1}`,
        payload: { event: 'staleGenerationMessage', generation, currentGeneration: this.generation },
      });
      return;
    }
    if (message.setupComplete !== undefined) {
      this.log.append({
        source: 'tier3',
        kind: EVENT.LIFECYCLE,
        id: `tier3:setup-complete:${this.messageSeq += 1}`,
        payload: { event: 'setupComplete', generation },
      });
    }
    if (message.sessionResumptionUpdate?.newHandle) {
      this.handle = message.sessionResumptionUpdate.newHandle;
      this.log.append({
        source: 'tier3',
        kind: EVENT.LIFECYCLE,
        id: `tier3:resumption:${this.messageSeq += 1}`,
        payload: {
          event: 'sessionResumptionUpdate',
          generation,
          newHandle: this.handle,
          resumable: message.sessionResumptionUpdate.resumable ?? false,
        },
      });
    }
    if (message.goAway) {
      void this.handleGoAway(message.goAway.timeLeft ?? '');
    }
    if (message.toolCall?.functionCalls?.length) {
      for (const call of message.toolCall.functionCalls) {
        if (!call.name) continue;
        this.log.append({
          source: 'provider',
          kind: EVENT.PROVIDER_CONTENT,
          id: `tier3:tool-call:${this.messageSeq += 1}`,
          payload: {
            toolCall: { name: call.name, args: call.args ?? {}, id: call.id ?? '' },
            generation,
          },
        });
        const promise = this.dispatchToolCall({
          name: call.name,
          args: call.args ?? {},
          id: call.id ?? '',
          generation,
        });
        this.inFlightToolCalls.add(promise);
        void promise.finally(() => this.inFlightToolCalls.delete(promise));
      }
    }
    if (message.serverContent) {
      const content = message.serverContent;
      const atMs = this.clock.nowMs();
      const inputText = content.inputTranscription?.text ?? '';
      const outputText = content.outputTranscription?.text ?? '';
      const audioParts = (content.modelTurn?.parts ?? []).filter((part) => part.inlineData?.data);
      const audioBytes = audioParts.reduce(
        (sum, part) => sum + Buffer.from(part.inlineData?.data ?? '', 'base64').byteLength,
        0
      );
      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_CONTENT,
        id: `tier3:content:${this.messageSeq += 1}`,
        payload: {
          ...(inputText ? { inputTranscription: inputText } : {}),
          ...(outputText ? { outputTranscription: outputText } : {}),
          ...(audioBytes > 0 ? { parts: [{ mimeType: 'audio/pcm;rate=24000', audioBytes }] } : {}),
          turnComplete: content.turnComplete ?? false,
          interrupted: content.interrupted ?? false,
          generation,
        },
      });
      if (inputText) this.tracker.onDelta(inputText, atMs);
      if (content.turnComplete) {
        this.log.append({
          source: 'provider',
          kind: EVENT.TURN_COMPLETE,
          id: `tier3:turn-complete:${this.messageSeq += 1}`,
          payload: {
            leg: 'tier3-model-turn',
            generation,
            outputChars: outputText.length,
            audioBytes,
            openToolCalls: this.toolHost.pendingCallIds(),
          },
        });
        this.flushContextUpdates();
      }
    }
    if (message.usageMetadata) {
      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_USAGE,
        id: `tier3:usage:${this.messageSeq += 1}`,
        payload: { ...message.usageMetadata, generation },
      });
    }
  }

  // ── Tool calls and their responses ─────────────────────────────────────────

  private async dispatchToolCall(call: {
    name: string;
    args: Record<string, unknown>;
    id: string;
    generation: number;
  }): Promise<void> {
    let execution: Tier3ToolExecution;
    try {
      execution = await this.toolHost.execute(call);
    } catch (error) {
      execution = {
        ok: false,
        status: 'error',
        response: { ok: false, error: error instanceof Error ? error.message : String(error) },
      };
    }
    const record: Tier3ToolResponseRecord = {
      callId: call.id,
      name: call.name,
      generation: call.generation,
      delivered: false,
      result: execution,
    };
    this.toolResponses.push(record);
    await this.sendToolResponse(record);
  }

  /**
   * Send one tool response. `WHEN_IDLE` scheduling so the result joins the
   * conversation and prompts a turn without interrupting one in progress.
   * In-flight sends are tracked so a `goAway` can finish them before closing.
   */
  private async sendToolResponse(record: Tier3ToolResponseRecord): Promise<void> {
    if (!this.session || this.closing || this.reconnecting) {
      // Held and re-issued as a context update after the reconnect (§17.4).
      this.log.append({
        source: 'tier3',
        kind: EVENT.LIFECYCLE,
        id: `tier3:tool-response-held:${this.messageSeq += 1}`,
        payload: { event: 'toolResponseHeld', callId: record.callId, name: record.name, generation: this.generation },
      });
      return;
    }
    this.inFlightResponses += 1;
    try {
      this.session.sendToolResponse({
        functionResponses: [
          {
            id: record.callId,
            name: record.name,
            response: record.result.response,
            scheduling: TIER3_RESPONSE_SCHEDULING,
          },
        ],
      });
      record.delivered = true;
      this.log.append({
        source: 'tier3',
        kind: EVENT.LIFECYCLE,
        id: `tier3:tool-response:${this.messageSeq += 1}`,
        payload: {
          event: 'toolResponseSent',
          callId: record.callId,
          name: record.name,
          status: record.result.status,
          scheduling: TIER3_RESPONSE_SCHEDULING,
          generation: this.generation,
        },
      });
    } catch (error) {
      this.log.append({
        source: 'tier3',
        kind: EVENT.PROVIDER_ERROR,
        id: `tier3:tool-response-error:${this.messageSeq += 1}`,
        payload: {
          leg: 'tool-response',
          callId: record.callId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.inFlightResponses -= 1;
    }
  }

  /** Wait for every in-flight tool-response SEND to settle. A `goAway` must
   *  finish sends before closing, but must NOT wait for long-running tool
   *  executions (a `wait_for` can legitimately run for ten minutes). */
  async drainResponses(): Promise<void> {
    let guard = 0;
    while (this.inFlightResponses > 0 && guard < 1000) {
      guard += 1;
      await this.sleep(0);
    }
  }

  /** Wait for every in-flight tool send AND tool execution to settle. */
  async drain(): Promise<void> {
    let guard = 0;
    while ((this.inFlightResponses > 0 || this.inFlightToolCalls.size > 0) && guard < 100_000) {
      guard += 1;
      await Promise.allSettled([...this.inFlightToolCalls]);
      if (this.inFlightResponses === 0 && this.inFlightToolCalls.size === 0) break;
      await this.sleep(0);
    }
  }

  // ── Lifetime handling (§17.4) ──────────────────────────────────────────────

  /**
   * A `goAway` finished: finish what is in flight, close, reconnect with the
   * last handle, bump the generation and restore host state. A fourth
   * reconnection in one attempt is refused (`reconnection-budget-exhausted`),
   * because §21 budgets at most three.
   */
  async handleGoAway(timeLeft: string): Promise<void> {
    if (this.stopped) return;
    const current = this.generations.at(-1);
    if (current) current.endedAtMs = this.clock.nowMs();
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.log.append({
      source: 'tier3',
      kind: EVENT.LIFECYCLE,
      id: `tier3:go-away:${this.messageSeq += 1}`,
      payload: { event: 'goAway', timeLeft, generation: this.generation },
    });

    // 1. Finish in-flight tool responses before closing. Tool EXECUTIONS may
    //    still be running: they continue across the reconnect and their
    //    results are re-issued from the host's ledger.
    const before = this.inFlightResponses;
    await this.drainResponses();
    if (current) current.finishedInFlightResponses = before;

    // 2. Close the dying connection.
    try {
      this.session?.close();
    } catch {
      // A close failure must never mask the attempt's own outcome.
    }
    this.session = null;

    // 3. Budget check, then reconnect with the last handle.
    if (this.generation >= this.maxReconnections) {
      this.stopped = true;
      this.stopReason = 'reconnection-budget-exhausted';
      this.log.append({
        source: 'tier3',
        kind: EVENT.LIFECYCLE,
        id: `tier3:reconnection-budget:${this.messageSeq += 1}`,
        payload: {
          event: 'reconnectionBudgetExhausted',
          generations: this.generation,
          maxReconnections: this.maxReconnections,
        },
      });
      this.reconnecting = false;
      return;
    }
    await this.openSession(true);
    this.log.append({
      source: 'tier3',
      kind: EVENT.LIFECYCLE,
      id: `tier3:generation-restored:${this.messageSeq += 1}`,
      payload: {
        event: 'stateRestored',
        generation: this.generation,
        children: this.toolHost.children.length,
        openToolCalls: this.toolHost.pendingCallIds(),
        pendingConfirmation: this.toolHost.pendingConfirmationAction(),
      },
    });
    this.reconnecting = false;
    // A result that landed between the reconnect and this point is flushed too.
    this.flushHeldToolResults();
  }

  // ── Context updates ────────────────────────────────────────────────────────

  /**
   * Queue a context update. Updates are never injected mid-utterance; they are
   * flushed when the model's turn completes or the operator's activity ends.
   */
  sendContextUpdate(text: string): void {
    this.contextUpdateQueue.push(text);
    this.flushContextUpdates();
  }

  private flushContextUpdates(): void {
    if (!this.session) return;
    for (const text of this.contextUpdateQueue.splice(0)) {
      try {
        this.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: false,
        });
        this.log.append({
          source: 'tier3',
          kind: EVENT.LIFECYCLE,
          id: `tier3:context-update:${this.messageSeq += 1}`,
          payload: { event: 'contextUpdate', chars: text.length, generation: this.generation },
        });
      } catch (error) {
        this.log.append({
          source: 'tier3',
          kind: EVENT.PROVIDER_ERROR,
          id: `tier3:context-update-error:${this.messageSeq += 1}`,
          payload: { leg: 'context-update', message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  async stop(reason = 'attempt-end'): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.drain();
    this.session?.close();
    this.session = null;
    const current = this.generations.at(-1);
    if (current) {
      current.endedAtMs = this.clock.nowMs();
      current.reason = reason;
    }
    this.log.append({
      source: 'tier3',
      kind: EVENT.LIFECYCLE,
      id: `tier3:close:${this.messageSeq += 1}`,
      payload: { event: 'close', reason, generations: this.generation },
    });
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
