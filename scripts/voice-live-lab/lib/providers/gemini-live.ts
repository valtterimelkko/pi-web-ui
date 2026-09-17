/**
 * Gemini Live provider adapter (L4, plan §16.2).
 *
 * The narrow, fully-injectable seam between the lab and `@google/genai`
 * 1.52.0 `ai.live.connect`. It implements `ProviderInputSink`, so the same
 * speech driver that measures the baseline drives the native candidate:

 *     driver PCM ──▶ pushAudio ──▶ sendRealtimeInput (base64, 16 kHz)
 *     activityStart/End (E lane) ──▶ sendRealtimeInput markers
 *
 *     server messages ──▶ provider_content / provider_usage / lifecycle
 *                       └▶ typed callbacks for the tier-1 harness:
 *                          onInputTranscriptionDelta, onOutputTranscriptionDelta,
 *                          onAudioPcm, onTurnComplete, onInterrupted,
 *                          onToolCall, onResumptionHandle
 *
 * The tier-1 contract wired here (§16.2):
 *   - `responseModalities: ['AUDIO']`, both audio transcriptions on, session
 *     resumption on;
 *   - E lane disables automatic activity detection (the driver's explicit
 *     markers carry the boundary); N lane leaves natural VAD on;
 *   - the two declared functions — `mark_addressed_to_talker()` (suppress a
 *     draft candidate) and `offer_ask_worker()` (create a candidate that
 *     still needs confirmation) — both NON_BLOCKING, acknowledged with SILENT
 *     scheduling so a call never triggers a new model turn;
 *   - contextual state-view updates via `sendClientContent({ turnComplete:
 *     false })`, coalesced ≥ 2 s apart and never mid-speech (deferred while
 *     `setSpeechActive(true)` and flushed on release).
 *
 * Offline by construction: unit tests and dry runs inject a mock
 * `LiveSessionFactory`; the real `@google/genai` factory is only built when
 * a `tier1-run` asks for it with a GEMINI_API_KEY.
 */

import { Behavior, GoogleGenAI, Type } from '@google/genai';

import { EVENT, type EventLog, type MonotonicClock } from '../scheduler.js';
import type { EndpointLane, PcmInputFormat } from '../speech-driver.js';

// ── Wire shapes (structural; the SDK's own types stay behind the factory) ───

export interface LiveConnectConfigShape {
  responseModalities?: string[];
  inputAudioTranscription?: Record<string, never>;
  outputAudioTranscription?: Record<string, never>;
  sessionResumption?: Record<string, unknown>;
  realtimeInputConfig?: {
    automaticActivityDetection?: { disabled?: boolean } | Record<string, never>;
  };
  tools?: Array<{ functionDeclarations?: unknown[] }>;
  systemInstruction?: { parts: Array<{ text: string }> };
}

export interface LiveServerMessageShape {
  setupComplete?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
  serverContent?: {
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        text?: string;
      }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  usageMetadata?: Record<string, unknown>;
  toolCall?: {
    functionCalls?: Array<{ name?: string; args?: Record<string, unknown>; id?: string }>;
  };
}

export type LiveRealtimeInput =
  | { audio: { mimeType: string; data: string } }
  | { activityStart: Record<string, never> }
  | { activityEnd: Record<string, never> };

export interface LiveCallbacks {
  onOpen: () => void;
  onMessage: (msg: LiveServerMessageShape) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

export interface LiveSessionLike {
  sendRealtimeInput(input: LiveRealtimeInput): void;
  sendClientContent(content: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }): void;
  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void;
  close(): void;
}

export interface LiveConnectRequest {
  model: string;
  config: LiveConnectConfigShape;
  callbacks: LiveCallbacks;
}

export type LiveSessionFactory = (request: LiveConnectRequest) => Promise<LiveSessionLike>;

/** The callback surface the tier-1 harness consumes. */
export interface GeminiLiveCallbacks {
  onInputTranscriptionDelta?(text: string, atMs: number): void;
  onOutputTranscriptionDelta?(text: string, atMs: number): void;
  onAudioPcm?(pcm: Buffer, mimeType: string, atMs: number): void;
  onTurnComplete?(atMs: number): void;
  onInterrupted?(atMs: number): void;
  onToolCall?(call: { name: string; args: Record<string, unknown>; id: string }, atMs: number): void;
  onResumptionHandle?(handle: string): void;
  onGoAway?(timeLeft: string): void;
}

