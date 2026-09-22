/**
 * Voice Mode vertical slice (plan Phase 5 / Track F) — real operator audio.
 *
 * The operator side of the slice must be GENUINE spoken audio (anti-cheat:
 * sine waves, markers and digital silence fail closed). This module reuses the
 * lab's own Supertonic fixture pipeline (`lib/fixtures.ts`) to synthesise the
 * scripted utterances into 16 kHz mono PCM16 fixtures and record their
 * SHA-256s — so the exact audio the slice streams is auditable after the run.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { synthesiseFixtures, INPUT_SAMPLE_RATE, type FixtureSpec, type SynthesisedFixture } from '../fixtures.js';

export interface OperatorUtterance {
  id: string;
  text: string;
  pcm: Buffer;
  pcmSha256: string;
  durationMs: number;
  /** Root-mean-square amplitude of the PCM, as an "is it really speech" check. */
  rms: number;
}

export interface OperatorFixtureSet {
  fixtures: Map<string, OperatorUtterance>;
  manifestPath: string;
  totalDurationMs: number;
}

/** Utterance script for the three Phase-5 scenarios (+ the negative control's audio needs). */
export const SLICE_UTTERANCES: Record<string, string> = {
  's1-turn1': 'I keep thinking about the retry handler.',
  's1-turn2': 'It should not drop the session token after the third attempt.',
  's1-turn3': 'Maybe the backoff timing is measured from the wrong point.',
  's1-turn4': 'What would you check first?',
  // 2026-09-22 (owner directive): the relay is MODEL-DRIVEN. The harness no
  // longer classifies transcripts, so the operator reaches the worker by
  // saying the trigger phrase and the talker calls `relay_to_worker`.
  's2-direct': 'Relay to worker: check the tests.',
  's2-confirm': 'Yes, send that.',
  // ASR robustness (2026-09-18): the live provider transcribed the first
  // fixture as "Yes and that." — a statement, so the (correct) classifier
  // never treated it as a confirmation and S2 failed without any product
  // fault. A human repeats themselves; the scenario now gets one repeat with
  // a different phrase, and EVERY attempt is reported by the check.
  's2-confirm-retry': 'Yes, go ahead.',
  's3-flag1': 'Relay to worker: check the logs for the retry.',
  's3-flag2': 'Relay to worker: update the changelog.',
  's3-confirm': 'Yes, send that.',
};

export function rmsOfPcm16(pcm: Buffer): number {
  if (pcm.byteLength < 2) return 0;
  const samples = pcm.byteLength / 2;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = pcm.readInt16LE(index * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface PrepareOperatorAudioOptions {
  outDir: string;
  log?: (line: string) => void;
  /** Optional cache: when every fixture already exists here, reuse it. */
  cacheDir?: string;
  voice?: string;
}

/**
 * Synthesise (or reuse) the scripted operator fixtures. Returns PCM16 16 kHz
 * mono buffers plus their digests; a fixture that is silent or missing throws
 * rather than letting the slice run on a broken operator leg.
 */
export async function prepareOperatorAudio(options: PrepareOperatorAudioOptions): Promise<OperatorFixtureSet> {
  const log = options.log ?? (() => {});
  const specs: FixtureSpec[] = Object.entries(SLICE_UTTERANCES).map(([id, text]) => ({ id, text }));
  const sourceDir = options.cacheDir && existsSync(path.join(options.cacheDir, 'manifest.json'))
    ? options.cacheDir
    : options.outDir;

  const manifest = await synthesiseFixtures({
    outDir: sourceDir,
    specs,
    ...(options.voice ? { voice: options.voice } : {}),
    log,
  });

  const byId = new Map<string, SynthesisedFixture>(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
  const fixtures = new Map<string, OperatorUtterance>();
  let totalDurationMs = 0;
  for (const spec of specs) {
    const entry = byId.get(spec.id);
    if (!entry) throw new Error(`operator fixture ${spec.id} was not synthesised`);
    const pcmPath = options.cacheDir && existsSync(path.join(options.cacheDir, entry.pcm16kPath.split(path.sep).pop() ?? ''))
      ? path.join(options.cacheDir, path.basename(entry.pcm16kPath))
      : entry.pcm16kPath;
    if (!existsSync(pcmPath)) throw new Error(`operator fixture PCM missing: ${pcmPath}`);
    const pcm = readFileSync(pcmPath);
    if (pcm.byteLength < 4_000) throw new Error(`operator fixture ${spec.id} is implausibly short (${pcm.byteLength} bytes)`);
    const rms = rmsOfPcm16(pcm);
    if (rms < 0.005) throw new Error(`operator fixture ${spec.id} is silent (rms=${rms.toFixed(5)}) — refusing to run on fake audio`);
    const durationMs = (pcm.byteLength / 2 / INPUT_SAMPLE_RATE) * 1000;
    totalDurationMs += durationMs;
    fixtures.set(spec.id, {
      id: spec.id,
      text: spec.text,
      pcm,
      pcmSha256: sha256(pcm),
      durationMs,
      rms,
    });
    log(`operator fixture ${spec.id}: ${durationMs.toFixed(0)}ms rms=${rms.toFixed(3)} sha256=${sha256(pcm).slice(0, 12)}`);
  }

  return { fixtures, manifestPath: path.join(sourceDir, 'manifest.json'), totalDurationMs };
}
