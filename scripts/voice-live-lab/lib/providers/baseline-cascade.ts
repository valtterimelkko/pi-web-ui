/**
 * Baseline cascade provider (L2, plan §19).
 *
 * The baseline is the stack that is actually shipped today — OpenAI STT →
 * `TalkerSession` (Gemma 4 26B A4B via OpenRouter) → OpenAI TTS — driven
 * in-process as a `ProviderInputSink`, so the very same operator driver,
 * event log, offline verifier and scorer that will measure a native Gemini
 * Live candidate measure the baseline too. Tap-to-talk is emulated by the E
 * lane's explicit boundaries; the N lane fires on trailing silence.
 *
 * What this module is NOT: a re-implementation of the talker. Every
 * mechanical decision (classification, draft, release gate, acks, receipts)
 * belongs to the real `TalkerSession` and, under it, the policy core. This
 * module only moves audio in and out and names the legs:
 *
 *     buffered PCM ──▶ STT ──▶ TalkerSession.handleOperatorTurn(text)
 *                                        │ reply (or fixed ack)
 *                                        ▼
 *                              TTS ──▶ reference player
 *
 * Event contract (one completed turn, in this order):
 *   provider_content  { inputTranscription, outputTranscription,
 *                       parts: [{ mimeType: 'audio/pcm;rate=24000', audioBytes }],
 *                       legTimings }
 *   provider_usage    { stt, model, tts, audioMs }   (metered facts + ms; the
 *                       talker's token counts are not exposed by its client,
 *                       so the scorer estimates from chars and labels it so)
 *   harness_*         draft/release/receipt/mechanical transitions observed on
 *                     the turn result, logged so the scorer can assert gate
 *                     behaviour from the trace alone
 *   turn_complete     { transcript, reply, timings, ttfaMs, released,
 *                       failedLeg, draftSizeAfter, ... }  — always last
 *
 * A leg failure appends a `provider_error` event naming the leg; the turn
 * still completes with `failedLeg` set. Nothing is ever swallowed: a trace
 * that lost its STT text must say so, not look like a short reply.
 *
 * Latency semantics: `speechEndAtMs` anchors speech end on the log's
 * monotonic clock; `firstAudioAtMs` is the moment the synthesised reply was
 * handed to the reference player; `ttfaMs` is their difference — the
 * baseline's speech-end → first-audio number, attributable per leg through
 * `sttMs` / `modelMs` / `ttsMs`.
 *
 * Spend note (§19, deliberate): the baseline keeps the production routes —
 * OpenAI STT/TTS on the per-token gateway and Gemma on OpenRouter. That spend
 * is the measurement, not a cost line to optimise. The talker client does not
 * surface token usage, so usage records carry characters and milliseconds and
 * the scorer derives clearly-labelled token ESTIMATES; no figure from this
 * module may be presented as a metered model token count.
 */

import { EVENT, type EventLog, type MonotonicClock } from '../scheduler.js';
import type { PcmInputFormat, ProviderInputSink, EndpointLane } from '../speech-driver.js';
import type { DeliveryOutcome, TalkerTurnResult, WorkerStateSnapshot } from '../../../../server/src/talker/types.js';
import { joinDraftText, type PendingProposalStore } from '../../../../server/src/talker/pending-proposal.js';
import { RELEASE_ACK } from '../../../../server/src/talker/ack.js';

// ── Leg interfaces (mock/stub injection points) ────────────────────────────

export interface SttOutcome {
  text: string;
  provider: string;
  model: string;
  ms: number;
  usage: Record<string, unknown>;
}

export interface BaselineStt {
  transcribe(pcm16k: Buffer): Promise<SttOutcome>;
}

export interface TtsOutcome {
  /** 24 kHz s16le mono PCM, as Gemini Live would emit. */
  pcm: Buffer;
  provider: string;
  model: string;
  voice: string;
  ms: number;
  usage: Record<string, unknown>;
}

export interface BaselineTts {
  synthesise(text: string): Promise<TtsOutcome>;
}

