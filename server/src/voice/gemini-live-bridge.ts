/**
 * Gemini Live bridge (Track B, plan Phase 3).
 *
 * The productised form of the reviewed lab adapter
 * (`scripts/voice-live-lab/lib/providers/gemini-live.ts`, read-only reference).
 * One instance owns one provider session for one lane and attachment
 * generation:
 *
 *   operator PCM ──▶ sendAudio ──▶ provider realtime input (base64, 16 kHz)
 *   activity markers ──▶ provider (manual VAD profile)
 *   provider messages ──▶ typed callbacks (audio, transcription, tool calls,
 *                        resumption, goAway, lifecycle)
 *
 * Lifecycle guarantees:
 *   - `setupComplete` is the only thing that moves the lane to `live`;
 *   - the resumption handle is captured in memory and used to reopen the SAME
 *     conversation after `goAway` or an unexpected socket close, bounded by
 *     `reconnect.maxAttempts` (default 1), never after a deliberate close;
 *   - the provider credential is read from the server environment, passed to
 *     `@google/genai` and never stored on the instance, logged, emitted or
 *     serialised;
 *   - the declared functions are the whole typed operation surface: an
 *     undeclared name or any argument payload is surfaced as an error and is
 *     never forwarded, so a tool call can never smuggle bytes to the kernel
 *     (contract §6.2, N1/N8).
 *
 * The provider SDK is only touched by `createGenaiLiveSessionFactory`; every
 * other path runs against the structural `LiveSessionLike`, which is what makes
 * this module testable with a mock socket.
 */

import { Behavior, GoogleGenAI, Type } from '@google/genai';

import {
  hasNoToolArguments,
  type AttachmentGeneration,
  type VoiceBridgeToolName,
  type VoiceErrorCode,
  type VoiceLaneId,
  type VoiceWireState,
} from './contract.js';
import {
  NOOP_VOICE_LOG,
  systemVoiceClock,
  systemVoiceScheduler,
  VOICE_FUNCTION_RESPONSE_SCHEDULING,
  VOICE_PROVIDER_INPUT_FORMAT,
  VOICE_PROVIDER_MODEL,
  type GeminiLiveBridgeCallbacks,
  type GeminiLiveBridgeUsage,
  type GeminiLiveBridgeOptions,
  type LiveCallbacks,
  type LiveConnectConfigShape,
  type LiveConnectRequest,
  type LiveServerMessageShape,
  type LiveSessionFactory,
  type LiveSessionLike,
  type VoiceFunctionResponseScheduling,
} from './types.js';

// ── Config construction ─────────────────────────────────────────────────────

/**
 * The two declared functions. NON_BLOCKING means a call never blocks the model's
 * spoken reply; the harness interprets them exactly as it interpreted the
 * end-anchored text marks they replace — suppression and candidate-creation
 * only, never a release. Both are PARAMETERLESS, and the bridge enforces that
 * at runtime with the contract's `hasNoToolArguments`.
 */
export const VOICE_FUNCTION_DECLARATIONS: Array<{
  name: VoiceBridgeToolName;
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

export interface VoiceConnectConfigOptions {
  /** The driver supplies explicit activity markers (the E-lane profile). */
  manualActivityDetection: boolean;
  systemInstruction: string;
  resumptionHandle?: string | null;
}

/** Assemble the connect config. Pure, so it is trivially unit-testable. */
export function buildVoiceConnectConfig(options: VoiceConnectConfigOptions): LiveConnectConfigShape {
  return {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: options.resumptionHandle ? { handle: options.resumptionHandle } : {},
    realtimeInputConfig: {
      automaticActivityDetection: options.manualActivityDetection ? { disabled: true } : {},
    },
    tools: [{ functionDeclarations: VOICE_FUNCTION_DECLARATIONS }],
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
  };
}

/** The real factory: the only place the provider SDK is touched. */
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
        onclose: () => request.callbacks.onClose(),
      },
    });
    return {
      sendRealtimeInput: (input) =>
        session.sendRealtimeInput(input as Parameters<typeof session.sendRealtimeInput>[0]),
      sendClientContent: (content) => session.sendClientContent(content),
      sendToolResponse: (response) => session.sendToolResponse(response),
      close: () => session.close(),
    };
  };
}