// ── The tier-1 declared functions (§16.2) ────────────────────────────────────

export const TIER1_TOOL_NAMES = ['mark_addressed_to_talker', 'offer_ask_worker'] as const;

export type Tier1ToolName = (typeof TIER1_TOOL_NAMES)[number];

/**
 * The two declared functions. NON_BLOCKING behaviour: a call must never block
 * the model's spoken reply. The HARNESS interprets them exactly like the
 * end-anchored text markers they replace — suppression and candidate-creation
 * only, never a release — because a tag inside spoken audio is not detectable
 * and the output transcript is too late to gate on.
 */
export const TIER1_FUNCTION_DECLARATIONS: Array<{
  name: Tier1ToolName;
  description: string;
  parameters: { type: string; properties: Record<string, never>; required: string[] };
  behavior: string;
}> = [
  {
    name: 'mark_addressed_to_talker',
    description:
      'Call this when your reply is addressed to you, the talker itself — a summary, a read-back, a status answer you can give from what you already hold — so the harness does NOT hold the operator\'s words as a pending worker instruction. Never for an instruction to the worker; never for a question you cannot answer. Silence bookkeeping: calling it never speaks.',
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'offer_ask_worker',
    description:
      'Call this when you cannot answer the operator\'s question from what you hold and want to offer asking the worker. The harness holds the operator\'s OWN question as a candidate that still needs their explicit confirmation before anything reaches the worker. Silence bookkeeping: calling it never speaks.',
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
    behavior: Behavior.NON_BLOCKING,
  },
];

/**
 * Function responses are acknowledged with SILENT scheduling: the result
 * joins the model's context without triggering a new model turn (the L1
 * handshake proved async tool results must be carried this way).
 */
export const TIER1_FUNCTION_RESPONSE_SCHEDULING = 'SILENT';

// ── Connect config ───────────────────────────────────────────────────────────

export interface Tier1ConnectConfigOptions {
  lane: EndpointLane;
  systemInstruction: string;
}

/** Assemble the tier-1 live connect config (§16.2 wiring). Pure. */
export function buildTier1ConnectConfig(options: Tier1ConnectConfigOptions): LiveConnectConfigShape {
  return {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    realtimeInputConfig: {
      // E lane: the driver's explicit activity markers carry the boundary.
      // N lane: natural VAD (empty config = provider defaults).
      automaticActivityDetection: options.lane === 'E' ? { disabled: true } : {},
    },
    tools: [{ functionDeclarations: TIER1_FUNCTION_DECLARATIONS }],
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
  };
}

/** The real factory: maps the structural shapes onto @google/genai 1.52.0. */
export function createGenaiLiveSessionFactory(apiKey: string): LiveSessionFactory {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('GEMINI_API_KEY is required to build a real Gemini Live session factory');
  }
  const ai = new GoogleGenAI({ apiKey });
  return async (request: LiveConnectRequest): Promise<LiveSessionLike> => {
    const session = await ai.live.connect({
      model: request.model,
      config: request.config as Parameters<typeof ai.live.connect>[0]['config'],
      callbacks: {
        onopen: () => request.callbacks.onOpen(),
        onmessage: (message: unknown) => request.callbacks.onMessage(message as LiveServerMessageShape),
        onerror: (error: unknown) => request.callbacks.onError(error),
        onclose: (_event: unknown) => request.callbacks.onClose(),
      },
    });
    return {
      sendRealtimeInput: (input) => session.sendRealtimeInput(input as Parameters<typeof session.sendRealtimeInput>[0]),
      sendClientContent: (content) => session.sendClientContent(content),
      sendToolResponse: (response) => session.sendToolResponse(response),
      close: () => session.close(),
    };
  };
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface SchedulerFn {
  (fn: () => void, delayMs: number): () => void;
}

export interface GeminiLiveProviderOptions extends GeminiLiveCallbacks {
  log: EventLog;
  /** Same clock the log was built with. */
  clock: MonotonicClock;
  lane: EndpointLane;
  model: string;
  systemInstruction: string;
  sessionFactory: LiveSessionFactory;
  /** Injectable delay scheduler (coalescing). Default: real setTimeout. */
  scheduler?: SchedulerFn;
  /** State-view coalescing window. Default 2000 ms (§16.2). */
  stateViewCoalesceMs?: number;
  /** Acknowledge tool calls with SILENT-scheduled responses. Default true. */
  ackToolCalls?: boolean;
}

