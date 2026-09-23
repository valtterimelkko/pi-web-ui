/**
 * L0 fixture tests.
 *
 * Fixtures are where an evaluator's intent becomes acoustic ground truth, so
 * the tests pin the two ways that can go wrong: the derivation (mastering,
 * resampling, PCM conversion) and the verification gate (WER ≤ 0.08 with every
 * required word present). Synthesis is injected so the suite stays hermetic —
 * no Python, no Whisper, no network — while exercising the real derivation.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { encodeWavPcm16 } from '../../../scripts/audio-lab/lib/wav.js';
import {
  DEFAULT_MAX_WER,
  INPUT_SAMPLE_RATE,
  MASTER_SAMPLE_RATE,
  corpusHash,
  createWhisperAsrClient,
  floatToPcm16le,
  freezeFixtureManifest,
  normaliseWords,
  pcm16leToFloat,
  resampleLinear,
  synthesiseFixtures,
  verifyFixture,
  verifyFixtureManifest,
  verifyFixtureSet,
  wavFromPcm16,
  wordErrorRate,
  type FixtureSpec,
  type SynthesisRunner,
} from '../../../scripts/voice-live-lab/lib/fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'voice-live-fixtures-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a raw 44.1 kHz mono WAV, as the Supertonic tool would. */
function writeRawWav(filePath: string, seconds: number): void {
  const frames = Math.round(44100 * seconds);
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) samples[index] = Math.sin(index / 20) * 0.5;
  writeFileSync(filePath, encodeWavPcm16({ channels: [samples], sampleRate: 44100, frames }));
}

const runner: SynthesisRunner = async (specs, outDir) => {
  for (const spec of specs) writeRawWav(path.join(outDir, `${spec.id}.wav`), 0.1);
};

const SPECS: FixtureSpec[] = [
  { id: 'u0', text: 'Please read the current state.', requiredWords: ['current', 'state'] },
];

describe('word error rate', () => {
  it('normalises case, punctuation and apostrophes', () => {
    expect(normaliseWords("Don't change the plan, please!")).toEqual(['dont', 'change', 'the', 'plan', 'please']);
  });

  it('is 0 for an exact match and 1 when every reference word is lost', () => {
    const text = 'send the summary not the transcript';
    expect(wordErrorRate(text, text)).toBe(0);
    expect(wordErrorRate(text, '')).toBe(1);
    expect(wordErrorRate('', '')).toBe(0);
    expect(DEFAULT_MAX_WER).toBe(0.08);
  });

  it('counts substitutions over the reference length', () => {
    const wer = wordErrorRate('alpha beta gamma delta', 'alpha beta gamma omega');
    expect(wer).toBeCloseTo(0.25, 6);
  });
});

describe('derivation', () => {
  it('resamples 44.1 kHz → 24 kHz → 16 kHz with the right frame counts', () => {
    const input = new Float32Array(4410).fill(0.25);
    const master = resampleLinear(input, 44100, MASTER_SAMPLE_RATE);
    expect(master).toHaveLength(2400);
    const pcm16k = resampleLinear(master, MASTER_SAMPLE_RATE, INPUT_SAMPLE_RATE);
    expect(pcm16k).toHaveLength(1600);
    for (const sample of pcm16k) expect(sample).toBeCloseTo(0.25, 5);
  });

  it('returns a copy unchanged when the rates match', () => {
    const input = new Float32Array([1, 2, 3]);
    const output = resampleLinear(input, 16000, 16000);
    expect(Array.from(output)).toEqual([1, 2, 3]);
    expect(output).not.toBe(input);
  });

  it('converts PCM16 both ways within one quantisation step', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = floatToPcm16le(samples);
    expect(pcm.byteLength).toBe(10);
    const roundTrip = pcm16leToFloat(pcm);
    for (let index = 0; index < samples.length; index += 1) {
      expect(Math.abs(roundTrip[index] - samples[index])).toBeLessThan(1 / 32000);
    }
    expect(() => pcm16leToFloat(Buffer.alloc(3))).toThrow(/even/);
  });

  it('wraps PCM in a valid WAV for the ASR endpoint', () => {
    const wav = wavFromPcm16(Buffer.alloc(320), INPUT_SAMPLE_RATE);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(INPUT_SAMPLE_RATE);
  });
});

