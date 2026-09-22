/**
 * The corpus's two synthetic operator voices (native-primary plan §5.1).
 *
 * Both voices are LOCAL Supertonic synthesis over the corpus's exact wording,
 * with distinct rate/pause profiles:
 *
 *   voice-a — M1, normal rate, short pauses (the established lab profile);
 *   voice-b — F5, moderately slower rate, longer pauses.
 *
 * Every fixture is validated BEFORE freezing: an independent Whisper ASR pass
 * must transcribe it at WER ≤ 0.08 with every required word present (the
 * negations, names and numbers the corpus declares). Any disagreement makes
 * the fixture invalid until re-synthesised. All fixtures are labelled
 * "synthetic speech based on real wording" — the labels travel with the
 * manifests and with every attempt record that uses them.
 */

import { readFileSync } from 'node:fs';

import {
  createWhisperAsrClient,
  synthesiseFixtures,
  verifyFixture,
  verifyFixtureSet,
  type AsrClient,
  type AsrResult,
  type FixtureManifest,
  type FixtureSpec,
  type FixtureSetVerification,
  type SynthesisedFixture,
} from '../../voice-live-lab/lib/fixtures.js';
import type { LoadedCorpus } from './corpus.js';

export interface VoiceProfile {
  id: 'voice-a' | 'voice-b';
  description: string;
  speechLabel: 'synthetic speech based on real wording';
  supertonic: { voice: string; model: string; speed: number; silence: number; steps: number };
}

export const VOICE_PROFILES: VoiceProfile[] = [
  {
    id: 'voice-a',
    description: 'normal rate, short pauses',
    speechLabel: 'synthetic speech based on real wording',
    supertonic: { voice: 'M1', model: 'supertonic-3', speed: 1.05, silence: 0.05, steps: 8 },
  },
  {
    id: 'voice-b',
    description: 'moderately slower rate, longer pauses',
    speechLabel: 'synthetic speech based on real wording',
    supertonic: { voice: 'F5', model: 'supertonic-3', speed: 0.92, silence: 0.14, steps: 8 },
  },
];

/** Every spoken utterance the corpus commits to, as synthesis specs. */
export function utteranceSpecsFromCorpus(corpus: LoadedCorpus): FixtureSpec[] {
  const specs: FixtureSpec[] = [];
  for (const episode of corpus.episodes) {
    if (episode.holdout) continue; // no wording exists yet — the validator owns it
    for (const turn of episode.inputTurns) {
      if (turn.text.trim() === '') continue;
      specs.push({ id: `${episode.id}-${turn.id}`, text: turn.text, requiredWords: turn.requiredWords });
    }
    episode.repairBranches.forEach((branch, index) => {
      if (branch.say && branch.say.trim() !== '') {
        specs.push({ id: `${episode.id}-repair-${index + 1}`, text: branch.say, requiredWords: [] });
      }
    });
  }
  return specs;
}

/**
 * ASR-only validity gate (no disk access): each fixture's independent
 * transcript must meet the WER ceiling and contain every required word.
 */
export async function evaluateFixtureSet(
  manifest: Pick<FixtureManifest, 'fixtures'>,
  options: { asr: AsrClient; specs: FixtureSpec[]; maxWer?: number }
): Promise<{ ok: boolean; verdicts: ReturnType<typeof verifyFixture>[]; problems: string[] }> {
  const verdicts: ReturnType<typeof verifyFixture>[] = [];
  const problems: string[] = [];
  for (const spec of options.specs) {
    const fixture = manifest.fixtures.find((candidate) => candidate.id === spec.id);
    if (!fixture) {
      problems.push(`fixture ${spec.id} missing from manifest`);
      continue;
    }
    const result: AsrResult = await options.asr(Buffer.alloc(0));
    const verdict = verifyFixture(
      { id: spec.id, text: spec.text, requiredWords: spec.requiredWords ?? [] },
      result,
      { maxWer: options.maxWer }
    );
    verdicts.push(verdict);
    if (!verdict.ok) problems.push(`fixture ${spec.id}: ${verdict.reason ?? 'failed'}`);
  }
  return { ok: problems.length === 0, verdicts, problems };
}

export interface VoiceProfileBuild {
  profileId: string;
  manifest: FixtureManifest;
  manifestPath: string;
  verification: FixtureSetVerification;
}

/** Synthesise + validate one voice profile over the corpus wording.
 *
 * Supertonic sampling is not deterministic: one bad sample of a perfectly
 * good sentence is an instrument artefact, not corpus damage. Each fixture
 * therefore gets up to `maxAttempts` synthesis attempts (plan §10: at most
 * two infrastructure retries per cell); a fixture still failing after that
 * is INVALID and the build reports it honestly.
 */
export async function buildVoiceProfile(
  profile: VoiceProfile,
  corpus: LoadedCorpus,
  options: { outDir: string; whisperBaseUrl: string; maxAttempts?: number; log?: (line: string) => void }
): Promise<VoiceProfileBuild> {
  const log = options.log ?? (() => {});
  const maxAttempts = options.maxAttempts ?? 3;
  const specs = utteranceSpecsFromCorpus(corpus);
  const asr = createWhisperAsrClient({ baseUrl: options.whisperBaseUrl });
  const synthesis = { speed: profile.supertonic.speed, silence: profile.supertonic.silence, steps: profile.supertonic.steps };

  const kept = new Map<string, SynthesisedFixture>();
  const transcripts = new Map<string, Awaited<ReturnType<AsrClient>>>();
  let pending = specs;
  let manifest: FixtureManifest | null = null;

  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt += 1) {
    const pass = await synthesiseFixtures({
      outDir: options.outDir,
      specs: pending,
      voice: profile.supertonic.voice,
      model: profile.supertonic.model,
      synthesis,
      log,
    });
    manifest = pass;
    const nextPending: FixtureSpec[] = [];
    for (const spec of pending) {
      const fixture = pass.fixtures.find((candidate) => candidate.id === spec.id);
      if (!fixture) {
        nextPending.push(spec);
        continue;
      }
      const result: AsrResult = await asr(readFileSync(fixture.pcm16kPath));
      const verdict = verifyFixture(
        { id: spec.id, text: spec.text, requiredWords: spec.requiredWords ?? [] },
        result
      );
      if (verdict.ok) {
        kept.set(spec.id, fixture);
        transcripts.set(spec.id, result);
      } else {
        log(`fixture ${spec.id} failed ASR on attempt ${attempt}: ${verdict.reason}`);
        nextPending.push(spec);
      }
    }
    pending = nextPending;
  }

  if (!manifest) throw new Error('no synthesis pass completed');
  const finalManifest: FixtureManifest = {
    ...manifest,
    fixtures: specs
      .map((spec) => kept.get(spec.id))
      .filter((fixture): fixture is SynthesisedFixture => fixture !== undefined),
  };
  const verification = await verifyFixtureSet(finalManifest, { asr });
  return { profileId: profile.id, manifest: finalManifest, manifestPath: `${options.outDir}/manifest.json`, verification };
}
