/**
 * Tier 1 dry-run (L4).
 *
 * Drives the full guarded-native path — scenario beats → speech driver →
 * GeminiLiveProvider → Tier1GuardedHarness (pure policy core + recording
 * delivery + trusted mechanical voice) → reference player → immutable attempt
 * record → offline verifier — with HERMETIC legs:
 *
 *   live session  `gemini-live-dryrun`  a scripted LiveSessionFactory: the
 *                    authored utterance arrives as inputTranscription deltas
 *                    (the native ASR), conversational turns speak the world
 *                    basis as output audio + outputTranscription, and the
 *                    mark_addressed_to_talker bookkeeping call fires exactly
 *                    where the L2 scripted talker would have emitted
 *                    [[to-talker]]. Confirm-shaped turns stay silent: the
 *                    guarded harness owns those transitions.
 *   shadow ASR    `whisper-script`  the authored utterance per turn (the
 *                    fidelity reference, or the deciding transcript in the
 *                    sidecar condition).
 *   mech. voice   `silence-mock`     silence sized to the reply with real
 *                    byte accounting, so the player and TTFA measurement are
 *                    exercised end to end.
 *
 * What a green dry run proves: the guarded harness, the commit rule, the
 * gate, the event vocabulary, the record layout and the scorer agree with
 * each other on real files. What it does NOT prove: anything about any
 * model. Every attempt record carries `usage.provider:
 * "gemini-live-dryrun"`, `mode: "dry-run"` and `realProviderCalls: 0`, so a
 * dry-run row can never masquerade as a measured condition.
 */

import { copyFileSync } from 'node:fs';
import path from 'node:path';

import { EVENT, EventLog, createMonotonicClock, type MonotonicClock } from './scheduler.js';
import { SpeechDriver } from './speech-driver.js';
import { ReferencePlayer } from './playback.js';
import {
  createAttempt,
  eventLogPath,
  finaliseAttempt,
  verifyAttempt,
  type AttemptLayout,
} from './record.js';
import { loadScenarioFile, type VoiceScenario } from './scenario.js';
import { goldenStringsFor, loadWorldFile, type WorkerWorld } from './worlds.js';
import {
  GeminiLiveProvider,
  createGenaiLiveSessionFactory,
  type LiveCallbacks,
  type LiveConnectRequest,
  type LiveServerMessageShape,
  type LiveSessionFactory,
  type LiveSessionLike,
} from './providers/gemini-live.js';
import {
  Tier1GuardedHarness,
  buildTier1SystemInstruction,
  type MechanicalVoice,
  type ShadowAsr,
  type Tier1TranscriptCondition,
} from './harness/tier1-guarded.js';
import { createNullDelivery } from '../../../server/src/talker/delivery.js';
import { classifyOperatorUtterance } from '../../../server/src/talker/utterance-classifier.js';
import type { WorkerStateSnapshot } from '../../../server/src/talker/types.js';

export const DRYRUN_PROVIDER = 'gemini-live-dryrun';
export const DRYRUN_SHADOW_PROVIDER = 'whisper-script';
export const DRYRUN_MECHANICAL_PROVIDER = 'silence-mock';

/** Same heuristic as the L2 dry-run talker: where a text-marker talker would
 *  have ended [[to-talker]], the native candidate calls mark_addressed_to_talker. */
const ADDRESSED_PATTERN = /\b(?:read (?:me|it back|the next)|catch me up|summary instead|headlines now|stop reading|word for word)\b/i;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Non-silent input audio for a beat: a soft sine at real duration. */
export function utterancePcm(text: string, sampleRate = 16000): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const frames = Math.round((sampleRate * words * 60) / 1000);
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 10)), i * 2);
  return buf;
}

/** 24 kHz sine for scripted native reply audio (real-shaped bytes). */
function replyPcm(text: string, sampleRate = 24000): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const frames = Math.round((sampleRate * words * 60) / 1000);
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(4000 * Math.sin(i / 12)), i * 2);
  return buf;
}

// ── The scripted live session factory ────────────────────────────────────────

export interface ScriptedTurn {
  /** The "native ASR" transcript, delivered as two deltas. */
  transcript: string;
  /** null: the turn stays silent (the harness owns the transition). */
  reply: string | null;
  /** Tier-1 bookkeeping call emitted with the reply. */
  toolCall?: 'mark_addressed_to_talker' | 'offer_ask_worker';
}

