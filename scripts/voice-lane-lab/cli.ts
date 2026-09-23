#!/usr/bin/env npx tsx
/**
 * Voice Lane Lab — the overlap detector for the native voice lane.
 *
 * The operator reported that the talker's voice "starts talking on top of each
 * other … several sentences at the same time … I can't really understand what
 * it's saying", and that the server's own observability could not see it. The
 * audio regression lab measures the OS-rendered output of a null sink, but its
 * capture chain cannot start on this host (`doctor` → `capture:chain` FAIL), so
 * this lane measures the two things that decide whether a live lane's audio
 * reaches the ear intact and that ARE observable here:
 *
 *   1. the model audio the server actually sent a real lane, and
 *   2. the schedule the SHIPPED client scheduler produced for it.
 *
 * An overlap in (2) is an overlap in reality: booked Web Audio sources start when
 * they were booked. What this cannot see is anything past the graph — a device
 * dropout, a Bluetooth route, another tab — and it says so rather than calling
 * that clean.
 *
 * Commands:
 *   doctor                          what this host can and cannot do
 *   run [--out <dir>] [--question "…"] [--listen-ms N] [--json]
 *   analyse <dir>                    re-analyse a recorded capture (no network)
 *   built-app [--episode C01] …      Phase 1 capture proof (L)
 *   primary-mic --episode C01 --arm standard [--tts synthetic|real] [--server-env K=V]…
 *                                    the built-app main-control journey: real
 *                                    fake-file mic speech + labelled
 *                                    synthetic-stream-source steps, immutable
 *                                    E2 record, offline-verifiable (J).
 *                                    --tts synthetic (explicit, default off)
 *                                    adds the labelled synthetic-tts-source
 *                                    read-back shim, whose spoken texts are
 *                                    recorded and verifier-checked against the
 *                                    proposal's retained bytes (J3)
 *   campaign --plan --arms standard,et-high [--dry-run] [--server-env K=V]…
 *                                    resume-safe §8 matrix runner with a full
 *                                    scheduled-cell index (J)
 *   verify <attemptDir>              offline verification of one record
 *
 * Exit codes: 0 pass/clean, 1 defect demonstrated, 2 no proof
 * (refused/incomplete/invalid). Missing credentials or absent ingress
 * evidence on the primary-mic journey is 2 — never a green skip.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The shipped-scheduler replay and the browser probe pull in CLIENT source
// (client/src/lib/voiceLive/**), which reads import.meta.env at module scope
// and therefore only loads inside Vite/Playwright contexts. They are imported
// lazily by the commands that need them (types are erased at runtime) so every
// other command runs on plain tsx.
import type { CapturedAudioChunk, PageFacts } from './lib/oracle.js';
import { captureLane, DEFAULT_QUESTION } from './lib/capture.js';
import { loadCorpus } from './lib/corpus.js';
import {
  VOICE_PROFILES,
  buildVoiceProfile,
} from './lib/voices.js';
import {
  planCaptureProof,
  planHash,
  runCaptureProof,
} from './lib/built-app.js';
import {
  journeyPlan,
  journeyPlanHash,
  armServerEnv,
  ARM_LABELS,
  TTS_MODES,
  type ArmLabel,
  type TtsMode,
} from './lib/journey-plan.js';
import { runJourney } from './lib/journey-run.js';
import {
  newCampaignIndex,
} from './lib/campaign.js';
import { verifyRecord, exitCodeFor } from './lib/verifier.js';
import { freezeFixtureManifest } from '../voice-live-lab/lib/fixtures.js';

const CAPTURE_VERSION = 'voice-lane-lab.capture/1';

function writeOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** Fold a capture into the oracle's input, running the shipped scheduler over it. */
async function measure(captureDir: string): Promise<{ verdict: Awaited<ReturnType<typeof analyseLaneAudio>>; detail: Record<string, unknown> }> {
  const { analyseLaneAudio } = await import('./lib/oracle.js');
  const { runShippedScheduler } = await import('./lib/schedule.js');
  const chunksPath = path.join(captureDir, 'chunks.json');
  const framesPath = path.join(captureDir, 'frames.ndjson');
  if (!existsSync(chunksPath)) throw new Error(`no capture at ${captureDir} (chunks.json missing)`);

  const records = JSON.parse(readFileSync(chunksPath, 'utf8')) as Array<{
    seq: number;
    arrivedAtMs: number;
    declaredDurationMs: number;
    mimeType: string;
    sampleCount: number;
    sha256: string;
    pcmPath: string;
  }>;

  const arrived = records.map((record) => {
    // A capture is portable: a relative payload path is resolved against the
    // capture directory, so a committed record can be re-analysed offline.
    const pcmPath = path.isAbsolute(record.pcmPath) ? record.pcmPath : path.join(captureDir, record.pcmPath);
    const bytes = readFileSync(pcmPath);
    const samples = new Float32Array(bytes.byteLength / 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32768;
    return {
      seq: record.seq,
      arrivedAtMs: record.arrivedAtMs,
      samples,
      mimeType: record.mimeType,
      declaredDurationMs: record.declaredDurationMs,
    };
  });

  const run = await runShippedScheduler(arrived, { realTime: process.env.LANE_LAB_FAST !== '1' });

  // Page facts: this run is a protocol client, not a browser, so it says exactly
  // that rather than claiming a page it never had. A browser run supplies these
  // from the page itself (see the oracle's doc block).
  const laneIds = new Set<string>();
  if (existsSync(framesPath)) {
    for (const line of readFileSync(framesPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { frame?: { laneId?: unknown; type?: unknown } };
        if (entry.frame?.type === 'voice_audio_chunk' && typeof entry.frame.laneId === 'string') laneIds.add(entry.frame.laneId);
      } catch {
        /* a malformed frame line is not a measurement */
      }
    }
  }
  const page: PageFacts = {
    audioContexts: 0,
    mountedLaneSurfaces: 0,
    laneIds: [...laneIds],
  };

  const chunks: CapturedAudioChunk[] = records.map((record) => ({
    seq: record.seq,
    arrivedAtMs: record.arrivedAtMs,
    declaredDurationMs: record.declaredDurationMs,
    actualDurationMs: (record.sampleCount / 24_000) * 1000,
    sha256: record.sha256,
    mimeType: record.mimeType,
  }));

  const verdict = analyseLaneAudio({
    chunks,
    schedule: run.schedule,
    strandedSeqs: run.strandedSeqs,
    droppedChunks: run.droppedChunks,
    faults: run.faults,
    page,
  });

  return {
    verdict,
    detail: {
      captureVersion: CAPTURE_VERSION,
      scheduler: {
        module: 'client/src/lib/voiceLive/playbackSession.ts',
        // The evidence is anchored to the exact scheduler source that produced it.
        sourceSha256: sha256Of('client/src/lib/voiceLive/playbackSession.ts'),
        scheduled: run.schedule.length,
        strandedSeqs: run.strandedSeqs,
        droppedChunks: run.droppedChunks,
        faults: run.faults,
        peakQueuedMs: run.maxQueuedMs,
      },
      page,
    },
  };
}

function sha256Of(relativePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(path.join(process.cwd(), relativePath))).digest('hex');
  } catch {
    return 'unavailable';
  }
}