interface PendingAudioPart {
  mimeType: string;
  audioBytes: number;
}

const INPUT_MIME_TYPE = 'audio/pcm;rate=16000';

export class GeminiLiveProvider {
  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly lane: EndpointLane;
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly sessionFactory: LiveSessionFactory;
  private readonly scheduler: SchedulerFn;
  private readonly stateViewCoalesceMs: number;
  private readonly ackToolCalls: boolean;
  private readonly callbacks: GeminiLiveCallbacks;
  private readonly listeners: Array<Partial<GeminiLiveCallbacks>> = [];

  private session: LiveSessionLike | null = null;
  private closed = false;
  private messageSeq = 0;
  private pushedBytes = 0;
  private resumptionHandleValue: string | null = null;
  private goAwayReceivedValue = false;

  // Speech floor: activity markers (E) or first-delta..commit (harness, both lanes).
  private speechActive = false;

  // State-view coalescing state.
  private lastStateViewSentAtMs: number | null = null;
  private pendingStateView: string | null = null;
  private pendingStateViewTimer: (() => void) | null = null;
  private pendingContextNotes: string[] = [];

  constructor(options: GeminiLiveProviderOptions) {
    this.log = options.log;
    this.clock = options.clock;
    this.lane = options.lane;
    this.model = options.model;
    this.systemInstruction = options.systemInstruction;
    this.sessionFactory = options.sessionFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.stateViewCoalesceMs = options.stateViewCoalesceMs ?? 2000;
    this.ackToolCalls = options.ackToolCalls ?? true;
    this.callbacks = options;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Open the live session. Idempotent; refuses after close. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error('cannot connect a closed GeminiLiveProvider');
    if (this.session) return;
    this.session = await this.sessionFactory({
      model: this.model,
      config: buildTier1ConnectConfig({ lane: this.lane, systemInstruction: this.systemInstruction }),
      callbacks: {
        onOpen: () => {
          this.appendLifecycle('connected', { model: this.model, lane: this.lane });
        },
        onMessage: (message) => this.handleMessage(message),
        onError: (error) => {
          this.log.append({
            source: 'provider',
            kind: EVENT.PROVIDER_ERROR,
            id: `provider:socket-error:${this.messageSeq += 1}`,
            payload: { leg: 'socket', message: error instanceof Error ? error.message : String(error) },
          });
        },
        onClose: () => {
          this.appendLifecycle('socketClosed', {});
        },
      },
    });
  }