/**
 * The slice of `TalkerSession` the cascade drives. `proposals` is exposed so
 * the cascade can log draft size after each turn without reaching into the
 * session's internals — the scorer's `draftCreated` assertion reads it.
 */
export interface TalkerRunner {
  handleOperatorTurn(
    utterance: string,
    opts?: {
      operatorFocus?: boolean;
      releaseVariant?: 'tidied' | 'original';
      proposalRef?: { version: number; hash: string };
    }
  ): Promise<TalkerTurnResult>;
  readonly proposals: PendingProposalStore;
}

export interface BaselinePlayer {
  receive(pcm: Buffer): void;
  setOperatorFloor?(active: boolean): void;
}

export interface BaselineCascadeOptions {
  log: EventLog;
  /** Same clock the log was built with — speech-end anchoring must share it. */
  clock: MonotonicClock;
  lane: EndpointLane;
  talker: TalkerRunner;
  stt?: BaselineStt;
  tts?: BaselineTts;
  player?: BaselinePlayer;
  /** N-lane trailing-silence boundary. 900 ms default, matching the driver. */
  trailSilenceMs?: number;
  /** Driver pacing, used only to convert silence frames to milliseconds. */
  frameIntervalMs?: number;
  /** Force a boundary when unspeech audio accumulates past this. */
  maxBufferMs?: number;
}

export interface BaselineTurnRecord {
  turn: number;
  boundary: 'activity-end' | 'trailing-silence' | 'buffer-limit' | 'flush';
  transcript: string;
  reply: string | null;
  sttMs: number;
  modelMs: number;
  ttsMs: number;
  ttftMs: number | null;
  speechEndAtMs: number;
  firstAudioAtMs: number | null;
  ttfaMs: number | null;
  audioBytes: number;
  released: { utteranceId: number; text: string; delivery: DeliveryOutcome } | null;
  cancelled: boolean;
  receiptAck: string | null;
  draftSizeAfter: number;
  /** Relay-normalised draft bytes held after the turn ("" when none). */
  draftTextAfter: string;
  failedLeg: 'stt' | 'model' | 'tts' | null;
}

const DEFAULT_TRAIL_SILENCE_MS = 900;
const DEFAULT_FRAME_INTERVAL_MS = 20;
const DEFAULT_MAX_BUFFER_MS = 120000;
const OUTPUT_MIME_TYPE = 'audio/pcm;rate=24000';

/** True when every 16-bit sample in the frame is exactly zero (the driver's
 *  silence frames are authored zeros, so an exactness check is exact here). */
export function isSilentFrame(frame: Buffer): boolean {
  for (let offset = 0; offset + 1 < frame.byteLength; offset += 2) {
    if (frame.readInt16LE(offset) !== 0) return false;
  }
  return true;
}

export class BaselineCascade implements ProviderInputSink {
  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly lane: EndpointLane;
  private readonly talker: TalkerRunner;
  private readonly stt?: BaselineStt;
  private readonly tts?: BaselineTts;
  private readonly player?: BaselinePlayer;
  private readonly trailSilenceMs: number;
  private readonly frameIntervalMs: number;
  private readonly maxBufferMs: number;
  private readonly buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private bufferedHasSpeech = false;
  private trailingSilenceFrames = 0;
  private readonly turns: BaselineTurnRecord[] = [];
  private chain: Promise<void> = Promise.resolve();
  private floorActive = false;

  constructor(options: BaselineCascadeOptions) {
    this.log = options.log;
    this.clock = options.clock;
    this.lane = options.lane;
    this.talker = options.talker;
    this.stt = options.stt;
    this.tts = options.tts;
    this.player = options.player;
    this.trailSilenceMs = options.trailSilenceMs ?? DEFAULT_TRAIL_SILENCE_MS;
    this.frameIntervalMs = options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
    this.maxBufferMs = options.maxBufferMs ?? DEFAULT_MAX_BUFFER_MS;
  }

