/**
 * Baseline dry-run (L2).
 *
 * Drives the full L2 path — scenario beats → speech driver → baseline cascade
 * (real TalkerSession + policy core + recording delivery) → reference player
 * → immutable attempt record → offline verifier — with HERMETIC legs:
 *
 *   STT   `script`   returns the beat's authored utterance text (labelled in
 *                    the manifest; a dry run is never a provider measurement)
 *   talker `dryrun-script`  a real TalkerSession over a scripted model client
 *                    that answers from the exposed world snapshot
 *   TTS   `silence-mock`    synthesises silence sized to the reply, so the
 *                    player's byte accounting and the TTFA measurement are
 *                    exercised end to end
 *
 * What a green dry run proves: the harness, the gate, the event vocabulary,
 * the record layout and the scorer agree with each other on real files. What
 * it does NOT prove: anything about any model. Every attempt record carries
 * `usage.provider: "baseline-cascade"` and `mode: "dry-run"` so a dry-run row
 * can never masquerade as a measured condition.
 *
 * Branch selection in a dry run is fixed to the beat's FIRST (primary)
 * branch, and world-event triggers fire as soon as the previous beat's turn
 * completes — the world driver that times them against a running worker is
 * L4 machinery and deliberately not pre-empted here.
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
  BaselineCascade,
  type BaselineStt,
  type BaselineTts,
} from './providers/baseline-cascade.js';
import { TalkerSession } from '../../../server/src/talker/talker.js';
import { createNullDelivery } from '../../../server/src/talker/delivery.js';
import type { ChatMessage, ModelTurnResult, TalkerModelClient, WorkerStateSnapshot } from '../../../server/src/talker/types.js';

export const DRY_RUN_TALKER = 'dryrun-script';
export const DRY_RUN_STT_PROVIDER = 'script';
export const DRY_RUN_TTS_PROVIDER = 'silence-mock';

/**
 * Scripted talker model: answers from the world snapshot it is given, and
 * marks reading-level requests [[to-talker]] so the suppression path is
 * exercised end to end (a well-behaved talker keeps bookkeeping out of the
 * draft; P22). Deterministic by construction.
 */
const TALKER_ADDRESSED = /\b(?:read (?:me|it back|the next)|catch me up|summary instead|headlines now|stop reading|word for word)\b/i;

export function createDryRunTalkerModel(answerFrom: WorkerStateSnapshot): TalkerModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
      calls += 1;
      const basis = answerFrom.lastAssistantText ?? answerFrom.activity ?? 'Nothing to report yet.';
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const suffix = TALKER_ADDRESSED.test(lastUser) ? ' [[to-talker]]' : '';
      return { text: `${basis}${suffix}`, ttftMs: 15, totalMs: 30 };
    },
  };
}

/** Hermetic STT: pops the authored utterance per call (last one repeats). */
export function createScriptedStt(utterances: string[]): BaselineStt & { served: string[] } {
  const queue = [...utterances];
  const served: string[] = [];
  return {
    served,
    async transcribe(pcm: Buffer) {
      void pcm;
      const text = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? '');
      served.push(text);
      return { text, provider: DRY_RUN_STT_PROVIDER, model: 'authored-utterance', ms: 1, usage: { scripted: true } };
    },
  };
}

/** Hermetic TTS: 24 kHz silence at ~60 ms per word (player accounting is real). */
export function createSilentTts(sampleRate = 24000): BaselineTts {
  return {
    async synthesise(text: string) {
      const words = Math.max(1, text.trim().split(/\s+/).length);
      const frames = Math.round((sampleRate * words * 60) / 1000);
      return {
        pcm: Buffer.alloc(frames * 2),
        provider: DRY_RUN_TTS_PROVIDER,
        model: 'silence',
        voice: 'none',
        ms: 1,
        usage: { synthesised: false },
      };
    },
  };
}

/** Non-silent input audio for a beat: a soft sine at real duration (60 ms/word
 *  at 16 kHz), so the driver's framing and the cascade's silence detection are
 *  exercised on real-shaped audio. */
export function utterancePcm(text: string, sampleRate = 16000): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const frames = Math.round((sampleRate * words * 60) / 1000);
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 10)), i * 2);
  return buf;
}

export interface DryRunAttemptOutcome {
  attempt: AttemptLayout;
  scenario: VoiceScenario;
  world: WorkerWorld | null;
  verifyOk: boolean;
  verifyProblems: string[];
  turns: number;
  releases: number;
}