// ── The bridge ──────────────────────────────────────────────────────────────

const DEFAULT_RECONNECT_ATTEMPTS = 1;
const DEFAULT_RECONNECT_DELAY_MS = 200;

function emptyUsage(): GeminiLiveBridgeUsage {
  return {
    messages: 0,
    setupCompletes: 0,
    contextSends: 0,
    audioChunksIn: 0,
    audioBytesIn: 0,
    audioChunksOut: 0,
    audioBytesOut: 0,
    inputTranscriptDeltas: 0,
    outputTranscriptDeltas: 0,
    turnCompletes: 0,
    interruptions: 0,
    toolCalls: 0,
    toolCallViolations: 0,
    resumptionHandles: 0,
    goAways: 0,
    reconnects: 0,
    errors: 0,
    usageMetadataSamples: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a provider failure into the contract's error codes. Quota/rate-limit
 * failures (Google's `RESOURCE_EXHAUSTED`, an HTTP 429, or a quota message) are
 * surfaced as `voice_quota_exhausted` so the operator and the fallback path can
 * tell "we are over the plan" apart from "the socket died" (plan Phase 8:
 * quota exhaustion is a named fallback trigger).
 */
export function classifyProviderFailure(error: unknown): 'voice_quota_exhausted' | 'voice_provider_unavailable' {
  const message = errorMessage(error).toLowerCase();
  return /quota|resource[_-]?exhausted|429|rate[ _-]?limit|too many requests/.test(message)
    ? 'voice_quota_exhausted'
    : 'voice_provider_unavailable';
}

export class GeminiLiveBridge {
  private readonly callbacks: GeminiLiveBridgeCallbacks;
  private readonly clock: () => number;
  private readonly scheduler: NonNullable<GeminiLiveBridgeOptions['scheduler']>;
  private readonly log: NonNullable<GeminiLiveBridgeOptions['log']>;
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly manualActivityDetection: boolean;
  private readonly ackToolCalls: boolean;
  private readonly toolResponseScheduling: VoiceFunctionResponseScheduling;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly apiKeyProvider: () => string | undefined;
  private readonly injectedFactory: LiveSessionFactory | null;
  private readonly laneIdValue: VoiceLaneId;
  private readonly attachmentGenerationValue: AttachmentGeneration;

  private session: LiveSessionLike | null = null;
  private factory: LiveSessionFactory | null = null;
  private stateValue: VoiceWireState = 'idle';
  private resumptionHandleValue: string | null;
  private closing = false;
  private reconnecting = false;
  private resumingSession = false;
  private reconnectAttempts = 0;
  private cancelPendingReconnect: (() => void) | null = null;
  /** Last socket error, so a later fatal give-up can classify quota vs. transport. */
  private lastProviderError: unknown = null;
  private usageValue: GeminiLiveBridgeUsage = emptyUsage();

  constructor(options: GeminiLiveBridgeOptions) {
    this.callbacks = options.callbacks;
    this.clock = options.clock ?? systemVoiceClock;
    this.scheduler = options.scheduler ?? systemVoiceScheduler;
    this.log = options.log ?? NOOP_VOICE_LOG;
    this.model = options.model ?? VOICE_PROVIDER_MODEL;
    this.systemInstruction = options.systemInstruction;
    this.manualActivityDetection = options.manualActivityDetection ?? true;
    this.ackToolCalls = options.ackToolCalls ?? true;
    this.toolResponseScheduling = options.toolResponseScheduling ?? VOICE_FUNCTION_RESPONSE_SCHEDULING;
    this.maxReconnectAttempts = options.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.apiKeyProvider = options.apiKeyProvider ?? (() => process.env.GEMINI_API_KEY);
    this.injectedFactory = options.sessionFactory ?? null;
    this.resumptionHandleValue = options.resumptionHandle ?? null;
    this.laneIdValue = options.laneId;
    this.attachmentGenerationValue = options.attachmentGeneration;
  }

  get laneId(): VoiceLaneId {
    return this.laneIdValue;
  }

  get attachmentGeneration(): AttachmentGeneration {
    return this.attachmentGenerationValue;
  }

  get state(): VoiceWireState {
    return this.stateValue;
  }

  get resumptionHandle(): string | null {
    return this.resumptionHandleValue;
  }

  get isLive(): boolean {
    return this.stateValue === 'live' && this.session !== null && !this.closing;
  }

  get usage(): Readonly<GeminiLiveBridgeUsage> {
    return this.usageValue;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Open the provider session. Idempotent; refuses after close. */
  async connect(): Promise<void> {
    if (this.closing) throw new Error('cannot connect a closed GeminiLiveBridge');
    if (this.session) return;
    try {
      await this.openSession();
    } catch (error) {
      this.emitError(classifyProviderFailure(error), errorMessage(error), true);
      throw error;
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.reconnecting = false;
    this.resumingSession = false;
    if (this.cancelPendingReconnect) {
      this.cancelPendingReconnect();
      this.cancelPendingReconnect = null;
    }
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        session.close();
      } catch {
        // A close failure must never mask the outcome that caused the close.
      }
    }
    this.setState('stopped');
  }

  // ── Operator audio and activity ───────────────────────────────────────────

  /**
   * Send one PCM16 operator frame (already in the provider's declared input
   * format). Returns false when the frame was dropped. NEVER throws and never
   * buffers: a failed write is surfaced, not queued.
   */
  sendAudio(pcm: Buffer): boolean {
    if (!this.isLive || !this.session) return false;
    try {
      this.session.sendRealtimeInput({
        audio: { mimeType: VOICE_PROVIDER_INPUT_FORMAT.mimeType, data: pcm.toString('base64') },
      });
      this.usageValue.audioChunksIn += 1;
      this.usageValue.audioBytesIn += pcm.byteLength;
      return true;
    } catch (error) {
      this.emitError('voice_provider_unavailable', errorMessage(error), false);
      return false;
    }
  }

  /** Explicit activity boundary for the manual-VAD profile. Never throws. */
  activityStart(): void {
    if (this.manualActivityDetection) this.sendMarker('activityStart');
  }

  activityEnd(): void {
    if (this.manualActivityDetection) this.sendMarker('activityEnd');
  }

  private sendMarker(kind: 'activityStart' | 'activityEnd'): void {
    if (!this.isLive || !this.session) return;
    try {
      this.session.sendRealtimeInput(kind === 'activityStart' ? { activityStart: {} } : { activityEnd: {} });
    } catch (error) {
      this.emitError('voice_provider_unavailable', errorMessage(error), false);
    }
  }

  /**
   * Inject host-derived structured context. `turnComplete: false` so it joins
   * the model's context without triggering a turn; coalescing and speech
   * suppression are the service's job, above this line.
   */
  sendContextText(text: string): boolean {
    if (!this.isLive || !this.session) return false;
    try {
      this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false });
      this.usageValue.contextSends += 1;
      return true;
    } catch (error) {
      this.emitError('voice_provider_unavailable', errorMessage(error), false);
      return false;
    }
  }

  // ── Session open / reconnect ──────────────────────────────────────────────

  private resolveFactory(): LiveSessionFactory {
    if (this.injectedFactory) return this.injectedFactory;
    if (this.factory) return this.factory;
    const apiKey = this.apiKeyProvider();
    // The factory closes over the credential; the bridge never stores it.
    this.factory = createGenaiLiveSessionFactory(apiKey ?? '');
    return this.factory;
  }

  private async openSession(): Promise<void> {
    const factory = this.resolveFactory();
    const callbacks: LiveCallbacks = {
      onOpen: () => {
        this.log.debug('voice bridge socket open', { model: this.model });
      },
      onMessage: (message) => this.handleMessage(message),
      onError: (error) => this.handleSocketError(error),
      onClose: () => this.handleSocketClose(),
    };
    const session = await factory({
      model: this.model,
      config: buildVoiceConnectConfig({
        manualActivityDetection: this.manualActivityDetection,
        systemInstruction: this.systemInstruction,
        resumptionHandle: this.resumptionHandleValue,
      }),
      callbacks,
    });
    if (this.closing) {
      try {
        session.close();
      } catch {
        // ignored: the bridge is closing anyway
      }
      return;
    }
    this.session = session;
    this.stateValue = 'connecting';
  }

  private handleSocketError(error: unknown): void {
    if (this.closing) return;
    this.lastProviderError = error;
    this.emitError(classifyProviderFailure(error), errorMessage(error), false);
  }

  private handleSocketClose(): void {
    if (this.closing) {
      // The deliberate close path emits `stopped` exactly once.
      this.stateValue = 'stopped';
      return;
    }
    this.session = null;
    if (this.reconnecting) return;
    this.beginReconnect('socket closed unexpectedly');
  }

  private beginReconnect(reason: string): void {
    if (this.closing || this.reconnecting) return;
    if (!this.resumptionHandleValue) {
      // Without a handle the conversation cannot be resumed; reopening would
      // silently start a different one. Refuse loudly instead (N9).
      const cause = this.lastProviderError ?? reason;
      this.emitError(
        classifyProviderFailure(cause),
        `provider session lost before a resumption handle was issued (${reason}): ${errorMessage(cause)}`,
        true
      );
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const cause = this.lastProviderError ?? reason;
      this.emitError(
        classifyProviderFailure(cause),
        `provider session lost and reconnect attempts are exhausted (${reason}): ${errorMessage(cause)}`,
        true
      );
      return;
    }
    this.reconnecting = true;
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        session.close();
      } catch {
        // ignored: reconnecting replaces the session either way
      }
    }
    this.setState('reconnecting', reason);
    this.cancelPendingReconnect = this.scheduler(() => {
      this.cancelPendingReconnect = null;
      this.reconnecting = false;
      void this.attemptReconnect();
    }, this.reconnectDelayMs);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closing) return;
    this.reconnectAttempts += 1;
    this.usageValue.reconnects += 1;
    this.resumingSession = true;
    try {
      await this.openSession();
      this.log.info('voice bridge reconnected', { attempt: this.reconnectAttempts });
    } catch (error) {
      this.resumingSession = false;
      this.emitError(classifyProviderFailure(error), errorMessage(error), true);
    }
  }

  // ── Server messages ───────────────────────────────────────────────────────

  private handleMessage(message: LiveServerMessageShape): void {
    if (this.closing) return;
    this.usageValue.messages += 1;

    if (message.setupComplete !== undefined) {
      this.usageValue.setupCompletes += 1;
      // The model a live lane is actually running on is a recorded fact at the
      // default log level, not something an operator has to infer from config.
      this.log.info('voice live session ready', { model: this.model });
      const wasReconnect = this.resumingSession;
      this.resumingSession = false;
      this.lastProviderError = null;
      this.stateValue = 'live';
      this.callbacks.onSetupComplete?.();
      this.setState('live');
      if (wasReconnect) this.callbacks.onReconnected?.();
    }

    if (message.sessionResumptionUpdate?.newHandle) {
      this.resumptionHandleValue = message.sessionResumptionUpdate.newHandle;
      this.usageValue.resumptionHandles += 1;
      this.callbacks.onResumptionHandle?.(this.resumptionHandleValue, message.sessionResumptionUpdate.resumable ?? false);
    }

    if (message.goAway) {
      this.usageValue.goAways += 1;
      this.callbacks.onGoAway?.(message.goAway.timeLeft);
      this.beginReconnect('provider goAway');
    }

    if (message.toolCall?.functionCalls?.length) {
      this.handleToolCalls(message.toolCall.functionCalls);
    }

    if (message.serverContent) {
      this.handleServerContent(message.serverContent);
    }

    if (message.usageMetadata) {
      // Recorded as a counter only; provider usage is not a voice event.
      this.usageValue.usageMetadataSamples += 1;
    }
  }

  private handleToolCalls(
    calls: Array<{ name?: string; args?: Record<string, unknown>; id?: string }>
  ): void {
    const accepted: Array<{ name: VoiceBridgeToolName; id: string }> = [];
    const atMs = this.clock();
    for (const call of calls) {
      const name = call.name ?? '';
      const id = call.id ?? '';
      if (!isDeclaredToolName(name)) {
        this.usageValue.toolCallViolations += 1;
        this.emitError('voice_internal_error', `model called an undeclared function (${name})`, false);
        continue;
      }
      const args = call.args ?? {};
      if (!hasNoToolArguments(args)) {
        this.usageValue.toolCallViolations += 1;
        this.emitError('voice_internal_error', `model called ${name} with arguments; the function is parameterless`, false);
        continue;
      }
      this.usageValue.toolCalls += 1;
      accepted.push({ name, id });
      this.callbacks.onToolCall?.({ name, args: {}, id, atMs });
    }
    if (this.ackToolCalls && accepted.length > 0) this.acknowledgeToolCalls(accepted);
  }

  private acknowledgeToolCalls(calls: Array<{ name: VoiceBridgeToolName; id: string }>): void {
    if (!this.session || this.closing) return;
    try {
      this.session.sendToolResponse({
        functionResponses: calls.map((call) => ({
          id: call.id,
          name: call.name,
          response: { ok: true },
          scheduling: this.toolResponseScheduling,
        })),
      });
    } catch (error) {
      this.emitError('voice_internal_error', `failed to acknowledge a tool call: ${errorMessage(error)}`, false);
    }
  }

  private handleServerContent(content: NonNullable<LiveServerMessageShape['serverContent']>): void {
    const atMs = this.clock();
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (!part.inlineData?.data) continue;
        const pcm = Buffer.from(part.inlineData.data, 'base64');
        if (pcm.byteLength === 0) continue;
        this.usageValue.audioChunksOut += 1;
        this.usageValue.audioBytesOut += pcm.byteLength;
        this.callbacks.onAudioPcm?.(pcm, part.inlineData.mimeType ?? 'audio/pcm;rate=24000', atMs);
      }
    }
    const inputText = content.inputTranscription?.text;
    if (inputText !== undefined && inputText !== '') {
      this.usageValue.inputTranscriptDeltas += 1;
      this.callbacks.onInputTranscription?.(inputText, atMs);
    }
    const outputText = content.outputTranscription?.text;
    if (outputText !== undefined && outputText !== '') {
      this.usageValue.outputTranscriptDeltas += 1;
      this.callbacks.onOutputTranscription?.(outputText, atMs);
    }
    if (content.interrupted) {
      this.usageValue.interruptions += 1;
      this.callbacks.onInterrupted?.(atMs);
    }
    if (content.turnComplete) {
      this.usageValue.turnCompletes += 1;
      this.callbacks.onTurnComplete?.(atMs);
    }
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private setState(state: VoiceWireState, detail?: string): void {
    this.stateValue = state;
    this.callbacks.onState?.(state, detail);
  }

  private emitError(code: VoiceErrorCode, message: string, fatal: boolean): void {
    this.usageValue.errors += 1;
    this.callbacks.onError?.({ code, message, fatal });
    if (fatal) this.setState('error', message);
  }
}

function isDeclaredToolName(name: string): name is VoiceBridgeToolName {
  return VOICE_FUNCTION_DECLARATIONS.some((declaration) => declaration.name === name);
}