export interface ScriptedLiveFactoryOptions {
  lane: 'E' | 'N';
  /** N lane: cumulative audio-byte threshold per scripted turn. */
  thresholds?: number[];
  /** Pacing between scripted emissions (real ms). Default 2. */
  emitDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A scripted stand-in for `ai.live.connect`. In the E lane each activityEnd
 * triggers the next scripted exchange; in the N lane the trigger is the
 * cumulative received audio crossing the turn's threshold. Output follows
 * the input exactly as a native exchange would.
 */
export function createScriptedLiveFactory(
  turns: ScriptedTurn[],
  options: ScriptedLiveFactoryOptions
): LiveSessionFactory & { emitted: number } {
  const sleep = options.sleep ?? defaultSleep;
  const emitDelayMs = options.emitDelayMs ?? 2;
  const state = {
    next: 0,
    bytesSeen: 0,
    session: null as ScriptedLiveSession | null,
    emitted: 0,
  };

  class ScriptedLiveSession implements LiveSessionLike {
    private readonly callbacks: LiveCallbacks;
    private emitting = false;

    constructor(callbacks: LiveCallbacks) {
      this.callbacks = callbacks;
      queueMicrotask(() => {
        this.callbacks.onOpen();
        this.callbacks.onMessage({ setupComplete: true });
      });
    }

    sendRealtimeInput(input: Record<string, unknown>): void {
      if ('audio' in input && input.audio) {
        const data = (input.audio as { data: string }).data;
        state.bytesSeen += Buffer.from(data, 'base64').byteLength;
        if (options.lane === 'N') this.maybeEmitForBytes();
        return;
      }
      if ('activityEnd' in input && options.lane === 'E') {
        void this.emitNext();
      }
    }

    private maybeEmitForBytes(): void {
      const threshold = options.thresholds?.[state.next];
      if (threshold !== undefined && state.bytesSeen >= threshold) {
        void this.emitNext();
      }
    }

    sendClientContent(_content: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }): void {
      /* context updates are accepted and deliberately not scripted */
    }

    sendToolResponse(_response: { functionResponses: Array<Record<string, unknown>> }): void {
      /* the SILENT acknowledgement; nothing to script */
    }

    close(): void {
      state.session = null;
    }

    private async emitNext(): Promise<void> {
      const turn = turns[state.next];
      if (!turn || this.emitting) return;
      this.emitting = true;
      state.next += 1;
      state.emitted += 1;
      try {
        const words = turn.transcript.split(/\s+/);
        const half = Math.max(1, Math.ceil(words.length / 2));
        this.deliver({ serverContent: { inputTranscription: { text: words.slice(0, half).join(' ') } } });
        await sleep(emitDelayMs);
        this.deliver({ serverContent: { inputTranscription: { text: ` ${words.slice(half).join(' ')}` } } });
        if (turn.reply !== null) {
          await sleep(emitDelayMs);
          this.deliver({
            serverContent: {
              outputTranscription: { text: turn.reply },
              modelTurn: {
                parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: replyPcm(turn.reply).toString('base64') } }],
              },
            },
          });
          if (turn.toolCall) {
            await sleep(emitDelayMs);
            this.deliver({ toolCall: { functionCalls: [{ name: turn.toolCall, args: {}, id: `call-${state.next}` }] } });
          }
          await sleep(emitDelayMs);
          this.deliver({ serverContent: { turnComplete: true } });
        }
      } finally {
        this.emitting = false;
      }
    }

    private deliver(message: LiveServerMessageShape): void {
      this.callbacks.onMessage(message);
    }
  }

  const factory = (async (request: LiveConnectRequest): Promise<LiveSessionLike> => {
    state.session = new ScriptedLiveSession(request.callbacks);
    return state.session;
  }) as LiveSessionFactory & { emitted: number };
  Object.defineProperty(factory, 'emitted', { get: () => state.emitted });
  return factory;
}

/** Hermetic shadow ASR: pops the authored utterance per call (last repeats). */
export function createScriptedShadowAsr(utterances: string[]): ShadowAsr & { served: string[] } {
  const queue = [...utterances];
  const served: string[] = [];
  return {
    served,
    async transcribe(_pcm: Buffer) {
      const text = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? '');
      served.push(text);
      return { text, provider: DRYRUN_SHADOW_PROVIDER, model: 'authored-utterance', ms: 1, usage: { scripted: true } };
    },
  };
}

