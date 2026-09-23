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

import { GoogleGenAI } from '@google/genai';
import { validateToolArguments } from './tool-arguments.js';

import {
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
  VOICE_PROVIDER_INPUT_FORMAT,
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
import {
  assertProfileSupports,
  buildVoiceConnectConfigForProfile,
  profileFor,
  redactConnectConfig,
  resolveVoiceLiveProfileId,
  type VoiceLiveIdentityRecord,
  type VoiceLiveProfile,
} from './voice-profiles.js';
import { VOICE_FUNCTION_DECLARATIONS } from './voice-tools.js';

// ── Config construction ─────────────────────────────────────────────────────

// The declared functions moved to the leaf module `voice-tools.ts` (shared
// with the profile adapter); re-exported here for source compatibility.
export { VOICE_FUNCTION_DECLARATIONS } from './voice-tools.js';

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
    thoughtTokens: 0,
    totalTokens: 0,
    toolCallDuplicates: 0,
    lateToolCalls: 0,
    unmatchedActivityEndsSuppressed: 0,
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
  /** The resolved profile for this session's arm (plan §7). */
  private readonly profileValue: VoiceLiveProfile;
  private readonly profileSource: 'env' | 'explicit';
  /** Scheduling sent on tool responses; null when the arm does not support it. */
  private readonly toolResponseSchedulingValue: VoiceFunctionResponseScheduling | null;
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
  private cancelPendingReconnect: (() => void) | null =  null;
  /** Last socket error, so a later fatal give-up can classify quota vs. transport. */
  private lastProviderError: unknown = null;
  private usageValue: GeminiLiveBridgeUsage = emptyUsage();

  // ── Provider-profile boundary state ────────────────────────────────────

  /** The requested-vs-actual identity record, captured as facts arrive. */
  private readonly identityValue: VoiceLiveIdentityRecord;
  /** A turn boundary was observed since operator speech last (re)opened a turn. */
  private turnCompleteSinceSpeech = false;
  /** Late tool work arrived after the last turn boundary (ET drain semantics). */
  private toolWorkPendingSinceTurnComplete = false;
  /** Recently dispatched tool-call ids, FIFO-bounded, for duplicate refusal. */
  private readonly recentToolCallIds = new Set<string>();
  private recentToolCallIdOrder: string[] = [];

  constructor(options: GeminiLiveBridgeOptions) {
    this.callbacks = options.callbacks;
    this.clock = options.clock ?? systemVoiceClock;
    this.scheduler = options.scheduler ?? systemVoiceScheduler;
    this.log = options.log ?? NOOP_VOICE_LOG;
    this.profileSource = options.profile ? 'explicit' : 'env';
    this.profileValue = profileFor(options.profile ?? resolveVoiceLiveProfileId());
    const profileModel = this.profileValue.model;
    if (options.model !== undefined && options.model !== profileModel) {
      throw new Error(
        `model ${options.model} contradicts the ${this.profileValue.id} profile seat ${profileModel}; refusing to mix identities`
      );
    }
    this.model = options.model ?? profileModel;
    this.systemInstruction = options.systemInstruction;
    this.manualActivityDetection = options.manualActivityDetection ?? true;
    this.ackToolCalls = options.ackToolCalls ?? true;
    const profileScheduling = this.profileValue.toolReplyScheduling;
    this.toolResponseSchedulingValue = profileScheduling.supported ? profileScheduling.value : null;
    if (
      options.toolResponseScheduling !== undefined &&
      options.toolResponseScheduling !== this.toolResponseSchedulingValue
    ) {
      assertProfileSupports(this.profileValue, 'toolReplyScheduling');
      throw new Error(
        `toolResponseScheduling ${options.toolResponseScheduling} contradicts the ${this.profileValue.id} profile; the profile owns the tool-reply shape`
      );
    }
    this.maxReconnectAttempts = options.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.apiKeyProvider = options.apiKeyProvider ?? (() => process.env.GEMINI_API_KEY);
    this.injectedFactory = options.sessionFactory ?? null;
    this.resumptionHandleValue = options.resumptionHandle ?? null;
    this.laneIdValue = options.laneId;
    this.attachmentGenerationValue = options.attachmentGeneration;
    this.identityValue = {
      requested: {
        profile: this.profileValue.id,
        source: this.profileSource,
        model: this.model,
        connectConfig: null,
      },
      acknowledged: {
        setupComplete: false,
        setupAtMs: null,
        usageMetadataSamples: 0,
        thoughtTokenCountTotal: 0,
        totalTokenCountTotal: 0,
      },
    };
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

  /** The resolved provider-profile arm (plan §7). */
  get profile(): VoiceLiveProfile {
    return this.profileValue;
  }

  /**
   * The requested-vs-actual identity record: what this bridge asked for
   * (redacted) and what the provider confirmed (setup completion + usage
   * evidence). Never fed from the model's own spoken words.
   */
  get identity(): VoiceLiveIdentityRecord {
    return this.identityValue;
  }

  /**
   * Whether the interaction may be treated as settled (idle) for this arm.
   *
   * Standard: a provider turn boundary settles the turn.
   * Extended Thinking HIGH: the boundary alone is NOT enough — late tool work
   * must be drained and a fresh turn boundary observed, so a premature idle
   * can never retire pending work or stop listening. Operator speech re-opens
   * the turn on both arms.
   */
  get interactionSettled(): boolean {
    if (!this.turnCompleteSinceSpeech) return false;
    if (this.profileValue.idle.settled === 'toolCallsDrained') {
      return !this.toolWorkPendingSinceTurnComplete;
    }
    return true;
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

  /** Whether an activityStart was DELIVERED to this provider session and not
   *  yet closed. A speech span that crosses a same-lane restart otherwise
   *  delivers an `activityEnd` into a session that never saw the matching
   *  `activityStart` (markers are dropped while the session is still
   *  connecting), and a provider that receives an unmatched end never
   *  completes a turn again — it keeps transcribing but the model never
   *  answers and never calls `relay_to_worker`
   *  (SOAK-10MIN-standard/attempt-04). The host owns the marker pair, so the
   *  unmatched end is suppressed rather than delivered. */
  private activityOpen = false;

  /** Explicit activity boundary for the manual-VAD profile. Never throws. */
  activityStart(): void {
    // The operator is speaking again: the previous turn boundary no longer
    // describes the interaction on either arm.
    this.turnCompleteSinceSpeech = false;
    this.toolWorkPendingSinceTurnComplete = false;
    if (!this.manualActivityDetection) return;
    // Open only when the marker actually reached the provider: a start dropped
    // while connecting leaves the span closed, so the matching end is
    // suppressed too and the next spoken span opens clean.
    this.activityOpen = this.sendMarker('activityStart');
  }

  activityEnd(): void {
    if (!this.manualActivityDetection) return;
    if (!this.activityOpen) {
      this.usageValue.unmatchedActivityEndsSuppressed += 1;
      return;
    }
    this.activityOpen = false;
    this.sendMarker('activityEnd');
  }

  private sendMarker(kind: 'activityStart' | 'activityEnd'): boolean {
    if (!this.isLive || !this.session) return false;
    try {
      this.session.sendRealtimeInput(kind === 'activityStart' ? { activityStart: {} } : { activityEnd: {} });
      return true;
    } catch (error) {
      this.emitError('voice_provider_unavailable', errorMessage(error), false);
      return false;
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

  /**
   * Assemble the connect config through the profile adapter and capture the
   * REDACTED request as the requested half of the identity record.
   */
  private buildConnectConfig(): LiveConnectConfigShape {
    if (this.profileValue.thinking.supported) {
      assertProfileSupports(this.profileValue, 'thinkingConfig');
    }
    const config = buildVoiceConnectConfigForProfile(this.profileValue, {
      manualActivityDetection: this.manualActivityDetection,
      systemInstruction: this.systemInstruction,
      resumptionHandle: this.resumptionHandleValue,
    });
    this.identityValue.requested.connectConfig = redactConnectConfig(config);
    return config;
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
      config: this.buildConnectConfig(),
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
      // Provider acknowledgement: setup completed for THIS requested identity.
      if (!this.identityValue.acknowledged.setupComplete) {
        this.identityValue.acknowledged.setupComplete = true;
        this.identityValue.acknowledged.setupAtMs = this.clock();
      }
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
      void this.handleToolCalls(message.toolCall.functionCalls);
    }

    if (message.serverContent) {
      this.handleServerContent(message.serverContent);
    }

    if (message.usageMetadata) {
      // Recorded as counters and identity evidence only; provider usage is
      // not a voice event. Thought tokens are the ET arm's actual-effort ack.
      this.usageValue.usageMetadataSamples += 1;
      this.identityValue.acknowledged.usageMetadataSamples += 1;
      const thoughts = message.usageMetadata['thoughtsTokenCount'];
      if (typeof thoughts === 'number' && Number.isFinite(thoughts) && thoughts > 0) {
        this.usageValue.thoughtTokens += Math.round(thoughts);
        this.identityValue.acknowledged.thoughtTokenCountTotal += Math.round(thoughts);
      }
      const total = message.usageMetadata['totalTokenCount'];
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
        this.usageValue.totalTokens += Math.round(total);
        this.identityValue.acknowledged.totalTokenCountTotal += Math.round(total);
      }
    }
  }

  private async handleToolCalls(
    calls: Array<{ name?: string; args?: Record<string, unknown>; id?: string }>
  ): Promise<void> {
    const accepted: Array<{ name: VoiceBridgeToolName; id: string; args: Record<string, unknown> }> = [];
    const duplicates: Array<{ name: VoiceBridgeToolName; id: string }> = [];
    const atMs = this.clock();
    for (const call of calls) {
      const name = call.name ?? '';
      const id = call.id ?? '';
      if (!isDeclaredToolName(name)) {
        this.usageValue.toolCallViolations += 1;
        this.emitError('voice_internal_error', `model called an undeclared function (${name})`, false);
        continue;
      }
      // Argument rules are PER TOOL (see the event's own doc): the gate tools are
      // parameterless, and the retrieval tool takes exactly one bounded string
      // that can only select which history is read back.
      const validated = validateToolArguments(name, call.args ?? {});
      if (!validated.ok) {
        this.usageValue.toolCallViolations += 1;
        this.emitError('voice_internal_error', `model called ${name} with ${validated.reason}`, false);
        continue;
      }
      // A repeated call id is NEVER re-executed: the host handler runs exactly
      // once per id (a live provider can replay a call, e.g. after a
      // reconnect). The duplicate is still acknowledged and counted.
      if (this.recentToolCallIds.has(id)) {
        this.usageValue.toolCallDuplicates += 1;
        duplicates.push({ name, id });
        continue;
      }
      this.rememberToolCallId(id);
      // A call arriving after the turn boundary is late asynchronous work:
      // both arms handle it identically (dispatch + acknowledge); on the ET
      // arm it also re-opens the idle drain.
      if (this.turnCompleteSinceSpeech) {
        this.toolWorkPendingSinceTurnComplete = true;
        this.usageValue.lateToolCalls += 1;
      }
      this.usageValue.toolCalls += 1;
      accepted.push({ name, id, args: validated.args });
    }
    if (duplicates.length > 0) {
      this.acknowledgeToolCalls(duplicates, []);
    }
    if (accepted.length === 0) return;

    // The handler is called EXACTLY ONCE per accepted call, and its return value
    // (if any) becomes the tool's response. A retrieval result therefore reaches
    // the model in the same turn; the gate tools return nothing and keep the
    // established `{ok:true}` acknowledgement.
    let payloads: Array<Record<string, unknown> | void> = [];
    try {
      payloads = await Promise.all(
        accepted.map((call) => this.callbacks.onToolCall?.({ name: call.name, args: call.args, id: call.id, atMs }))
      );
    } catch (error) {
      this.emitError('voice_internal_error', `a tool handler failed: ${errorMessage(error)}`, false);
    }
    if (this.ackToolCalls) this.acknowledgeToolCalls(accepted, payloads);
  }

  /** Bounded FIFO memory of dispatched call ids (duplicate refusal). */
  private rememberToolCallId(id: string): void {
    if (id === '') return;
    if (!this.recentToolCallIds.has(id)) {
      this.recentToolCallIds.add(id);
      this.recentToolCallIdOrder.push(id);
    }
    while (this.recentToolCallIdOrder.length > 256) {
      const evicted = this.recentToolCallIdOrder.shift();
      if (evicted !== undefined) this.recentToolCallIds.delete(evicted);
    }
  }

  private acknowledgeToolCalls(
    calls: Array<{ name: VoiceBridgeToolName; id: string }>,
    payloads: Array<Record<string, unknown> | void> = []
  ): void {
    if (!this.session || this.closing) return;
    try {
      this.session.sendToolResponse({
        functionResponses: calls.map((call, index) => {
          // The reply shape is the PROFILE's: arms without scheduling support
          // never carry the field (it is omitted, never cast away silently).
          const response: Record<string, unknown> = {
            id: call.id,
            name: call.name,
            response: payloads[index] ?? { ok: true },
          };
          if (this.toolResponseSchedulingValue !== null) {
            response.scheduling = this.toolResponseSchedulingValue;
          }
          return response;
        }),
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
      // The provider's turn boundary: late tool work observed BEFORE it is now
      // drained; the ET arm's settled predicate re-arms from here.
      this.turnCompleteSinceSpeech = true;
      this.toolWorkPendingSinceTurnComplete = false;
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