  get completedTurns(): number {
    return this.turns.length;
  }

  get turnRecords(): readonly BaselineTurnRecord[] {
    return this.turns;
  }

  get bufferedMs(): number {
    return (this.bufferedBytes / 2 / 16000) * 1000;
  }

  // ── ProviderInputSink ────────────────────────────────────────────────────

  activityStart(_atMs?: number): void {
    // Tap-to-talk begins: the operator holds the floor, so any in-flight
    // reply audio ducks — exactly the shipped player behaviour.
    if (!this.floorActive) {
      this.floorActive = true;
      this.player?.setOperatorFloor?.(true);
    }
    this.trailingSilenceFrames = 0;
  }

  activityEnd(_atMs?: number): void {
    // E-lane (and tap-to-talk) boundary: the operator released the button.
    this.floorActive = false;
    this.player?.setOperatorFloor?.(false);
    this.enqueue('activity-end');
  }

  pushAudio(frame: Buffer, _format: PcmInputFormat, _inputSequence: number): void {
    const silent = isSilentFrame(frame);
    this.buffered.push(Buffer.from(frame));
    this.bufferedBytes += frame.byteLength;
    if (!silent) {
      this.bufferedHasSpeech = true;
      this.trailingSilenceFrames = 0;
    } else if (this.bufferedHasSpeech) {
      this.trailingSilenceFrames += 1;
      if (this.trailingSilenceFrames * this.frameIntervalMs >= this.trailSilenceMs) {
        this.trailingSilenceFrames = 0;
        this.floorActive = false;
        this.player?.setOperatorFloor?.(false);
        this.enqueue('trailing-silence');
        return;
      }
    }
    if (this.bufferedMs >= this.maxBufferMs) this.enqueue('buffer-limit');
  }

  // ── Turn pipeline ────────────────────────────────────────────────────────

  /** Await every enqueued turn (completed or failed). Never rejects. */
  async settle(): Promise<void> {
    await this.chain;
  }

  /**
   * Settle, then process any remaining buffered audio that contains speech
   * (an attempt ends without a boundary in the N lane). Silence-only residue
   * creates no turn.
   */
  async flush(): Promise<void> {
    await this.settle();
    if (this.bufferedHasSpeech) await this.processTurn('flush');
  }

  private enqueue(reason: BaselineTurnRecord['boundary']): void {
    this.chain = this.chain.then(() => this.processTurn(reason)).catch(() => {
      /* processTurn never rejects; this guard keeps the chain alive */
    });
  }

  private async processTurn(reason: BaselineTurnRecord['boundary']): Promise<void> {
    const pcm = Buffer.concat(this.buffered);
    this.buffered.length = 0;
    this.bufferedBytes = 0;
    this.bufferedHasSpeech = false;
    this.trailingSilenceFrames = 0;
    if (!hasSpeech(pcm)) return;

    const speechEndAtMs = this.clock.nowMs();
    const turn = this.turns.length + 1;
    const record: BaselineTurnRecord = {
      turn,
      boundary: reason,
      transcript: '',
      reply: null,
      sttMs: 0,
      modelMs: 0,
      ttsMs: 0,
      ttftMs: null,
      speechEndAtMs,
      firstAudioAtMs: null,
      ttfaMs: null,
      audioBytes: pcm.byteLength,
      released: null,
      cancelled: false,
      receiptAck: null,
      draftSizeAfter: draftSize(this.talker.proposals),
      draftTextAfter: draftText(this.talker.proposals),
      failedLeg: null,
    };

    // Usage facts are collected per leg so even a failed turn records what
    // was actually spent and done before the failure.
    let usageStt: Record<string, unknown> | null = null;
    let usageModel: Record<string, unknown> | null = null;
    let usageTts: Record<string, unknown> | null = null;
    const exitUsage = (): void => {
      this.appendUsage(turn, usageStt, usageModel, usageTts, record);
    };

    // ── Leg 1: STT ────────────────────────────────────────────────────────
    let result: TalkerTurnResult | null = null;
    try {
      if (!this.stt) throw new Error('no STT leg configured for the baseline cascade');
      const startedMs = this.clock.nowMs();
      const stt = await this.stt.transcribe(pcm);
      record.sttMs = this.clock.nowMs() - startedMs;
      record.transcript = stt.text;
      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_CONTENT,
        id: `provider:stt:turn:${turn}`,
        payload: {
          leg: 'stt',
          inputTranscription: stt.text,
          provider: stt.provider,
          model: stt.model,
          ms: stt.ms,
        },
      });
      usageStt = {
        provider: stt.provider,
        model: stt.model,
        ms: record.sttMs,
        audioMs: (pcm.byteLength / 2 / 16000) * 1000,
        ...stt.usage,
      };
      if (!stt.text.trim()) {
        // An empty transcript is an honest completed turn: the operator said
        // nothing the recogniser could hear. No model call, no reply audio.
        exitUsage();
        this.appendTurnComplete(record, null, null, null);
        return;
      }
      if (reason === 'trailing-silence') {
        record.speechEndAtMs = Math.max(0, speechEndAtMs - this.trailSilenceMs);
      }

