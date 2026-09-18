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
 *
 * Exit codes: 0 clean, 1 defect demonstrated, 2 no proof (refused/incomplete).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { captureLane, DEFAULT_QUESTION } from './lib/capture.js';
import { runShippedScheduler } from './lib/schedule.js';
import { analyseLaneAudio, type CapturedAudioChunk, type PageFacts } from './lib/oracle.js';

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
async function measure(captureDir: string): Promise<{ verdict: ReturnType<typeof analyseLaneAudio>; detail: Record<string, unknown> }> {
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
    const bytes = readFileSync(record.pcmPath);
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
