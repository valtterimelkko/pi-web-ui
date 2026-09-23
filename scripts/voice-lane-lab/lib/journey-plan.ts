/**
 * Journey planning for the `primary-mic` browser journey (child J; plan
 * §4.2, §11 Phase 2's named journey).
 *
 * The plan is PURE data — deterministic, dry-run-able, no browser/server/
 * network. It maps a corpus episode's director turns onto speech fixtures and
 * input modes, and freezes:
 *
 *   - the capture-mode policy: the FIRST utterance rides Chromium's
 *     file-backed fake microphone (`--use-file-for-fake-audio-capture`, the
 *     real speech WAV); every LATER director utterance uses the plan's own
 *     labelled `synthetic-stream-source` helper feeding the UNCHANGED product
 *     capture pipeline (worklet → resampler → wire). Fixed-WAV-plus-sleeps is
 *     explicitly not used for adaptive steps (§4.2(2)).
 *   - the arm-selection contract as DATA: the arm label maps to child-server
 *     environment through `--server-env KEY=VALUE` entries with the
 *     documented default `VOICE_LIVE_PROFILE=<arm>` (P's integration key).
 *     Nothing here knows or trusts the provider-profile implementation.
 *   - fail-closed behaviour: a holdout episode, a missing turn fixture or a
 *     fixture without passing ASR validation refuses to plan.
 */

import { createHash } from 'node:crypto';

import type { Episode, LoadedCorpus } from './corpus.js';
import { episodeById } from './corpus.js';
import {
  readFrozenVoiceManifest,
  INSTRUMENT_ID,
  SYNTHETIC_TTS_LABEL,
  type FrozenVoiceManifest,
} from './built-app.js';

export const SYNTHETIC_LABEL = 'synthetic-stream-source';

/** The documented default arm-selection key (P's integration contract). */
export const DEFAULT_ARM_ENV_KEY = 'VOICE_LIVE_PROFILE';

export const ARM_LABELS = ['standard', 'et-high'] as const;
export type ArmLabel = (typeof ARM_LABELS)[number];

/** Explicit `--tts` modes (child J3): `real` is the unchanged default; `synthetic` installs the labelled read-back shim. */
export const TTS_MODES = ['synthetic', 'real'] as const;
export type TtsMode = (typeof TTS_MODES)[number];

/** Capture modes a journey turn may use. */
export type TurnInputMode = 'fake-file' | typeof SYNTHETIC_LABEL;

/** The journey's capture mode: the base pair, or with the labelled TTS shim appended (explicit `--tts synthetic` only). */
export const CAPTURE_MODE_BASE = 'fake-file+synthetic-stream-source';
export const CAPTURE_MODE_TTS_SYNTHETIC = `${CAPTURE_MODE_BASE}+${SYNTHETIC_TTS_LABEL}`;
export type JourneyCaptureMode = typeof CAPTURE_MODE_BASE | typeof CAPTURE_MODE_TTS_SYNTHETIC;

export interface JourneyTurn {
  turnId: string;
  kind: string;
  text: string;
  fixtureId: string;
  /** 16 kHz PCM digest of the frozen fixture (provenance into the record). */
  pcm16kSha256: string;
  pcm16kPath: string;
  masterWavPath: string;
  durationMs: number;
  inputMode: TurnInputMode;
  /**
   * True only for the opening turn: the fake device starts playing the WAV
   * when the MAIN capture control opens the lane, so the director's first
   * speak action is executed by that start gesture itself.
   */
  speakOnStart: boolean;
}

export interface JourneyPlan {
  schemaVersion: 1;
  kind: 'primary-mic-journey';
  episodeId: string;
  arm: ArmLabel;
  captureMode: JourneyCaptureMode;
  evidenceLevel: 'E2';
  syntheticLabel: typeof SYNTHETIC_LABEL;
  /**
   * Present ONLY when the journey was explicitly requested with `--tts
   * synthetic` (child J3): the labelled read-back shim rides on the page and
   * every text it speaks is recorded and verifier-checked against the live
   * proposal's retained bytes. Absent on default journeys — no shim unless
   * requested, so default plan bytes (and hashes) are unchanged.
   */
  tts?: 'synthetic';
  ttsLabel?: typeof SYNTHETIC_TTS_LABEL;
  turns: JourneyTurn[];
  deadlines: Episode['perStepDeadlinesMs'];
  /** Overall attempt deadline — model/audio connections abort at it. */
  attemptDeadlineMs: number;
  routesRelay: boolean;
  expectedArtefact: Episode['expectedFinalWorkerArtefact'];
  voiceProfileId: string;
  server: { engine: string; compiled: true };
  browserArgs: string[];
  corpusHash: string;
  instrument: { id: string; label: string };
  /** Present only in unit fixtures; excludes volatile paths from the hash. */
  planHash?: string;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([key]) => key !== 'planHash')
          .sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return item;
  });
}

export function journeyPlanHash(plan: JourneyPlan): string {
  return createHash('sha256').update(stableStringify(plan)).digest('hex');
}

/**
 * The `--server-env KEY=VALUE` arm-selection interface: arm label → child
 * server env. The default mapping is the documented key; explicit entries
 * (later wins) override or extend it. The runner never hard-codes provider
 * profile knowledge beyond this documented default.
 */
