/**
 * Speech fixture corpus for the voice-live lab (L0, plan §21, §23).
 *
 * The candidate must hear real speech, never a tone and never a marker wav
 * standing in for words, so fixtures are synthesised once with the local CPU
 * Supertonic path (`scripts/audio-lab/tools/supertonic-batch.py`), mastered at
 * 24 kHz mono, then derived to the 16 kHz signed-16le PCM the Live API accepts.
 *
 * Intended text is NOT acoustic ground truth by assertion: each fixture is
 * independently transcribed by the Whisper ASR container and must meet a word
 * error rate of 0.08 or better with every required word present. A synthetic
 * sentence that drops a negation or mangles an identifier is a bad fixture, not
 * a model failure — so the check is a gate, not a formality.
 *
 * Bytes are frozen with their SHA-256 and configuration; a changed sentence can
 * never reuse a stale recording. Real audio stays outside the repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeWav, encodeWavPcm16, toMono } from '../../audio-lab/lib/wav.js';
import { runTool } from '../../audio-lab/lib/audio-io.js';
import { sha256Bytes } from './record.js';

export const FIXTURE_SCHEMA_VERSION = 1;
export const MASTER_SAMPLE_RATE = 24000;
export const INPUT_SAMPLE_RATE = 16000;
export const DEFAULT_MAX_WER = 0.08;
export const DEFAULT_VOICE = 'M1';
export const DEFAULT_MODEL = 'supertonic-3';

export interface FixtureSpec {
  id: string;
  text: string;
  /** Words that must survive synthesis + ASR, e.g. a negated condition. */
  requiredWords?: string[];
}

export interface SynthesisedFixture {
  id: string;
  text: string;
  requiredWords: string[];
  masterWavPath: string;
  masterSampleRate: number;
  masterBytes: number;
  masterSha256: string;
  pcm16kPath: string;
  pcm16kBytes: number;
  pcm16kSha256: string;
  durationMs: number;
}

export interface FixtureManifest {
  schemaVersion: number;
  provider: 'supertonic';
  model: string;
  voice: string;
  createdAt: string;
  corpusHash: string;
  fixtures: SynthesisedFixture[];
}

export function corpusHash(specs: FixtureSpec[], voice: string, model: string): string {
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        schema: FIXTURE_SCHEMA_VERSION,
        provider: 'supertonic',
        voice,
        model,
        texts: specs.map((spec) => [spec.id, spec.text, spec.requiredWords ?? []]),
      }),
      'utf8'
    )
  );
}

// ---------------------------------------------------------------------------
// DSP: resampling and PCM conversion (pure, unit-testable)
// ---------------------------------------------------------------------------

/** Linear-interpolation resampler. Good enough for a fixture derivation, and
 *  deterministic — the plan requires the resampling to be logged, not hidden. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) throw new Error('Sample rates must be positive');
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let index = 0; index < outLength; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, input.length - 1);
    const fraction = position - lower;
    out[index] = input[lower] * (1 - fraction) + input[upper] * fraction;
  }
  return out;
}

export function floatToPcm16le(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  return buffer;
}

export function pcm16leToFloat(buffer: Buffer): Float32Array {
  if (buffer.byteLength % 2 !== 0) throw new Error('PCM16 buffer must have an even byte length');
  const samples = new Float32Array(buffer.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

/** Wrap mono PCM16 in a canonical RIFF/WAVE container, for the ASR endpoint. */
export function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  return encodeWavPcm16({ channels: [pcm16leToFloat(pcm)], sampleRate, frames: pcm.byteLength / 2 });
}

// ---------------------------------------------------------------------------
// Word error rate and ASR
// ---------------------------------------------------------------------------

export function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Levenshtein word error rate: substitutions + insertions + deletions over
 *  the reference length. 0 is perfect; 1 means every reference word was lost. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normaliseWords(reference);
  const hyp = normaliseWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const previous = new Array<number>(hyp.length + 1);
  for (let j = 0; j <= hyp.length; j += 1) previous[j] = j;
  for (let i = 1; i <= ref.length; i += 1) {
    const current = new Array<number>(hyp.length + 1);
    current[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= hyp.length; j += 1) previous[j] = current[j];
  }
  return previous[hyp.length] / ref.length;
}