/** Silence mechanical voice at ~60 ms per word (player accounting is real). */
export function createSilenceMechanicalVoice(): MechanicalVoice {
  return {
    async synthesise(text: string) {
      const words = Math.max(1, text.trim().split(/\s+/).length);
      return {
        pcm: Buffer.alloc(Math.round((24000 * words * 60) / 1000) * 2),
        provider: DRYRUN_MECHANICAL_PROVIDER,
        model: 'silence',
        voice: 'none',
        ms: 1,
      };
    },
  };
}

// ── The guarded real-run entry (tier1-run) ──────────────────────────────────

/**
 * The real shadow ASR: the offline Whisper container (whisper-asr-webservice
 * contract: WAV in, { text } out). 16 kHz mono PCM is wrapped in a minimal
 * WAV header and POSTed as multipart/form-data.
 */
export function createWhisperShadowAsr(endpoint = 'http://127.0.0.1:9000'): ShadowAsr & { endpoint: string } {
  return {
    endpoint,
    async transcribe(pcm: Buffer): Promise<ShadowAsrOutcome> {
      const startedMs = Date.now();
      const form = new FormData();
      form.append('audio_file', new Blob([encodeWav(pcm)], { type: 'audio/wav' }), 'turn.wav');
      const response = await fetch(`${endpoint}/asr?task=transcribe&language=en&output=json`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        throw new Error(`whisper shadow ASR failed: HTTP ${response.status} from ${endpoint}`);
      }
      const body = (await response.json()) as { text?: string };
      return {
        text: (body.text ?? '').trim(),
        provider: 'whisper-container',
        model: 'large-v3',
        ms: Date.now() - startedMs,
      };
    },
  };
}

/** Wrap 16 kHz mono s16le PCM in a minimal RIFF/WAV container. */
export function encodeWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

export interface Tier1RealRunOptions {
  runsRoot: string;
  scenarioPath: string;
  apiKey: string;
  runId?: string;
  condition?: Tier1TranscriptCondition;
  model?: string;
  whisperEndpoint?: string;
  attemptId?: string;
  quiet?: boolean;
}

/**
 * One MEASURED tier-1 attempt against the real Gemini Live session. The
 * caller must have already verified budget, quota and the 07:00–11:00 UK
 * window (plan §21); this entry refuses an empty API key rather than ever
 * running unlabelled. The mechanical voice stays the labelled silence mock
 * until the Supertonic binding is reviewed — the manifest records it.
 */