export interface DryRunOptions {
  runsRoot: string;
  scenarioPath: string;
  attempts?: number;
  runId?: string;
  /** Frame pacing in ms; 20 ms is the real pacing, tests may shrink it. */
  frameIntervalMs?: number;
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

/**
 * Run one hermetic attempt of a scenario against the baseline cascade and
 * finalise its immutable record. Deterministic: same scenario → same record
 * modulo timing values.
 */
export async function runDryAttempt(
  scenarioPath: string,
  options: DryRunOptions & { attemptId?: string; quiet?: boolean }
): Promise<DryRunAttemptOutcome> {
  const scenario = loadScenarioFile(scenarioPath);
  const worldPath = resolveWorldPath(scenarioPath, scenario);
  const world = worldPath ? loadWorldFile(worldPath) : null;

  const runId = options.runId ?? `dryrun-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
  const condition = `t${scenario.tier}/baseline-cascade/${scenario.endpointing}-script-duck/${world?.id ?? 'no-world'}`;
  const attempt = createAttempt(options.runsRoot, runId, condition, options.attemptId);

  const clock: MonotonicClock = createMonotonicClock();
  const log = new EventLog({ clock, filePath: eventLogPath(attempt.attemptDir) });

  const scriptedUtterances = utterancesFor(scenario);
  const stt = createScriptedStt(scriptedUtterances);
  const tts = createSilentTts();
  const model = createDryRunTalkerModel(world?.initial ?? { activity: 'no world attached' });
  const player = new ReferencePlayer({ log });
  const session = new TalkerSession({
    model,
    delivery: createNullDelivery(),
    workerSessionId: `dryrun-${scenario.id}`,
    snapshotProvider: () => world?.initial ?? { activity: 'no world attached' },
  });

  const cascade = new BaselineCascade({
    log,
    clock,
    lane: scenario.endpointing,
    talker: session,
    stt,
    tts,
    player,
  });

  // One driver per attempt; every beat streams one utterance; the E lane's
  // activityEnd is the tap-to-talk release that fires the cascade turn.
  const driver = new SpeechDriver({
    log,
    sink: cascade,
    lane: scenario.endpointing,
    frameIntervalMs: options.frameIntervalMs ?? 20,
    leadInMs: 300,
    trailSilenceMs: 900,
  });

  let index = 0;
  for (const beat of scenario.beats) {
    const utterance = scriptedUtterances[index] ?? '';
    index += 1;
    if (!utterance) continue;
    // A dry run keeps only the causal order of triggers: each beat starts
    // once the previous beat's turn has fully completed.
    await cascade.settle();
    player.setOperatorFloor(true);
    await driver.stream(beat.id, utterancePcm(utterance));
    player.setOperatorFloor(false);
    await cascade.settle();
  }
  await cascade.flush();
  player.stop('attempt-end');

  // Provenance copies: the exact scenario and world the attempt ran against.
  copyFileSync(scenarioPath, path.join(attempt.attemptDir, 'application', 'scenario.json'));
  if (worldPath) copyFileSync(worldPath, path.join(attempt.attemptDir, 'application', 'world.json'));

  // Frame declaration comes from the same PCM the driver streamed, so the
  // verifier's dropped-frame check has an independent expectation. The N lane
  // also streams authored lead-in and trail silence per utterance.
  const lanePadFrames =
    scenario.endpointing === 'N'
      ? Math.round(300 / 20) + Math.round(900 / 20)
      : 0;
  const declaredFrames = scenario.beats.reduce((sum, beat) => {
    const utterance =
      beat.mode === 'frozen' ? (beat.utterance ?? '') : (beat.branches?.[0]?.utterance ?? '');
    if (!utterance) return sum;
    const pcmBytes = utterancePcm(utterance).byteLength;
    return sum + lanePadFrames + Math.ceil(pcmBytes / 640);
  }, 0);

  finaliseAttempt(attempt.attemptDir, {
    runId,
    condition,
    attemptId: attempt.attemptId,
    createdAt: new Date().toISOString(),
    clockOriginIso: clock.originIso(),
    eventLog: 'application/events.jsonl',
    requiredEventKinds: [EVENT.PROVIDER_CONTENT, EVENT.PROVIDER_USAGE, EVENT.TURN_COMPLETE, EVENT.INPUT_FRAME],
    goldenStrings: world ? goldenStringsFor(world) : [],
    input: { sourceId: scenario.id, declaredFrames, frameBytes: 640 },
    usage: {
      provider: 'baseline-cascade',
      mode: 'dry-run',
      stt: { provider: DRY_RUN_STT_PROVIDER, scripted: true },
      talker: DRY_RUN_TALKER,
      tts: { provider: DRY_RUN_TTS_PROVIDER, synthesised: false },
      realProviderCalls: 0,
    },
    outcome: 'completed',
  });

  const verify = verifyAttempt(attempt.attemptDir);
  if (!options.quiet && !verify.ok) {
    for (const problem of verify.problems) process.stderr.write(`verify problem: ${problem}\n`);
  }

  const releases = log
    .events()
    .filter((event) => event.kind === EVENT.HARNESS_RELEASE).length;

  return {
    attempt,
    scenario,
    world,
    verifyOk: verify.ok,
    verifyProblems: verify.problems,
    turns: cascade.completedTurns,
    releases,
  };
}