export interface AsrResult {
  text: string;
  words?: string[];
}

export type AsrClient = (wav: Buffer) => Promise<AsrResult>;

/**
 * Whisper ASR client. Uses the local container (`POST /asr`) with the
 * documented query parameters and multipart `audio_file`.
 */
export function createWhisperAsrClient(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): AsrClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');
  return async (wav: Buffer): Promise<AsrResult> => {
    const url = `${base}/asr?output=json&task=transcribe&language=en&word_timestamps=true`;
    const form = new FormData();
    form.append('audio_file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'fixture.wav');
    const response = await fetchImpl(url, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`Whisper ASR failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { text?: string };
    return { text: body.text ?? '' };
  };
}

export interface FixtureVerification {
  id: string;
  text: string;
  transcript: string;
  wer: number;
  missingWords: string[];
  ok: boolean;
  reason?: string;
}

export function verifyFixture(
  fixture: Pick<SynthesisedFixture, 'id' | 'text' | 'requiredWords'>,
  asr: AsrResult,
  options: { maxWer?: number } = {}
): FixtureVerification {
  const maxWer = options.maxWer ?? DEFAULT_MAX_WER;
  const wer = wordErrorRate(fixture.text, asr.text);
  const spoken = new Set(normaliseWords(asr.text));
  const missingWords = fixture.requiredWords.filter((word) => !spoken.has(word.toLowerCase()));
  let reason: string | undefined;
  if (wer > maxWer) reason = `WER ${wer.toFixed(3)} exceeds ${maxWer}`;
  else if (missingWords.length > 0) reason = `required words missing: ${missingWords.join(', ')}`;
  return {
    id: fixture.id,
    text: fixture.text,
    transcript: asr.text,
    wer,
    missingWords,
    ok: reason === undefined,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Synthesis and freezing
// ---------------------------------------------------------------------------

export type SynthesisRunner = (
  specs: FixtureSpec[],
  outDir: string,
  voice: string,
  model: string
) => Promise<void>;

/** Default runner: the lab-owned Supertonic batch tool. */
async function runSupertonic(
  specs: FixtureSpec[],
  outDir: string,
  voice: string,
  model: string
): Promise<void> {
  const helper = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'audio-lab',
    'tools',
    'supertonic-batch.py'
  );
  const jobPath = path.join(outDir, 'job.json');
  writeFileSync(
    jobPath,
    `${JSON.stringify(
      {
        voice,
        model,
        steps: 8,
        speed: 1.05,
        silence: 0.05,
        lang: 'en',
        outDir,
        texts: specs.map((spec) => ({ id: spec.id, text: spec.text })),
      },
      null,
      2
    )}\n`
  );
  const result = await runTool('python3', [helper, jobPath], { timeoutMs: 1_800_000 });
  if (result.code !== 0) {
    throw new Error(`Supertonic synthesis failed (exit ${result.code}): ${result.stderr.slice(-2000)}`);
  }
}

export interface SynthesiseOptions {
  outDir: string;
  specs: FixtureSpec[];
  voice?: string;
  model?: string;
  synthesisRunner?: SynthesisRunner;
  log?: (message: string) => void;
}

export async function synthesiseFixtures(options: SynthesiseOptions): Promise<FixtureManifest> {
  const voice = options.voice ?? DEFAULT_VOICE;
  const model = options.model ?? DEFAULT_MODEL;
  const log = options.log ?? (() => {});
  const outDir = path.resolve(options.outDir);
  const rawDir = path.join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });

  const runner = options.synthesisRunner ?? runSupertonic;
  await runner(options.specs, rawDir, voice, model);

  const fixtures: SynthesisedFixture[] = [];
  for (const spec of options.specs) {
    const rawWav = path.join(rawDir, `${spec.id}.wav`);
    if (!existsSync(rawWav)) throw new Error(`Synthesis produced no wav for fixture ${spec.id}`);
    const decoded = decodeWav(readFileSync(rawWav));
    const mono = toMono(decoded);
    const masterSamples = resampleLinear(mono, decoded.sampleRate, MASTER_SAMPLE_RATE);
    const masterPath = path.join(outDir, `${spec.id}.master.wav`);
    const master = encodeWavPcm16({
      channels: [masterSamples],
      sampleRate: MASTER_SAMPLE_RATE,
      frames: masterSamples.length,
    });
    writeFileSync(masterPath, master, { mode: 0o600 });

    const inputSamples = resampleLinear(masterSamples, MASTER_SAMPLE_RATE, INPUT_SAMPLE_RATE);
    const pcm = floatToPcm16le(inputSamples);
    const pcmPath = path.join(outDir, `${spec.id}.pcm16k`);
    writeFileSync(pcmPath, pcm, { mode: 0o600 });

    fixtures.push({
      id: spec.id,
      text: spec.text,
      requiredWords: spec.requiredWords ?? [],
      masterWavPath: masterPath,
      masterSampleRate: MASTER_SAMPLE_RATE,
      masterBytes: master.byteLength,
      masterSha256: sha256Bytes(master),
      pcm16kPath: pcmPath,
      pcm16kBytes: pcm.byteLength,
      pcm16kSha256: sha256Bytes(pcm),
      durationMs: (masterSamples.length / MASTER_SAMPLE_RATE) * 1000,
    });
    log(
      `fixture ${spec.id}: ${masterSamples.length} samples @ ${MASTER_SAMPLE_RATE} Hz ` +
        `→ ${pcm.byteLength} bytes @ ${INPUT_SAMPLE_RATE} Hz`
    );
  }

  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    provider: 'supertonic',
    model,
    voice,
    createdAt: new Date().toISOString(),
    corpusHash: corpusHash(options.specs, voice, model),
    fixtures,
  };
}

export function fixtureManifestPath(outDir: string): string {
  return path.join(outDir, 'manifest.json');
}

/** Freeze the fixture manifest once. A changed corpus is a new directory. */
export function freezeFixtureManifest(outDir: string, manifest: FixtureManifest): string {
  const target = fixtureManifestPath(outDir);
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite a frozen fixture manifest: ${target}`);
  }
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export function readFixtureManifest(outDir: string): FixtureManifest {
  return JSON.parse(readFileSync(fixtureManifestPath(outDir), 'utf8')) as FixtureManifest;
}

/** Re-check that every frozen byte still matches its recorded hash. */
export function verifyFixtureManifest(manifest: FixtureManifest): string[] {
  const problems: string[] = [];
  for (const fixture of manifest.fixtures) {
    for (const [label, filePath, sha] of [
      ['master', fixture.masterWavPath, fixture.masterSha256],
      ['pcm16k', fixture.pcm16kPath, fixture.pcm16kSha256],
    ] as const) {
      if (!existsSync(filePath)) {
        problems.push(`missing ${label} file for ${fixture.id}: ${filePath}`);
        continue;
      }
      const actual = sha256Bytes(readFileSync(filePath));
      if (actual !== sha) problems.push(`hash mismatch for ${fixture.id} ${label}`);
    }
  }
  return problems;
}

export interface FixtureSetVerification {
  ok: boolean;
  verdicts: FixtureVerification[];
  problems: string[];
}

/** Transcribe every fixture with the independent ASR and apply the WER gate. */
export async function verifyFixtureSet(
  manifest: FixtureManifest,
  options: { asr: AsrClient; maxWer?: number }
): Promise<FixtureSetVerification> {
  const problems = verifyFixtureManifest(manifest);
  const verdicts: FixtureVerification[] = [];
  for (const fixture of manifest.fixtures) {
    const pcm = readFileSync(fixture.pcm16kPath);
    const wav = wavFromPcm16(pcm, INPUT_SAMPLE_RATE);
    const result = await options.asr(wav);
    const verdict = verifyFixture(
      { id: fixture.id, text: fixture.text, requiredWords: fixture.requiredWords },
      result,
      { maxWer: options.maxWer }
    );
    verdicts.push(verdict);
    if (!verdict.ok) problems.push(`fixture ${fixture.id}: ${verdict.reason ?? 'failed'}`);
  }
  return { ok: problems.length === 0, verdicts, problems };
}