  close(reason = 'harness-stop'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingStateViewTimer) {
      this.pendingStateViewTimer();
      this.pendingStateViewTimer = null;
    }
    try {
      this.session?.close();
    } catch {
      // A close failure must never mask the attempt's own outcome.
    }
    this.appendLifecycle('close', { reason });
  }

  get connectedSession(): LiveSessionLike | null {
    return this.session;
  }

  /**
   * Subscribe a second consumer to the server-message stream (the tier-1
   * harness attaches itself here; constructor callbacks stay for the direct
   * level-0 use). Listeners are called after the constructor callbacks.
   */
  attachListener(listener: Partial<GeminiLiveCallbacks>): void {
    this.listeners.push(listener);
  }

  private dispatch<K extends keyof GeminiLiveCallbacks>(
    name: K,
    ...args: Parameters<NonNullable<GeminiLiveCallbacks[K]>>
  ): void {
    const callback = this.callbacks[name] as ((...a: unknown[]) => void) | undefined;
    if (typeof callback === 'function') callback(...args);
    for (const listener of this.listeners) {
      const fn = listener[name] as ((...a: unknown[]) => void) | undefined;
      if (typeof fn === 'function') fn(...args);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pushedBytesValue(): number {
    return this.pushedBytes;
  }

  /** Bytes of operator audio pushed to the wire (16-bit mono). */
  get pushedBytes(): number {
    return this.pushedBytes;
  }

  /** Milliseconds of operator audio pushed (16 kHz mono). */
  get pushedMs(): number {
    return (this.pushedBytes / 2 / 16000) * 1000;
  }

  get resumptionHandle(): string | null {
    return this.resumptionHandleValue;
  }

  /** The configured model id (usage/manifest labelling). */
  get modelName(): string {
    return this.model;
  }

  get goAwayReceived(): boolean {
    return this.goAwayReceivedValue;
  }

  // ── ProviderInputSink ──────────────────────────────────────────────────────

  pushAudio(frame: Buffer, _format: PcmInputFormat, _inputSequence: number): void {
    if (this.closed) throw new Error('cannot push audio to a closed GeminiLiveProvider');
    if (!this.session) throw new Error('connect() before pushing audio');
    const data = frame.toString('base64');
    this.pushedBytes += frame.byteLength;
    this.session.sendRealtimeInput({ audio: { mimeType: INPUT_MIME_TYPE, data } });
  }

  /** Explicit activity marker (E lane). N-lane calls are logged, not sent. */
  activityStart(_atMs?: number): void {
    this.setSpeechActive(true);
    if (this.lane !== 'E') return;
    this.session?.sendRealtimeInput({ activityStart: {} });
  }

  /** Explicit activity marker (E lane). N-lane calls are logged, not sent. */
  activityEnd(_atMs?: number): void {
    if (this.lane === 'E') {
      // The marker goes out BEFORE the speech flag drops: the provider must
      // not defer an in-flight context send that is already on the wire path.
      this.session?.sendRealtimeInput({ activityEnd: {} });
    }
    this.setSpeechActive(false);
  }

  /**
   * Lane-uniform speech floor. The harness raises it on the first
   * transcription delta and drops it at commit, so context updates are never
   * injected mid-speech in the N lane either.
   */
  setSpeechActive(active: boolean): void {
    this.speechActive = active;
    if (!active) this.flushDeferredContext();
  }

  // ── Context updates (§16.2) ────────────────────────────────────────────────

  /**
   * Queue a state-view update. Coalesced: at most one send per
   * `stateViewCoalesceMs`, latest text wins; deferred while speech is active
   * and flushed on release.
   */
  updateStateView(stateView: string): void {
    if (this.closed) return;
    this.pendingStateView = stateView;
    if (this.speechActive) return;
    const nowMs = this.clock.nowMs();
    const due = this.lastStateViewSentAtMs === null || nowMs - this.lastStateViewSentAtMs >= this.stateViewCoalesceMs;
    if (due) {
      this.sendStateView(stateView, nowMs);
      return;
    }
    if (this.pendingStateViewTimer) return;
    const lastSentAtMs = this.lastStateViewSentAtMs;
    if (lastSentAtMs === null) return;
    const delay = lastSentAtMs + this.stateViewCoalesceMs - nowMs;
    this.pendingStateViewTimer = this.scheduler(() => {
      this.pendingStateViewTimer = null;
      if (this.closed || this.speechActive || this.pendingStateView === null) return;
      this.sendStateView(this.pendingStateView, this.clock.nowMs());
    }, Math.max(0, delay));
  }

  /**
   * An urgent context note (what the host said on a mechanical turn).
   * Sent immediately unless speech is active, in which case it is flushed on
   * release — the model must not be interrupted mid-utterance, but it must
   * learn what the host said as soon as the floor is free.
   */
  sendContextUpdate(text: string): void {
    if (this.closed) return;
    if (this.speechActive) {
      this.pendingContextNotes.push(text);
      return;
    }
    this.sendClientText(text);
    this.appendLifecycle('contextUpdate', { chars: text.length, urgent: true });
  }

  private flushDeferredContext(): void {
    if (this.closed) return;
    for (const note of this.pendingContextNotes.splice(0)) this.sendClientText(note);
    if (this.pendingContextNotes.length === 0 && this.pendingStateView !== null) {
      this.sendStateView(this.pendingStateView, this.clock.nowMs());
    }
  }

  private sendStateView(stateView: string, nowMs: number): void {
    this.pendingStateView = null;
    this.lastStateViewSentAtMs = nowMs;
    this.sendClientText(stateView);
    this.appendLifecycle('stateView', { chars: stateView.length });
  }

  private sendClientText(text: string): void {
    if (!this.session || this.closed) return;
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: false,
    });
  }

  // ── Server-message dispatch ────────────────────────────────────────────────

  private handleMessage(message: LiveServerMessageShape): void {
    if (this.closed) return;
    if (message.setupComplete !== undefined) {
      this.appendLifecycle('setupComplete', {});
    }
    if (message.sessionResumptionUpdate?.newHandle) {
      this.resumptionHandleValue = message.sessionResumptionUpdate.newHandle;
      this.appendLifecycle('sessionResumptionUpdate', {
        newHandle: message.sessionResumptionUpdate.newHandle,
        resumable: message.sessionResumptionUpdate.resumable ?? false,
      });
      this.dispatch('onResumptionHandle', this.resumptionHandleValue);
    }
    if (message.goAway) {
      this.goAwayReceivedValue = true;
      this.appendLifecycle('goAway', { timeLeft: message.goAway.timeLeft ?? '' });
      this.dispatch('onGoAway', message.goAway.timeLeft ?? '');
    }
    if (message.toolCall?.functionCalls?.length) {
      const calls = message.toolCall.functionCalls;
      const parts: PendingToolCall[] = [];
      for (const call of calls) {
        if (!call.name) continue;
        const named = { name: call.name, args: call.args ?? {}, id: call.id ?? '' };
        parts.push(named);
        this.dispatch('onToolCall', named, this.clock.nowMs());
      }
      if (parts.length > 0) {
        this.log.append({
          source: 'provider',
          kind: EVENT.PROVIDER_CONTENT,
          id: `provider:toolCall:${this.messageSeq += 1}`,
          payload: parts.length === 1 ? { toolCall: parts[0] } : { toolCalls: parts },
        });
        if (this.ackToolCalls) this.acknowledgeToolCalls(parts);
      }
    }
    if (message.serverContent) {
      this.handleServerContent(message.serverContent);
    }
    if (message.usageMetadata) {
      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_USAGE,
        id: `provider:usage:${this.messageSeq += 1}`,
        payload: normaliseUsage(message.usageMetadata),
      });
    }
  }

  private handleServerContent(content: NonNullable<LiveServerMessageShape['serverContent']>): void {
    const atMs = this.clock.nowMs();
    const parts: PendingAudioPart[] = [];
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (!part.inlineData) continue;
        const pcm = Buffer.from(part.inlineData.data ?? '', 'base64');
        if (pcm.byteLength > 0) {
          parts.push({ mimeType: part.inlineData.mimeType ?? 'audio/pcm;rate=24000', audioBytes: pcm.byteLength });
          this.dispatch('onAudioPcm', pcm, part.inlineData.mimeType ?? 'audio/pcm;rate=24000', atMs);
        }
      }
    }
    const inputText = content.inputTranscription?.text;
    const outputText = content.outputTranscription?.text;
    this.log.append({
      source: 'provider',
      kind: EVENT.PROVIDER_CONTENT,
      id: `provider:content:${this.messageSeq += 1}`,
      payload: {
        ...(inputText !== undefined ? { inputTranscription: inputText } : {}),
        ...(outputText !== undefined ? { outputTranscription: outputText } : {}),
        ...(parts.length > 0 ? { parts } : {}),
        turnComplete: content.turnComplete ?? false,
        interrupted: content.interrupted ?? false,
      },
    });
    if (inputText !== undefined && inputText !== '') this.dispatch('onInputTranscriptionDelta', inputText, atMs);
    if (outputText !== undefined && outputText !== '') this.dispatch('onOutputTranscriptionDelta', outputText, atMs);
    if (content.interrupted) this.dispatch('onInterrupted', atMs);
    if (content.turnComplete) this.dispatch('onTurnComplete', atMs);
  }

  private acknowledgeToolCalls(calls: PendingToolCall[]): void {
    if (!this.session || this.closed) return;
    try {
      this.session.sendToolResponse({
        functionResponses: calls.map((call) => ({
          id: call.id,
          name: call.name,
          response: { ok: true },
          scheduling: TIER1_FUNCTION_RESPONSE_SCHEDULING,
        })),
      });
      this.appendLifecycle('toolResponseAck', {
        names: calls.map((c) => c.name),
        scheduling: TIER1_FUNCTION_RESPONSE_SCHEDULING,
      });
    } catch (error) {
      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_ERROR,
        id: `provider:tool-ack-error:${this.messageSeq += 1}`,
        payload: { leg: 'tool-ack', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private appendLifecycle(event: string, payload: Record<string, unknown>): void {
    this.log.append({
      source: 'provider',
      kind: EVENT.LIFECYCLE,
      id: `provider:live:${event}:${this.messageSeq += 1}`,
      payload: { event, ...payload },
    });
  }
}

type PendingToolCall = { name: string; args: Record<string, unknown>; id: string };

function defaultScheduler(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

/** Keep only the metered facts the scorer reports; pass everything through. */
function normaliseUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return { ...usage };
}