export function armServerEnv(arm: string, serverEnvEntries: string[]): Record<string, string> {
  const env: Record<string, string> = { [DEFAULT_ARM_ENV_KEY]: arm };
  for (const entry of serverEnvEntries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--server-env entries must be KEY=VALUE, got: ${entry}`);
    }
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** All director-speakable turn ids for an episode: input turns + the frozen repair saying. */
function directorTurnIds(episode: Episode): string[] {
  const ids = episode.inputTurns.map((turn) => turn.id);
  const clarification = episode.repairBranches.find((branch) => branch.action === 'one-clarification');
  if (clarification?.say) ids.push('repair-1');
  return ids;
}

/**
 * Deterministic journey plan for one episode. Fails closed on: holdout
 * episodes, a missing frozen voice manifest, a missing turn fixture, or a
 * fixture without passing ASR validation.
 */
export function journeyPlan(
  episodeId: string,
  options: { corpus: LoadedCorpus; corpusDir: string; arm: string; profileId?: string; tts?: string }
): JourneyPlan {
  if (!ARM_LABELS.includes(options.arm as ArmLabel)) {
    throw new Error(`unknown arm "${options.arm}" — expected one of ${ARM_LABELS.join(', ')}`);
  }
  if (options.tts !== undefined && !(TTS_MODES as readonly string[]).includes(options.tts)) {
    throw new Error(
      `unknown --tts mode "${options.tts}" — expected one of ${TTS_MODES.join(', ')} ` +
        '(explicit; default real = unchanged journey with no shim)'
    );
  }
  const ttsSynthetic = options.tts === 'synthetic';
  const profileId = options.profileId ?? 'voice-a';
  const episode = episodeById(options.corpus, episodeId);
  if (episode.holdout) {
    throw new Error(`${episodeId}: holdout wording is frozen by the separate validator — cannot plan yet`);
  }
  const voice: FrozenVoiceManifest = readFrozenVoiceManifest(options.corpusDir, profileId);

  const turns: JourneyTurn[] = directorTurnIds(episode).map((turnId, index) => {
    const fixtureId = `${episodeId}-${turnId}`;
    const inputTurn = episode.inputTurns.find((candidate) => candidate.id === turnId);
    const text =
      inputTurn?.text ??
      episode.repairBranches.find((branch) => branch.action === 'one-clarification')?.say ??
      '';
    if (!text.trim()) throw new Error(`${fixtureId}: no frozen wording for director turn ${turnId}`);
    const fixture = voice.fixtures.find((candidate) => candidate.id === fixtureId);
    if (!fixture) {
      throw new Error(`frozen voice manifest ${profileId} has no fixture ${fixtureId} (turn ${turnId})`);
    }
    // Freshness guard (fix-loop pass 5, C05): a corpus wording change must never
    // silently reuse audio frozen for the OLD text — the operator would hear a
    // sentence the episode no longer declares. Fail closed; re-freeze the voices.
    if (fixture.text !== text) {
      throw new Error(
        `fixture ${fixtureId} was frozen for different wording than the episode now declares — re-freeze the corpus voices ` +
          `(manifest: ${JSON.stringify(fixture.text)}, episode: ${JSON.stringify(text)})`
      );
    }
    if (!fixture.asr.ok) throw new Error(`fixture ${fixtureId} failed ASR validation — refusing to plan`);
    if ((fixture.asr.wer ?? 1) > 0.08 || (fixture.asr.missingWords ?? []).length > 0) {
      throw new Error(`fixture ${fixtureId} failed WER/known-word checks — refusing to plan`);
    }
    return {
      turnId,
      kind: inputTurn?.kind ?? 'repair-clarification',
      text,
      fixtureId,
      pcm16kSha256: fixture.pcm16kSha256,
      pcm16kPath: fixture.pcm16kPath,
      masterWavPath: fixture.masterWavPath,
      durationMs: fixture.durationMs,
      inputMode: index === 0 ? 'fake-file' : SYNTHETIC_LABEL,
      speakOnStart: index === 0,
    };
  });

  const routesRelay = episode.permittedRouteOutcomes.some((outcome) =>
    ['relay-proposal', 'parks-while-busy', 'steer-busy'].includes(outcome)
  );
  const deadlines = episode.perStepDeadlinesMs;
  // Worst-case attempt budget: sum of per-step deadlines × turns + margins,
  // floored at two minutes. Model/audio connections abort at this deadline.
  const stepBudget = (deadlines.candidateMs + deadlines.presentationMs + deadlines.deliveryMs + deadlines.workerStoreMs) * Math.max(1, turns.length);
  const attemptDeadlineMs = Math.max(120_000, Math.min(stepBudget + 60_000, 420_000));

  const openingWav = path_basename(turns[0].masterWavPath);
  return {
    schemaVersion: 1,
    kind: 'primary-mic-journey',
    episodeId,
    arm: options.arm as ArmLabel,
    captureMode: ttsSynthetic ? CAPTURE_MODE_TTS_SYNTHETIC : CAPTURE_MODE_BASE,
    evidenceLevel: 'E2',
    syntheticLabel: SYNTHETIC_LABEL,
    ...(ttsSynthetic ? { tts: 'synthetic' as const, ttsLabel: SYNTHETIC_TTS_LABEL } : {}),
    turns,
    deadlines,
    attemptDeadlineMs,
    routesRelay,
    expectedArtefact: episode.expectedFinalWorkerArtefact,
    voiceProfileId: profileId,
    server: { engine: 'gemini-live', compiled: true },
    browserArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${openingWav}%noloop`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    corpusHash: options.corpus.schemaVersion + '-' + createHash('sha256').update(stableStringify(options.corpus.episodes.map((e) => e.id))).digest('hex').slice(0, 16),
    instrument: { id: INSTRUMENT_ID, label: 'lab-only boundary observation; never part of the client' },
  };
}

function path_basename(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}