export async function runTier1MeasuredAttempt(options: Tier1RealRunOptions): Promise<Tier1DryRunOutcome> {
  if (!options.apiKey || !options.apiKey.trim()) {
    throw new Error('GEMINI_API_KEY is required for a measured tier-1 run (refusing an unlabelled attempt)');
  }
  const scenario = loadScenarioFile(options.scenarioPath);
  const worldPath = resolveWorldPath(options.scenarioPath, scenario);
  const world = worldPath ? loadWorldFile(worldPath) : null;
  const condition = options.condition ?? 'native';

  const runId = options.runId ?? `tier1-measured-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
  const model = options.model ?? 'gemini-3.8-live';
  const conditionName = `t${scenario.tier}/${model}/${scenario.endpointing}-${condition}-duck/${world?.id ?? 'no-world'}`;
  const attempt = createAttempt(options.runsRoot, runId, conditionName, options.attemptId);

  const clock: MonotonicClock = createMonotonicClock();
  const log = new EventLog({ clock, filePath: eventLogPath(attempt.attemptDir) });
  const player = new ReferencePlayer({ log });

  const provider = new GeminiLiveProvider({
    log,
    clock,
    lane: scenario.endpointing,
    model,
    systemInstruction: buildTier1SystemInstruction(),
    sessionFactory: createGenaiLiveSessionFactory(options.apiKey),
  });
  const shadowAsr = createWhisperShadowAsr(options.whisperEndpoint);
  const delivery = createNullDelivery();

  const harness = new Tier1GuardedHarness({
    log,
    clock,
    lane: scenario.endpointing,
    condition,
    provider,
    delivery,
    workerSessionId: `tier1-measured-${scenario.id}`,
    snapshotProvider: () => world?.initial ?? { activity: 'no world attached' },
    shadowAsr,
    mechanicalVoice: createSilenceMechanicalVoice(),
    player,
    stabilityMs: 400,
  });

  // A measured run drives real operator audio through the same driver; the
  // beats come from the scenario exactly as the dry run paces them.
  const scriptedUtterances = utterancesFor(scenario);
  const driver = new SpeechDriver({
    log,
    sink: harness,
    lane: scenario.endpointing,
    frameIntervalMs: 20,
    leadInMs: 300,
    trailSilenceMs: 900,
  });

  await harness.start();
  for (let index = 0; index < scenario.beats.length; index += 1) {
    const beat = scenario.beats[index];
    const utterance = scriptedUtterances[index] ?? '';
    if (!utterance) continue;
    await harness.settle();
    await driver.stream(beat.id, utterancePcm(utterance));
    await harness.settle();
  }
  await harness.stop('attempt-end');

  copyFileSync(options.scenarioPath, path.join(attempt.attemptDir, 'application', 'scenario.json'));
  if (worldPath) copyFileSync(worldPath, path.join(attempt.attemptDir, 'application', 'world.json'));

  const declaredFrames = scenario.beats.reduce((sum, beat) => {
    const utterance =
      beat.mode === 'frozen' ? (beat.utterance ?? '') : (beat.branches?.[0]?.utterance ?? '');
    if (!utterance) return sum;
    const pad = scenario.endpointing === 'N' ? Math.round(300 / 20) + Math.round(900 / 20) : 0;
    return sum + pad + Math.ceil(utterancePcm(utterance).byteLength / 640);
  }, 0);

  finaliseAttempt(attempt.attemptDir, {
    runId,
    condition: conditionName,
    attemptId: attempt.attemptId,
    createdAt: new Date().toISOString(),
    clockOriginIso: clock.originIso(),
    eventLog: 'application/events.jsonl',
    requiredEventKinds: [EVENT.PROVIDER_CONTENT, EVENT.PROVIDER_USAGE, EVENT.TURN_COMPLETE, EVENT.INPUT_FRAME],
    goldenStrings: world ? goldenStringsFor(world) : [],
    input: { sourceId: scenario.id, declaredFrames, frameBytes: 640 },
    usage: {
      provider: 'gemini-live',
      mode: 'measured',
      model,
      lane: scenario.endpointing,
      transcriptCondition: condition,
      stt: { provider: condition === 'sidecar' ? 'whisper-container' : 'gemini-live' },
      shadowAsr: { provider: 'whisper-container', endpoint: shadowAsr.endpoint },
      mechanicalVoice: { provider: DRYRUN_MECHANICAL_PROVIDER, synthesised: false, note: 'supertonic binding pending review' },
      delivery: delivery.describe(),
      commitRule: { stabilityMs: 400 },
      realProviderCalls: 1,
    },
    outcome: 'completed',
  });

  const verify = verifyAttempt(attempt.attemptDir);
  if (!options.quiet && !verify.ok) {
    for (const problem of verify.problems) process.stderr.write(`verify problem: ${problem}\n`);
  }
  return {
    attempt,
    scenario,
    world,
    verifyOk: verify.ok,
    verifyProblems: verify.problems,
    turns: harness.completedTurns,
    releases: harness.releases,
    harnessTurns: harness.turnRecords.map((t) => ({
      turn: t.turn,
      boundary: t.boundary,
      condition: t.condition,
      transcript: t.transcript,
      failedLeg: t.failedLeg,
      ttfaMs: t.ttfaMs,
    })),
  };
}

// ── The runner ───────────────────────────────────────────────────────────────

export interface Tier1DryRunOutcome {
  attempt: AttemptLayout;
  scenario: VoiceScenario;
  world: WorkerWorld | null;
  verifyOk: boolean;
  verifyProblems: string[];
  turns: number;
  releases: number;
  harnessTurns: ReadonlyArray<{
    turn: number;
    boundary: string;
    condition: string;
    transcript: string;
    failedLeg: string | null;
    ttfaMs: number | null;
  }>;
}

export interface Tier1DryRunOptions {
  runsRoot: string;
  scenarioPath: string;
  attempts?: number;
  runId?: string;
  condition?: Tier1TranscriptCondition;
  /** Frame pacing in ms; 20 ms is the real pacing, tests may shrink it. */
  frameIntervalMs?: number;
  /** Commit stability window; 400 ms is the rule, hermetic runs shrink it. */
  stabilityMs?: number;
  attemptId?: string;
  quiet?: boolean;
}

function resolveWorldPath(scenarioPath: string, scenario: VoiceScenario): string | null {
  if (!scenario.world) return null;
  if (path.isAbsolute(scenario.world)) return scenario.world;
  // World refs are relative to the benchmark root: scenarios/<tier>/*.json
  // sits two levels below it.
  return path.resolve(path.dirname(scenarioPath), '..', '..', scenario.world);
}

function utterancesFor(scenario: VoiceScenario): string[] {
  const out: string[] = [];
  for (const beat of scenario.beats) {
    if (beat.mode === 'frozen' && beat.utterance) out.push(beat.utterance);
    else if (beat.mode === 'branching' && beat.branches?.length) out.push(beat.branches[0].utterance);
    else out.push('');
  }
  return out;
}

function scriptedTurnsFor(scenario: VoiceScenario, world: WorkerWorld | null): ScriptedTurn[] {
  const basis = world?.initial ?? { activity: 'no world attached' };
  const replyBasis =
    (basis as WorkerStateSnapshot).lastAssistantText ??
    (basis as WorkerStateSnapshot).activity ??
    'Nothing to report yet.';
  return utterancesFor(scenario).map((utterance) => {
    if (!utterance) return { transcript: '', reply: null };
    // Confirm-shaped turns stay silent: the guarded harness owns them.
    const spoken = classifyOperatorUtterance(utterance) !== 'confirm';
    return {
      transcript: utterance,
      reply: spoken ? replyBasis : null,
      toolCall: ADDRESSED_PATTERN.test(utterance) ? 'mark_addressed_to_talker' : undefined,
    };
  });
}

/**
 * Run one hermetic tier-1 attempt of a scenario against the guarded native
 * harness and finalise its immutable record. Deterministic: same scenario →
 * same record modulo timing values.
 */
export async function runTier1DryAttempt(
  scenarioPath: string,
  options: Tier1DryRunOptions
): Promise<Tier1DryRunOutcome> {
  const scenario = loadScenarioFile(scenarioPath);
  const worldPath = resolveWorldPath(scenarioPath, scenario);
  const world = worldPath ? loadWorldFile(worldPath) : null;
  const condition: Tier1TranscriptCondition = options.condition ?? 'native';

  const runId = options.runId ?? `tier1-dryrun-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
  const conditionName = `t${scenario.tier}/${DRYRUN_PROVIDER}/${scenario.endpointing}-${condition}-duck/${world?.id ?? 'no-world'}`;
  const attempt = createAttempt(options.runsRoot, runId, conditionName, options.attemptId);

  const clock: MonotonicClock = createMonotonicClock();
  const log = new EventLog({ clock, filePath: eventLogPath(attempt.attemptDir) });
  const player = new ReferencePlayer({ log });

  const scriptedUtterances = utterancesFor(scenario);
  const turns = scriptedTurnsFor(scenario, world);

  // N-lane triggers: cumulative bytes at each turn's trail boundary (lead-in
  // + the utterance itself) — the scripted exchange fires as the VAD window
  // opens, never from a leaked script boundary marker.
  let cumulative = 0;
  const thresholds = scriptedUtterances.map((utterance) => {
    cumulative += Math.round(300 / 20) * 640 + utterancePcm(utterance).byteLength;
    return cumulative;
  });

  const liveFactory = createScriptedLiveFactory(turns, {
    lane: scenario.endpointing,
    thresholds,
    emitDelayMs: 2,
  });
  const provider = new GeminiLiveProvider({
    log,
    clock,
    lane: scenario.endpointing,
    model: `${DRYRUN_PROVIDER}-mock`,
    systemInstruction: buildTier1SystemInstruction(),
    sessionFactory: liveFactory,
  });
  const shadowAsr = createScriptedShadowAsr(scriptedUtterances);
  const delivery = createNullDelivery();

  const harness = new Tier1GuardedHarness({
    log,
    clock,
    lane: scenario.endpointing,
    condition,
    provider,
    delivery,
    workerSessionId: `tier1-dryrun-${scenario.id}`,
    snapshotProvider: () => world?.initial ?? { activity: 'no world attached' },
    shadowAsr,
    mechanicalVoice: createSilenceMechanicalVoice(),
    player,
    stabilityMs: options.stabilityMs ?? 400,
    turnTimeoutMs: 10000,
  });

  const driver = new SpeechDriver({
    log,
    sink: harness,
    lane: scenario.endpointing,
    frameIntervalMs: options.frameIntervalMs ?? 20,
    leadInMs: 300,
    trailSilenceMs: 900,
  });

  await harness.start();
  const beats = scenario.beats;
  for (let index = 0; index < beats.length; index += 1) {
    const beat = beats[index];
    const utterance = scriptedUtterances[index] ?? '';
    if (!utterance) continue;
    await harness.settle();
    await driver.stream(beat.id, utterancePcm(utterance));
    await harness.settle();
  }
  await harness.stop('attempt-end');

  // Provenance copies: the exact scenario and world the attempt ran against.
  copyFileSync(scenarioPath, path.join(attempt.attemptDir, 'application', 'scenario.json'));
  if (worldPath) copyFileSync(worldPath, path.join(attempt.attemptDir, 'application', 'world.json'));

  // Frame declaration comes from the same PCM the driver streamed.
  const frameIntervalMs = options.frameIntervalMs ?? 20;
  const lanePadFrames =
    scenario.endpointing === 'N'
      ? Math.round(300 / frameIntervalMs) + Math.round(900 / frameIntervalMs)
      : 0;
  const declaredFrames = beats.reduce((sum, beat) => {
    const utterance =
      beat.mode === 'frozen' ? (beat.utterance ?? '') : (beat.branches?.[0]?.utterance ?? '');
    if (!utterance) return sum;
    return sum + lanePadFrames + Math.ceil(utterancePcm(utterance).byteLength / 640);
  }, 0);

  finaliseAttempt(attempt.attemptDir, {
    runId,
    condition: conditionName,
    attemptId: attempt.attemptId,
    createdAt: new Date().toISOString(),
    clockOriginIso: clock.originIso(),
    eventLog: 'application/events.jsonl',
    requiredEventKinds: [
      EVENT.PROVIDER_CONTENT,
      EVENT.PROVIDER_USAGE,
      EVENT.TURN_COMPLETE,
      EVENT.INPUT_FRAME,
    ],
    goldenStrings: world ? goldenStringsFor(world) : [],
    input: { sourceId: scenario.id, declaredFrames, frameBytes: 640 },
    usage: {
      provider: DRYRUN_PROVIDER,
      mode: 'dry-run',
      model: `${DRYRUN_PROVIDER}-mock`,
      lane: scenario.endpointing,
      transcriptCondition: condition,
      stt: { provider: condition === 'sidecar' ? DRYRUN_SHADOW_PROVIDER : 'gemini-live-dryrun-asr', scripted: true },
      shadowAsr: { provider: DRYRUN_SHADOW_PROVIDER, scripted: true, role: condition === 'sidecar' ? 'deciding' : 'fidelity-reference' },
      mechanicalVoice: { provider: DRYRUN_MECHANICAL_PROVIDER, synthesised: false },
      delivery: delivery.describe(),
      commitRule: { stabilityMs: options.stabilityMs ?? 400 },
      realProviderCalls: 0,
    },
    outcome: 'completed',
  });

  const verify = verifyAttempt(attempt.attemptDir);
  if (!options.quiet && !verify.ok) {
    for (const problem of verify.problems) process.stderr.write(`verify problem: ${problem}\n`);
  }

  const harnessTurns = harness.turnRecords.map((t) => ({
    turn: t.turn,
    boundary: t.boundary,
    condition: t.condition,
    transcript: t.transcript,
    failedLeg: t.failedLeg,
    ttfaMs: t.ttfaMs,
  }));

  return {
    attempt,
    scenario,
    world,
    verifyOk: verify.ok,
    verifyProblems: verify.problems,
    turns: harness.completedTurns,
    releases: harness.releases,
    harnessTurns,
  };
}