describe('ASR gate', () => {
  it('passes an exact transcript and fails one above the WER ceiling', () => {
    const fixture = { id: 'u0', text: 'send the summary not the transcript', requiredWords: ['not'] };
    const exact = verifyFixture(fixture, { text: 'Send the summary, not the transcript.' });
    expect(exact.ok).toBe(true);
    expect(exact.wer).toBe(0);

    const mangled = verifyFixture(fixture, { text: 'send the summary and the transcript' });
    expect(mangled.ok).toBe(false);
    expect(mangled.wer).toBeGreaterThan(DEFAULT_MAX_WER);
    expect(mangled.reason).toMatch(/WER/);
  });

  it('treats the 0.08 ceiling as inclusive', () => {
    const text = Array.from({ length: 100 }, (_, index) => `w${index}`).join(' ');
    const hypothesis = Array.from({ length: 100 }, (_, index) => (index < 8 ? `x${index}` : `w${index}`)).join(' ');
    expect(wordErrorRate(text, hypothesis)).toBeCloseTo(0.08, 6);
    expect(verifyFixture({ id: 'u0', text, requiredWords: [] }, { text: hypothesis }).ok).toBe(true);
  });

  it('fails when a required word is missing even if the WER looks acceptable', () => {
    const words = Array.from({ length: 100 }, (_, index) => (index === 7 ? 'confirm' : `w${index}`));
    const reference = words.join(' ');
    const hypothesis = words.filter((_, index) => index !== 7).join(' ');
    const verdict = verifyFixture({ id: 'u0', text: reference, requiredWords: ['confirm'] }, { text: hypothesis });
    expect(verdict.wer).toBeLessThanOrEqual(DEFAULT_MAX_WER);
    expect(verdict.missingWords).toContain('confirm');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/required words/);
  });
});

describe('whisper ASR client', () => {
  it('posts multipart audio to the documented endpoint with the documented query', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const stub = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ text: 'hello world' }) } as Response;
    }) as typeof fetch;

    const client = createWhisperAsrClient({ baseUrl: 'http://127.0.0.1:9000/', fetchImpl: stub });
    const result = await client(Buffer.alloc(64));
    expect(result.text).toBe('hello world');
    expect(capturedUrl).toBe(
      'http://127.0.0.1:9000/asr?output=json&task=transcribe&language=en&word_timestamps=true'
    );
    expect(capturedInit?.method).toBe('POST');
    const body = capturedInit?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('audio_file')).toBeTruthy();
  });

  it('throws on a non-200 response', async () => {
    const stub = (async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'Service Unavailable' }) as Response) as typeof fetch;
    const client = createWhisperAsrClient({ baseUrl: 'http://127.0.0.1:9000', fetchImpl: stub });
    await expect(client(Buffer.alloc(64))).rejects.toThrow(/HTTP 503/);
  });
});

describe('synthesis and freezing', () => {
  it('masters at 24 kHz, derives 16 kHz PCM, hashes the bytes and freezes once', async () => {
    const outDir = path.join(dir, 'corpus');
    const manifest = await synthesiseFixtures({ outDir, specs: SPECS, synthesisRunner: runner });

    expect(manifest.provider).toBe('supertonic');
    expect(manifest.fixtures).toHaveLength(1);
    const fixture = manifest.fixtures[0];
    expect(fixture.masterSampleRate).toBe(MASTER_SAMPLE_RATE);
    expect(fixture.masterBytes).toBe(44 + 2400 * 2);
    expect(fixture.pcm16kBytes).toBe(1600 * 2);
    expect(fixture.durationMs).toBeCloseTo(100, 0);
    expect(fixture.masterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.corpusHash).toMatch(/^[0-9a-f]{64}$/);

    expect(verifyFixtureManifest(manifest)).toEqual([]);
    freezeFixtureManifest(outDir, manifest);
    expect(() => freezeFixtureManifest(outDir, manifest)).toThrow(/frozen/);

    writeFileSync(fixture.pcm16kPath, Buffer.alloc(3200));
    expect(verifyFixtureManifest(manifest).join('\n')).toMatch(/hash mismatch/);
  });

  it('changes the corpus hash when the text changes', () => {
    const a = corpusHash(SPECS, 'M1', 'supertonic-3');
    const b = corpusHash([{ id: 'u0', text: 'different words' }], 'M1', 'supertonic-3');
    expect(a).not.toBe(b);
  });

  it('verifies a whole fixture set through the injected ASR', async () => {
    const outDir = path.join(dir, 'corpus');
    const manifest = await synthesiseFixtures({ outDir, specs: SPECS, synthesisRunner: runner });

    const good = await verifyFixtureSet(manifest, { asr: async () => ({ text: SPECS[0].text }) });
    expect(good.ok).toBe(true);
    expect(good.verdicts[0].wer).toBe(0);

    const bad = await verifyFixtureSet(manifest, { asr: async () => ({ text: 'something else entirely' }) });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/fixture u0/);
  });

  it('reads back a frozen manifest from disk', async () => {
    const outDir = path.join(dir, 'corpus');
    const manifest = await synthesiseFixtures({ outDir, specs: SPECS, synthesisRunner: runner });
    freezeFixtureManifest(outDir, manifest);
    const read = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    expect(read.corpusHash).toBe(manifest.corpusHash);
  });
});