/** Collect repeated --server-env KEY=VALUE entries. */
function collectServerEnv(argv: string[]): string[] {
  const entries: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--server-env') {
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) entries.push(value);
    }
  }
  return entries;
}

function doctor(): number {
  const lines: string[] = ['# Voice Lane Lab doctor', ''];
  let ok = true;
  const key = process.env.GEMINI_API_KEY;
  lines.push(`${key && key.trim() ? 'PASS' : 'FAIL'}  GEMINI_API_KEY present (needed for a measured lane run)`);
  if (!key || !key.trim()) ok = false;
  const dist = path.join(process.cwd(), 'server', 'dist', 'index.js');
  lines.push(`${existsSync(dist) ? 'PASS' : 'FAIL'}  compiled server present (npm run build)`);
  if (!existsSync(dist)) ok = false;
  const display = process.env.DISPLAY;
  lines.push(`${display ? 'PASS' : 'INFO'}  DISPLAY=${display ?? '(none)'} — this lane needs no browser`);
  lines.push('INFO  OS-output capture (PulseAudio null sink) is the audio regression lab\'s lane:');
  lines.push('      `npx tsx scripts/audio-lab/cli.ts doctor` → capture:chain FAIL on this host.');
  lines.push('      This lane therefore measures the product\'s own schedule, not OS-rendered audio.');
  writeOut(lines.join('\n'));
  return ok ? 0 : 2;
}