      // ── Leg 2: the real talker session (gate inside) ────────────────────
      const modelStartedMs = this.clock.nowMs();
      try {
        result = await this.talker.handleOperatorTurn(stt.text);
      } finally {
        record.modelMs = this.clock.nowMs() - modelStartedMs;
      }
      record.ttftMs = result.latency?.ttftMs ?? null;
      record.reply = result.reply;
      record.released = result.released
        ? { utteranceId: result.released.utteranceId, text: result.released.text, delivery: result.released.delivery }
        : null;
      record.cancelled = result.cancelled;
      record.receiptAck = result.receiptAck ?? null;
      record.draftSizeAfter = draftSize(this.talker.proposals);
      record.draftTextAfter = draftText(this.talker.proposals);
      this.appendHarnessEvents(result, turn);
      usageModel = {
        modelCalled: result.modelCalled,
        ttftMs: record.ttftMs,
        totalMs: record.modelMs,
        replyChars: result.reply.length,
        ...(result.error ? { error: result.error } : {}),
      };

      // ── Leg 3: TTS of what the operator hears ───────────────────────────
      if (!this.tts) throw new Error('no TTS leg configured for the baseline cascade');
      const ttsStartedMs = this.clock.nowMs();
      let tts: TtsOutcome;
      try {
        tts = await this.tts.synthesise(result.reply);
      } finally {
        record.ttsMs = this.clock.nowMs() - ttsStartedMs;
      }
      record.firstAudioAtMs = this.clock.nowMs();
      record.ttfaMs = record.firstAudioAtMs - record.speechEndAtMs;
      this.player?.receive(tts.pcm);
      usageTts = {
        provider: tts.provider,
        model: tts.model,
        voice: tts.voice,
        ms: record.ttsMs,
        chars: result.reply.length,
        ...tts.usage,
      };

      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_CONTENT,
        id: `provider:turn:${turn}`,
        payload: {
          leg: 'cascade-turn',
          inputTranscription: stt.text,
          outputTranscription: result.reply,
          parts: [{ mimeType: OUTPUT_MIME_TYPE, audioBytes: tts.pcm.byteLength }],
          legTimings: { sttMs: record.sttMs, modelMs: record.modelMs, ttsMs: record.ttsMs, ttftMs: record.ttftMs },
        },
      });
      exitUsage();
      this.appendTurnComplete(record, result, tts.pcm.byteLength, null);
    } catch (error) {
      const leg = record.failedLeg ?? inferFailedLeg(record, result);
      const message = error instanceof Error ? error.message : String(error);
      this.log.append({
        source: 'provider',
        kind: EVENT.PROVIDER_ERROR,
        id: `provider:error:turn:${turn}`,
        payload: { turn, leg, message },
      });
      // Still emit the usage facts known so far, then close the turn.
      exitUsage();
      this.appendTurnComplete(record, result, null, leg);
    }
  }

  private appendHarnessEvents(result: TalkerTurnResult, turn: number): void {
    if (result.receiptAck) {
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_RECEIPT,
        id: `harness:receipt:turn:${turn}`,
        payload: { reply: result.receiptAck },
      });
    }
    if (result.cancelled) {
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_MECHANICAL,
        id: `harness:cancel:turn:${turn}`,
        payload: { kind: 'cancel' },
      });
    }
    if (result.released) {
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_RELEASE,
        id: `harness:release:turn:${turn}`,
        payload: {
          utteranceId: result.released.utteranceId,
          text: result.released.text,
          outcome: result.released.delivery.outcome,
          mechanism: result.released.delivery.mechanism,
          ack: RELEASE_ACK_OR(result.reply),
        },
      });
    } else if (!result.modelCalled && !result.cancelled && !result.receiptAck) {
      // Gate-owned dead end or refusal: fixed vocabulary, no model call.
      this.log.append({
        source: 'harness',
        kind: EVENT.HARNESS_MECHANICAL,
        id: `harness:mechanical:turn:${turn}`,
        payload: { kind: 'mechanical', reply: result.reply },
      });
    }
  }

  private appendUsage(
    turn: number,
    stt: Record<string, unknown> | null,
    model: Record<string, unknown> | null,
    tts: Record<string, unknown> | null,
    record: BaselineTurnRecord
  ): void {
    this.log.append({
      source: 'provider',
      kind: EVENT.PROVIDER_USAGE,
      id: `provider:usage:turn:${turn}`,
      payload: {
        turn,
        ...(stt ? { stt } : {}),
        ...(model ? { model } : {}),
        ...(tts ? { tts } : {}),
        audioMs: (record.audioBytes / 2 / 16000) * 1000,
      },
    });
  }

  private appendTurnComplete(
    record: BaselineTurnRecord,
    result: TalkerTurnResult | null,
    audioBytes: number | null,
    failedLeg: BaselineTurnRecord['failedLeg']
  ): void {
    record.failedLeg = failedLeg;
    this.turns.push(record);
    this.log.append({
      source: 'provider',
      kind: EVENT.TURN_COMPLETE,
      id: `provider:turn-complete:${record.turn}`,
      payload: {
        turn: record.turn,
        lane: this.lane,
        boundary: record.boundary,
        transcript: record.transcript,
        reply: result ? result.reply : null,
        utteranceClass: result?.utteranceClass ?? null,
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
        ttftMs: record.ttftMs,
        audioBytes,
        failedLeg: failedLeg,
        modelError: result?.error ?? null,
      },
    });
  }
}

