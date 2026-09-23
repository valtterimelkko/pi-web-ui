/**
 * Two synthetic operator voices for the corpus (Phase 1 item 4).
 *
 * The plan requires two intelligible voices with normal and moderately varied
 * rate/pause profiles, synthesised locally (Supertonic), validated by an
 * independent ASR pass with known-word/negation checks BEFORE freezing, and
 * labelled "synthetic speech based on real wording".
 *
 * These tests pin the profile table, the spec derivation from the corpus
 * (every non-holdout operator turn + frozen repair wording; holdout excluded
 * because its wording does not exist yet), and the validity gate. The live
 * synthesis + Whisper run is executed through the CLI, not here.
 */
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  VOICE_PROFILES,
  utteranceSpecsFromCorpus,
  evaluateFixtureSet,
  type AsrResult,
} from '../../../../scripts/voice-lane-lab/lib/voices.js';
import type { FixtureManifest } from '../../../../scripts/voice-live-lab/lib/fixtures.js';

const corpus = loadCorpus();

describe('the two voice profiles', () => {
  it('are exactly two: normal and moderately varied', () => {
    expect(VOICE_PROFILES).toHaveLength(2);
  });

  it('differ in rate and/or pause profile and carry frozen parameters', () => {
    const [a, b] = VOICE_PROFILES;
    expect(a.id).not.toBe(b.id);
    expect(a.supertonic.speed).not.toBe(b.supertonic.speed);
    expect(a.supertonic.silence).not.toBe(b.supertonic.silence);
    for (const profile of VOICE_PROFILES) {
      expect(profile.supertonic.voice).toMatch(/^[MF]\d$/);
      expect(profile.supertonic.model).toBe('supertonic-3');
      expect(profile.speechLabel).toBe('synthetic speech based on real wording');
    }
  });
});

describe('utterance specs from the corpus', () => {
  it('covers every non-holdout input turn plus frozen repair wording', () => {
    const specs = utteranceSpecsFromCorpus(corpus);
    const expectedTurns = corpus.episodes
      .filter((episode) => !episode.holdout)
      .flatMap((episode) => episode.inputTurns.filter((turn) => turn.text.trim() !== '').map((turn) => `${episode.id}-${turn.id}`));
    const expectedRepairs = corpus.episodes
      .filter((episode) => !episode.holdout)
      .flatMap((episode) =>
        episode.repairBranches.filter((branch) => branch.say).map((_, index) => `${episode.id}-repair-${index + 1}`)
      );
    const ids = specs.map((spec) => spec.id);
    for (const id of [...expectedTurns, ...expectedRepairs]) {
      expect(ids, id).toContain(id);
    }
    expect(specs.every((spec) => spec.text.trim().length > 0)).toBe(true);
  });

  it('excludes holdout wording entirely (the validator owns it)', () => {
    const specs = utteranceSpecsFromCorpus(corpus);
    expect(specs.some((spec) => spec.id.startsWith('C10-'))).toBe(false);
    expect(specs.some((spec) => spec.id.startsWith('C11-'))).toBe(false);
    expect(specs.some((spec) => spec.id.startsWith('C22-'))).toBe(false);
    expect(specs.some((spec) => spec.id.startsWith('C24-'))).toBe(false);
  });

  it('carries the ASR known-word requirements from the corpus turns', () => {
    const specs = utteranceSpecsFromCorpus(corpus);
    const c05 = specs.find((spec) => spec.id === 'C05-t1');
    expect(c05?.requiredWords).toContain('not');
    expect(c05?.requiredWords).toContain('until');
  });
});

describe('the fixture validity gate', () => {
  const fakeManifest = (specTexts: Record<string, string>): FixtureManifest =>
    ({
      schemaVersion: 1,
      provider: 'supertonic',
      model: 'supertonic-3',
      voice: 'M1',
      createdAt: new Date().toISOString(),
      corpusHash: 'x',
      fixtures: Object.entries(specTexts).map(([id, text]) => ({
        id,
        text,
        requiredWords: [],
        masterWavPath: `/tmp/${id}.master.wav`,
        masterSampleRate: 24_000,
        masterBytes: 1,
        masterSha256: '0',
        pcm16kPath: `/tmp/${id}.pcm16k`,
        pcm16kBytes: 1,
        pcm16kSha256: '0',
        durationMs: 1_000,
      })),
    }) as unknown as FixtureManifest;

  it('a transcript that loses a required word marks the fixture invalid', async () => {
    const manifest = fakeManifest({ 'C05-t1': 'Investigate the flaky checkout test' });
    const asr = async (): Promise<AsrResult> => ({ text: 'investigate the flaky checkout test but do not change anything' });
    // requiredWords survive in the manifest fixtures only when specified; here
    // the WER gate against the intended text is what must fail.
    const outcome = await evaluateFixtureSet(manifest, { asr, specs: [{ id: 'C05-t1', text: 'Investigate the flaky checkout test, but do not change anything until I approve.', requiredWords: ['not', 'until'] }] });
    expect(outcome.ok).toBe(false);
    const verdict = outcome.verdicts[0];
    expect(verdict.missingWords).toContain('until');
  });

  it('a faithful transcript passes', async () => {
    const text = 'Investigate the flaky checkout test, but do not change anything until I approve.';
    const manifest = fakeManifest({ 'C05-t1': text });
    const asr = async (): Promise<AsrResult> => ({ text });
    const outcome = await evaluateFixtureSet(manifest, { asr, specs: [{ id: 'C05-t1', text, requiredWords: ['not', 'until'] }] });
    expect(outcome.ok).toBe(true);
    expect(outcome.verdicts[0].wer).toBeLessThanOrEqual(0.08);
  });
});