const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus');
const VOICES_ROOT = '/root/voice-lane-lab/fixtures';
const RECORDS_ROOT = '/root/voice-lane-lab';

/** Phase 1: synthesise + ASR-validate + freeze the two corpus voices. */
async function voicesCommand(argv: string[]): Promise<number> {
  const whisper = flag(argv, '--whisper') ?? 'http://localhost:9000';
  const corpus = loadCorpus();
  const failures: string[] = [];
  for (const profile of VOICE_PROFILES) {
    const outDir = path.join(VOICES_ROOT, profile.id);
    const commitPath0 = path.join(CORPUS_DIR, 'voices', `${profile.id}.manifest.json`);
    if (existsSync(commitPath0)) {
      writeOut(`voice ${profile.id}: already frozen (${commitPath0}) — skipping`);
      continue;
    }
    writeOut(`voice ${profile.id}: ${profile.description} (${profile.supertonic.voice}, speed ${profile.supertonic.speed}, silence ${profile.supertonic.silence})`);
    try {
      const build = await buildVoiceProfile(profile, corpus, { outDir, whisperBaseUrl: whisper, log: (line) => writeOut(`  ${line}`) });
      if (!build.verification.ok) {
        failures.push(`${profile.id}: ${build.verification.problems.join('; ')}`);
        continue;
      }
      // Freeze the working manifest once (audio + hashes live outside Git).
      freezeFixtureManifest(outDir, build.manifest);
      // Commit-copy: provenance + hashes in-repo (real audio stays outside).
      const commitDir = path.join(CORPUS_DIR, 'voices');
      mkdirSync(commitDir, { recursive: true, mode: 0o755 });
      const sanitised = {
        profileId: profile.id,
        description: profile.description,
        speechLabel: profile.speechLabel,
        supertonic: profile.supertonic,
        schemaVersion: build.manifest.schemaVersion,
        provider: build.manifest.provider,
        model: build.manifest.model,
        voice: build.manifest.voice,
        synthesis: build.manifest.synthesis,
        corpusHash: build.manifest.corpusHash,
        audioRoot: outDir,
        fixtures: build.manifest.fixtures.map((fixture) => ({
          id: fixture.id,
          text: fixture.text,
          pcm16kSha256: fixture.pcm16kSha256,
          pcm16kPath: fixture.pcm16kPath,
          masterWavPath: fixture.masterWavPath,
          durationMs: fixture.durationMs,
          asr: build.verification.verdicts.find((verdict) => verdict.id === fixture.id) ?? null,
        })),
      };
      const commitPath = path.join(commitDir, `${profile.id}.manifest.json`);
      if (existsSync(commitPath)) throw new Error(`refusing to overwrite frozen commit-copy: ${commitPath}`);
      writeFileSync(commitPath, `${JSON.stringify(sanitised, null, 2)}\n`, { mode: 0o644 });
      writeOut(`  frozen: ${commitPath}`);
    } catch (error) {
      failures.push(`${profile.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    writeErr(`voice validation FAILED:\n  ${failures.join('\n  ')}`);
    return 2;
  }
  writeOut('both voices validated (WER ≤ 0.08, required words present) and frozen');
  return 0;
}

/** Phase 1: built-app primary-control capture proof. */
async function builtAppCommand(argv: string[]): Promise<number> {
  const episodeId = flag(argv, '--episode') ?? 'C01';
  const dryRun = argv.includes('--dry-run');
  const profileId = flag(argv, '--voice') ?? 'voice-a';
  if (argv.includes('--server-mode')) {
    process.env.VOICE_LAB_SERVER_MODE = flag(argv, '--server-mode') ?? 'compiled';
  }
  const corpus = loadCorpus();
  let plan;
  try {
    plan = planCaptureProof(episodeId, { corpus, corpusDir: CORPUS_DIR, profileId });
  } catch (error) {
    writeErr(String(error instanceof Error ? error.message : error));
    return 2;
  }
  if (dryRun) {
    writeOut(JSON.stringify({ ...plan, planHash: planHash(plan) }, null, 2));
    writeOut('');
    writeOut(`dry-run plan OK: ${plan.episodeId} utterance "${plan.utterance.text}" via ${plan.utterance.voiceProfileId}`);
    writeOut('no browser, no server, no network — a dry run proves the plan, not the capture');
    return 0;
  }
  const result = await runCaptureProof(plan, {
    repoRoot: process.cwd(),
    corpus,
    corpusDir: CORPUS_DIR,
    recordsRoot: RECORDS_ROOT,
    authPassword: process.env.VOICE_LAB_AUTH_PASSWORD ?? 'voice-lab-disposable',
    log: writeOut,
  });
  writeOut(`capture proof: ${result.ok ? 'OK' : 'FAILED'} — ${result.detail}`);
  return result.ok ? 0 : 2;
}

/**
 * The named `primary-mic` browser journey (child J; plan §11 Phase 2).
 * Exit: 0 pass, 1 demonstrated failure (verifier), 2 incomplete/invalid —
 * including missing child-server credentials and absent ingress evidence.
 */
async function primaryMicCommand(argv: string[]): Promise<number> {
  const episodeId = flag(argv, '--episode');
  const arm = flag(argv, '--arm') ?? 'standard';
  const dryRun = argv.includes('--dry-run');
  const serverEnvEntries = collectServerEnv(argv);
  // Child J3: --tts is EXPLICIT and default-off. "real" (or no flag) is the
  // unchanged journey; "synthetic" installs the labelled read-back shim.
  // Anything else is refused before any plan or record exists.
  const ttsArg = flag(argv, '--tts');
  if (ttsArg !== undefined && !TTS_MODES.includes(ttsArg as TtsMode)) {
    writeErr(`--tts must be one of ${TTS_MODES.join('|')} (explicit; default real = unchanged journey with no shim), got: "${ttsArg}"`);
    return 2;
  }
  const tts = ttsArg === 'synthetic' ? 'synthetic' : undefined;
  const corpus = loadCorpus();
  let plan;
  try {
    if (!episodeId) throw new Error('--episode <id> is required (a corpus episode, not a holdout)');
    plan = journeyPlan(episodeId, { corpus, corpusDir: CORPUS_DIR, arm, tts });
  } catch (error) {
    writeErr(String(error instanceof Error ? error.message : error));
    return 2;
  }
  if (dryRun) {
    writeOut(JSON.stringify({ ...plan, planHash: journeyPlanHash(plan) }, null, 2));
    writeOut('');
    writeOut(`dry-run journey plan OK: ${plan.episodeId} arm=${plan.arm} tts=${plan.tts ?? 'real'} turns=${plan.turns.length} modes=${plan.turns.map((turn) => turn.inputMode).join(',')}`);
    writeOut('no browser, no server, no network — a dry run proves the plan, not the journey');
    return 0;
  }
  const result = await runJourney(plan, {
    repoRoot: process.cwd(),
    corpus,
    corpusDir: CORPUS_DIR,
    recordsRoot: RECORDS_ROOT,
    campaignId: 'primary-mic-journeys',
    authPassword: process.env.VOICE_LAB_AUTH_PASSWORD ?? 'voice-lab-disposable',
    serverEnv: armServerEnv(arm, serverEnvEntries),
    log: writeOut,
  });
  writeOut(`journey: ${result.outcome} — ${result.detail}`);
  // The VERDICT is the offline verifier's, from the raw record — never the
  // runner's own word.
  const outcome = verifyRecord(result.attemptDir, { corpus });
  for (const line of outcome.lines) writeOut(`  ${line}`);
  for (const problem of outcome.problems) writeOut(`  PROBLEM ${problem.code}: ${problem.detail}`);
  writeOut(`verifier verdict: ${outcome.verdict}`);
  const code = exitCodeFor(outcome);
  if (result.outcome === 'incomplete' && code === 0) {
    writeErr('the runner reported incomplete evidence but the verifier passed — refusing to exit 0');
    return 2;
  }
  return code;
}

/** Offline verification of an attempt record (exit 0/1/2). */
function verifyCommand(argv: string[]): number {
  const dir = argv[1];
  if (!dir) {
    writeErr('verify needs an attempt directory');
    return 2;
  }
  const outcome = verifyRecord(dir, { corpus: loadCorpus() });
  for (const line of outcome.lines) writeOut(`  ${line}`);
  for (const problem of outcome.problems) writeOut(`  PROBLEM ${problem.code}: ${problem.detail}`);
  writeOut(`verdict: ${outcome.verdict}`);
  return exitCodeFor(outcome);
}

/**
 * Campaign runner CLI (child J; plan §8/§9). `--plan --dry-run` enumerates
 * the §8 matrix and validates the index shape with no server and no provider
 * calls. Real execution walks the paired execution order one heavy runner at
 * a time, resume-safe via the campaign index.
 */
function campaignCommand(argv: string[]): number {
  const armsArg = flag(argv, '--arms') ?? 'standard,et-high';
  const arms = armsArg.split(',').map((arm) => arm.trim()).filter(Boolean) as ArmLabel[];
  for (const arm of arms) {
    if (!ARM_LABELS.includes(arm)) {
      writeErr(`unknown arm "${arm}" — expected one of ${ARM_LABELS.join(', ')}`);
      return 2;
    }
  }
  const serverEnvEntries = collectServerEnv(argv);
  let serverEnv: Record<string, string>;
  try {
    serverEnv = armServerEnv(arms[0], serverEnvEntries);
    void serverEnv;
  } catch (error) {
    writeErr(String(error instanceof Error ? error.message : error));
    return 2;
  }
  const corpus = loadCorpus();
  const campaignId = flag(argv, '--campaign-id') ?? `matrix-${arms.join('-')}`;
  const seed = Number(flag(argv, '--seed') ?? 20260922);
  const includeExtend = argv.includes('--include-extend');
  const includeNoise = argv.includes('--include-noise');
  const budgetExhausted = argv.includes('--budget-exhausted') || process.env.VOICE_LAB_BUDGET_EXHAUSTED === '1';
  const maxCells = Number(flag(argv, '--max-cells') ?? 0);

  if (argv.includes('--plan') && argv.includes('--dry-run')) {
    const index = newCampaignIndex({ campaignId, corpus, arms, seed });
    const byStratum = (stratum: string) => index.cells.filter((cell) => cell.stratum === stratum);
    writeOut(`campaign ${campaignId}: seed ${seed}, arms ${arms.join('+')}`);
    for (const stratum of ['core', 'holdout', 'soak', 'extend', 'noise']) {
      const cells = byStratum(stratum);
      writeOut(`  ${stratum.padEnd(8)} ${String(cells.length).padStart(3)} cells (${arms.map((arm) => cells.filter((cell) => cell.arm === arm).length).join(' + ')} per arm)`);
    }
    writeOut(`  total    ${String(index.cells.length).padStart(3)} cells; required (core+holdout+soak): ${index.requiredCellCount}`);
    const gated = index.cells.filter((cell) => cell.gate !== null);
    writeOut(`  validator/runner-gated cells: ${gated.length}`);
    for (const cell of gated.slice(0, 12)) writeOut(`    ${cell.cellId}${cell.gate === 'validator-frozen' ? ' [validator-gated]' : ` [${cell.gate}]`}`);
    if (gated.length > 12) writeOut(`    … and ${gated.length - 12} more`);
    writeOut(`  execution order (first 8): ${index.executionOrderCellIds.slice(0, 8).join(' → ')}`);
    writeOut('dry-run: no index written, no server, no provider calls');
    return 0;
  }

  if (argv.includes('--plan') || argv.includes('--dry-run')) {
    writeErr('combine --plan with --dry-run for the no-network validation, or drop both to execute');
    return 2;
  }

  writeErr('live campaign execution is conductor-gated (plan §11 Phase 5): only --plan --dry-run is enabled in this build');
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help') {
    writeOut(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 30).map((line) => line.replace(/^ \* ?/, '')).join('\n'));
    return 0;
  }
  if (command === 'doctor') return doctor();

  if (command === 'run') {
    const outDir = flag(argv, '--out') ?? path.join('/root/voice-lane-lab', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const question = flag(argv, '--question') ?? DEFAULT_QUESTION;
    const listenMs = Number(flag(argv, '--listen-ms') ?? 65_000);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const log = argv.includes('--json') ? () => {} : writeOut;
    try {
      const capture = await captureLane({ repoRoot: process.cwd(), outDir, question, listenMs, log });
      const result = await measure(outDir);
      writeFileSync(
        path.join(outDir, 'measurement.json'),
        JSON.stringify(
          {
            captureVersion: CAPTURE_VERSION,
            workerSessionId: capture.workerSessionId,
            laneId: capture.laneId,
            operatorQuestion: capture.operatorQuestion,
            transcripts: capture.transcripts,
            events: capture.events,
            ...result.detail,
            verdict: result.verdict,
          },
          null,
          2
        ) + '\n'
      );
      if (argv.includes('--json')) {
        writeOut(JSON.stringify({ outDir, ...result.verdict }, null, 2));
      } else {
        writeOut('');
        writeOut(`verdict: ${result.verdict.verdict}`);
        for (const finding of result.verdict.findings) writeOut(`  - ${finding.code}: ${finding.detail}`);
        writeOut(`summary: ${JSON.stringify(result.verdict.summary)}`);
        writeOut(`evidence: ${outDir}`);
      }
      return result.verdict.verdict === 'clean' ? 0 : 1;
    } catch (error) {
      writeErr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === 'analyse') {
    const dir = argv[1];
    if (!dir) {
      writeErr('analyse needs a capture directory');
      return 2;
    }
    try {
      const result = await measure(dir);
      writeOut(JSON.stringify(result.verdict, null, 2));
      return result.verdict.verdict === 'clean' ? 0 : 1;
    } catch (error) {
      writeErr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === 'browser') {
    // The same capture, played by the same scheduler, inside a real browser's audio
    // graph. Needs a dev server serving the dev lab page (`client/voice-live-lab.html`).
    const dir = flag(argv, '--capture') ?? argv.find((arg) => !arg.startsWith('--') && existsSync(path.join(arg, 'chunks.json')));
    if (!dir) {
      writeErr('browser needs --capture <captureDir> (a directory with chunks.json)');
      return 2;
    }
    const appUrl = flag(argv, '--url') ?? 'http://127.0.0.1:5273/client/voice-live-lab.html';
    try {
      const rows = JSON.parse(readFileSync(path.join(dir, 'chunks.json'), 'utf8')) as Array<{
        seq: number;
        arrivedAtMs: number;
        declaredDurationMs: number;
        mimeType: string;
        data?: string;
        pcmPath?: string;
      }>;
      const settleMs = Number(flag(argv, '--settle-ms') ?? 25_000);
      const { gradeBrowserRun, probeInBrowser } = await import('./lib/browser-probe.js');
      const probe = await probeInBrowser({ captureDir: dir, appUrl, settleMs, log: writeOut });
      const verdict = gradeBrowserRun({ chunks: rows }, probe, dir);
      writeFileSync(
        path.join(dir, 'browser-measurement.json'),
        JSON.stringify({ captureVersion: CAPTURE_VERSION, appUrl, probe: { audioContexts: probe.audioContexts, booked: probe.booked.length, playback: probe.playback, faults: probe.faults }, verdict }, null, 2) + '\n'
      );
      writeOut('');
      writeOut(`browser verdict: ${verdict.verdict}`);
      for (const finding of verdict.findings) writeOut(`  - ${finding.code}: ${finding.detail}`);
      writeOut(`summary: ${JSON.stringify(verdict.summary)}`);
      writeOut(`AudioContexts created by the page: ${probe.audioContexts}`);
      return verdict.verdict === 'clean' ? 0 : 1;
    } catch (error) {
      writeErr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === 'voices') {
    return await voicesCommand(argv);
  }
  if (command === 'built-app') {
    return await builtAppCommand(argv);
  }
  if (command === 'primary-mic') {
    return await primaryMicCommand(argv);
  }
  if (command === 'campaign') {
    return campaignCommand(argv);
  }
  if (command === 'verify') {
    return verifyCommand(argv.slice(0));
  }

  if (command === 'list') {
    const root = '/root/voice-lane-lab';
    if (!existsSync(root)) {
      writeOut('no runs yet');
      return 0;
    }
    for (const entry of readdirSync(root)) writeOut(entry);
    return 0;
  }

  writeErr(`unknown command: ${command}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    writeErr(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(2);
  });
