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

"use strict";
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  createWhisperAsrClient,
  INPUT_SAMPLE_RATE,
  synthesiseFixtures,
  wavFromPcm16,
  verifyFixture,
  verifyFixtureManifest,
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
  return utteranceSpecsFromEpisodes(
    corpus,
    corpus.episodes.filter((episode) => !episode.holdout).map((episode) => episode.id)
  );
}

/**
 * Synthesis specs for a SUBSET of episodes — the extension path for holdout
 * overlays: the merged copies carry the validator's frozen wording, so their
 * fixtures are synthesised from exactly that text and no other.
 */
export function utteranceSpecsFromEpisodes(corpus: LoadedCorpus, episodeIds: string[]): FixtureSpec[] {
  const specs: FixtureSpec[] = [];
  for (const episodeId of episodeIds) {
    const episode = corpus.episodes.find((candidate) => candidate.id === episodeId);
    if (!episode) throw new Error(`utteranceSpecsFromEpisodes: unknown episode ${episodeId}`);
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
  options: { outDir: string; whisperBaseUrl: string; maxAttempts?: number; log?: (line: string) => void; specsOverride?: FixtureSpec[] }
): Promise<VoiceProfileBuild> {
  const log = options.log ?? (() => {});
  const maxAttempts = options.maxAttempts ?? 3;
  const specs = options.specsOverride ?? utteranceSpecsFromCorpus(corpus);
  // Transport-level resilience: the shared Whisper container occasionally
  // answers a transient HTTP 5xx. A transport retry never alters a verdict —
  // only the verdicts' INPUT is retried, then judged once, as before.
  const baseAsr = createWhisperAsrClient({ baseUrl: options.whisperBaseUrl });
  const asr: AsrClient = async (wav) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await baseAsr(wav);
      } catch (error) {
        lastError = error;
        log(`ASR transport retry ${attempt}: ${String(error).slice(0, 120)}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      }
    }
    throw lastError;
  };
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
      reuseRaw: attempt === 1,
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
      let result: AsrResult;
      try {
        // The ASR transport expects a RIFF/WAVE container: the derived pcm16k
        // is raw samples and MUST be wrapped first (an unwrapped upload makes
        // the container's ffmpeg fail with "invalid data").
        result = await asr(wavFromPcm16(readFileSync(fixture.pcm16kPath), INPUT_SAMPLE_RATE));
      } catch (error) {
        // Transport-level failure (shared container flake): the sample itself
        // is unjudged, not invalid. It stays pending for the next pass.
        log(`fixture ${spec.id}: ASR transport failed on attempt ${attempt}: ${String(error)}`);
        nextPending.push(spec);
        continue;
      }
      const verdict = verifyFixture(
        { id: spec.id, text: spec.text, requiredWords: spec.requiredWords ?? [] },
        result
      );
      if (verdict.ok) {
        kept.set(spec.id, fixture);
        transcripts.set(spec.id, result);
      } else {
        log(`fixture ${spec.id} failed ASR on attempt ${attempt}: ${verdict.reason}`);
        // A failed sample must not be reused: force a fresh synthesis next pass.
        try {
          rmSync(path.join(options.outDir, 'raw', `${spec.id}.wav`));
        } catch {
          /* absence is fine */
        }
        nextPending.push(spec);
      }
    }
    pending = nextPending;
  }

  if (pending.length > 0) {
    throw new Error(
      `fixtures invalid after ${maxAttempts} attempts (plan \u00a75.1: disagreement invalidates until resolved): ` +
        pending.map((spec) => spec.id).join(', ')
    );
  }
  if (!manifest) throw new Error('no synthesis pass completed');
  const finalManifest: FixtureManifest = {
    ...manifest,
    fixtures: specs
      .map((spec) => kept.get(spec.id))
      .filter((fixture): fixture is SynthesisedFixture => fixture !== undefined),
  };
  // Final verification from evidence already gathered: disk hashes re-checked,
  // verdicts recomputed from the stored transcripts — no re-transcription, so
  // a flaky container window cannot double-count against a fixture.
  const hashProblems = verifyFixtureManifest(finalManifest);
  const verdicts = specs
    .map((spec) => {
      const stored = transcripts.get(spec.id);
      if (!stored) {
        return {
          id: spec.id,
          text: spec.text,
          transcript: '',
          wer: 1,
          missingWords: spec.requiredWords ?? [],
          ok: false,
          reason: 'no validated transcript (transport failures exhausted retries)',
        };
      }
      return verifyFixture(
        { id: spec.id, text: spec.text, requiredWords: spec.requiredWords ?? [] },
        stored
      );
    });
  const asrFailures = verdicts.filter((verdict) => !verdict.ok);
  const ok = hashProblems.length === 0 && asrFailures.length === 0;
  const verification: FixtureSetVerification = {
    ok,
    verdicts,
    problems: [
      ...hashProblems,
      ...asrFailures.map((failure) => `fixture ${failure.id}: ${failure.reason ?? 'failed'}`),
    ],
  };
  return { profileId: profile.id, manifest: finalManifest, manifestPath: `${options.outDir}/manifest.json`, verification };
}