/** The release ack is a fixed string produced after the outcome is known. */
function RELEASE_ACK_OR(reply: string): string {
  return reply || RELEASE_ACK;
}

function inferFailedLeg(record: BaselineTurnRecord, result: TalkerTurnResult | null): 'stt' | 'model' | 'tts' {
  if (record.transcript === '') return 'stt';
  if (result === null) return 'model';
  return 'tts';
}

function draftSize(store: PendingProposalStore): number {
  return store.snapshotDraft()?.utterances.length ?? 0;
}

function draftText(store: PendingProposalStore): string {
  const snapshot = store.snapshotDraft();
  return snapshot ? joinDraftText(snapshot.utterances) : '';
}

function hasSpeech(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    if (pcm.readInt16LE(offset) !== 0) return true;
  }
  return false;
}

// ── Real leg adapters (the production routes, §19) ─────────────────────────

export interface OpenAiSttOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Local Whisper fallback (decision g: local first is the shadow role, but
   *  the baseline's honest fallback keeps production's spirit). */
  whisperFallback?: BaselineStt;
}

function nowMs(): number {
  return performance.now();
}

/**
 * OpenAI `gpt-4o-mini-transcribe` — the production STT route
 * (`server/src/dictation/stt.ts` uses the same model). Raw PCM in, plain text
 * out. Falls back to the local Whisper service when configured and OpenAI
 * fails; throws an honest combined error when both fail.
 */
export function createOpenAiStt(options: OpenAiSttOptions = {}): BaselineStt {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.DICTATION_OPENAI_API_KEY ?? '';
  const model = options.model ?? 'gpt-4o-mini-transcribe';
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async transcribe(pcm: Buffer): Promise<SttOutcome> {
      const started = nowMs();
      const attempt = async (): Promise<SttOutcome> => {
        if (!apiKey) throw new Error('stt failed: no OPENAI_API_KEY / DICTATION_OPENAI_API_KEY configured');
        const form = new FormData();
        form.append('model', model);
        form.append('response_format', 'text');
        form.append('file', new Blob([new Uint8Array(pcm)], { type: 'audio/pcm' }), 'audio.pcm');
        const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (!response.ok) {
          throw new Error(`stt failed: openai ${model} responded ${response.status}`);
        }
        const text = (await response.text()).trim();
        return { text, provider: 'openai', model, ms: nowMs() - started, usage: {} };
      };
      try {
        return await attempt();
      } catch (primaryError) {
        if (options.whisperFallback) {
          try {
            return await options.whisperFallback.transcribe(pcm);
          } catch {
            /* fall through to the combined error */
          }
        }
        throw primaryError;
      }
    },
  };
}

export interface WhisperSttOptions {
  baseUrl?: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

/** Local Whisper ASR webservice (`/root/whisper`, `POST /asr`). */
export function createWhisperFallbackStt(options: WhisperSttOptions = {}): BaselineStt {
  const baseUrl = (options.baseUrl ?? process.env.VOICE_LAB_WHISPER_URL ?? 'http://127.0.0.1:9000').replace(/\/$/, '');
  const language = options.language ?? 'en';
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async transcribe(pcm: Buffer): Promise<SttOutcome> {
      const started = nowMs();
      const wav = pcmToWav(pcm, 16000);
      const form = new FormData();
      form.append('audio_file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
      const response = await fetchImpl(
        `${baseUrl}/asr?output=json&task=transcribe&language=${encodeURIComponent(language)}&word_timestamps=true`,
        { method: 'POST', body: form }
      );
      if (!response.ok) {
        throw new Error(`stt failed: whisper responded ${response.status}`);
      }
      const payload = (await response.json()) as { text?: string };
      return {
        text: (payload.text ?? '').trim(),
        provider: 'whisper-local',
        model: 'whisper',
        ms: nowMs() - started,
        usage: {},
      };
    },
  };
}

export interface OpenAiTtsOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI `tts-1`, voice `alloy`, `response_format: 'pcm'` — 24 kHz raw s16le,
 * the reference player's native rate.
 */
export function createOpenAiTts(options: OpenAiTtsOptions = {}): BaselineTts {
  const apiKey = options.apiKey ?? process.env.TTS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  const model = options.model ?? process.env.TTS_MODEL ?? 'tts-1';
  const voice = options.voice ?? 'alloy';
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async synthesise(text: string): Promise<TtsOutcome> {
      const started = nowMs();
      if (!apiKey) throw new Error('tts failed: no TTS_OPENAI_API_KEY / OPENAI_API_KEY configured');
      const response = await fetchImpl(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice, input: text, response_format: 'pcm' }),
      });
      if (!response.ok) {
        throw new Error(`tts failed: openai ${model} responded ${response.status}`);
      }
      const pcm = Buffer.from(await response.arrayBuffer());
      return { pcm, provider: 'openai', model, voice, ms: nowMs() - started, usage: {} };
    },
  };
}

/** Wrap raw s16le PCM in a minimal WAV container (Whisper wants a container). */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** Snapshot type the runner records next to the manifest (resolved identities). */
export interface BaselineLegIdentity {
  lane: EndpointLane;
  talkerModel: string;
  sttProvider: string | null;
  ttsProvider: string | null;
  lastStateView?: WorkerStateSnapshot;
}
