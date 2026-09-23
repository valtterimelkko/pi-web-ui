/**
 * The W4 continuity soak plan (native-primary plan §8 soak cell).
 *
 * The soak is DATA. `corpus/soak/SOAK-10MIN.json` scripts a 10-minute session
 * from EXISTING frozen operator wording: each `turn` step references a corpus
 * episode turn (`ref`), and the soak journey plan reuses that turn's frozen
 * fixture — never new audio, never new product behaviour. `pace` steps hold
 * the live session open; the single `reconnect` step is the mid-session
 * voice-transport reconnect the runner performs through real product paths.
 *
 * From the plan the module constructs the SOAK-10MIN Episode the deterministic
 * director drives (and the offline verifier replays), plus the JourneyPlan
 * the runner executes.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  NON_SPEAKABLE_TURN_KINDS,
  EpisodeSchema,
  type Episode,
  type LoadedCorpus,
  episodeById,
} from './corpus.js';
import {
  ARM_LABELS,
  CAPTURE_MODE_BASE,
  CAPTURE_MODE_TTS_SYNTHETIC,
  SYNTHETIC_LABEL,
  TTS_MODES,
  type JourneyPlan,
  type JourneyTurn,
} from './journey-plan.js';
import { INSTRUMENT_ID, SYNTHETIC_TTS_LABEL, readFrozenVoiceManifest } from './built-app.js';

export { SOAK_EPISODE_ID } from './campaign.js';

export const SOAK_PLAN_SCHEMA_VERSION = 1;
export const SOAK_PLAN_MIN_DURATION_MS = 600_000;
export const SOAK_PLAN_MIN_OPERATOR_TURNS = 8;

const TurnStepSchema = z.object({
  kind: z.literal('turn'),
  ref: z.object({ episodeId: z.string().min(1), turnId: z.string().min(1) }),
});
const PaceStepSchema = z.object({ kind: z.literal('pace'), ms: z.number().int().positive() });
const ReconnectStepSchema = z.object({ kind: z.literal('reconnect') });

const SoakPlanShape = z.object({
  schemaVersion: z.literal(SOAK_PLAN_SCHEMA_VERSION),
  id: z.literal('SOAK-10MIN'),
  title: z.string().min(8),
  description: z.string().min(24),
  minDurationMs: z.number().int().positive(),
  minOperatorTurns: z.number().int().positive(),
  attemptDeadlineMs: z.number().int().positive(),
  expectedSlots: z.unknown(),
  requiredNegations: z.array(z.string().min(2)),
  requiredNames: z.array(z.string().min(2)),
  requiredNumbers: z.array(z.string().min(1)),
  perStepDeadlinesMs: z.object({
    candidateMs: z.number().int().positive(),
    presentationMs: z.number().int().positive(),
    deliveryMs: z.number().int().positive(),
    workerStoreMs: z.number().int().positive(),
  }),
  expectedFinalWorkerArtefact: z.object({
    kind: z.enum(['worker-input-persisted', 'no-worker-action', 'parked-item-promoted', 'steer-delivered']),
    description: z.string().min(6),
  }),
  steps: z.array(z.union([TurnStepSchema, PaceStepSchema, ReconnectStepSchema])).min(1),
});

export const SoakPlanSchema = SoakPlanShape.superRefine((plan, ctx) => {
  if (plan.minDurationMs < SOAK_PLAN_MIN_DURATION_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the soak must run at least ten minutes (600000 ms)' });
  }
  if (plan.minOperatorTurns < SOAK_PLAN_MIN_OPERATOR_TURNS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the soak must carry at least 8 operator turns' });
  }
  if (plan.attemptDeadlineMs <= plan.minDurationMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the attempt deadline must exceed the soak duration' });
  }
  const reconnects = plan.steps.filter((step) => step.kind === 'reconnect');
  if (reconnects.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the soak carries exactly one mid-session reconnect' });
  }
  const turns = plan.steps.filter((step): step is SoakTurnStep => step.kind === 'turn');
  if (turns.length < SOAK_PLAN_MIN_OPERATOR_TURNS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the soak carries fewer operator turns than the fixed bar' });
  }
  const reconnectIndex = plan.steps.findIndex((step) => step.kind === 'reconnect');
  const turnsBefore = plan.steps.slice(0, reconnectIndex).some((step) => step.kind === 'turn');
  const turnsAfter = plan.steps.slice(reconnectIndex + 1).some((step) => step.kind === 'turn');
  if (!turnsBefore || !turnsAfter) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the reconnect must be mid-session (turns on both sides)' });
  }
});

export type SoakTurnStep = z.infer<typeof TurnStepSchema>;
export type SoakPaceStep = z.infer<typeof PaceStepSchema>;
export type SoakReconnectStep = z.infer<typeof ReconnectStepSchema>;
export type SoakStep = SoakTurnStep | SoakPaceStep | SoakReconnectStep;
export type SoakPlan = Omit<z.infer<typeof SoakPlanShape>, 'expectedSlots'> & {
  expectedSlots: Episode['expectedSlots'];
};

export class SoakPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoakPlanError';
  }
}

/** Load and validate `corpus/soak/SOAK-10MIN.json`. Throws SoakPlanError on any violation. */
export function loadSoakPlan(corpusDir: string): SoakPlan {
  const file = path.join(corpusDir, 'soak', 'SOAK-10MIN.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new SoakPlanError(`soak plan unreadable: ${String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new SoakPlanError(`soak plan is not valid JSON: ${String(error)}`);
  }
  const parsed = SoakPlanSchema.safeParse(json);
  if (!parsed.success) {
    throw new SoakPlanError(`soak plan invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.data as SoakPlan;
}

/**
 * Construct the SOAK-10MIN Episode from the plan. Every `turn` step's wording
 * comes verbatim from the referenced corpus turn (fail closed on an unknown
 * ref); `pace`/`reconnect` steps become the soak-only turn kinds. The result
 * is schema-valid and drivable, and the director/verifier replay it
 * deterministically.
 */
export function soakEpisodeFromPlan(plan: SoakPlan, corpus: LoadedCorpus): Episode {
  const turns: Episode['inputTurns'] = [];
  let index = 0;
  let firstTurnRef: SoakTurnStep['ref'] | null = null;
  for (const step of plan.steps) {
    index += 1;
    const id = `s${String(index).padStart(2, '0')}`;
    if (step.kind === 'turn') {
      const source = episodeById(corpus, step.ref.episodeId).inputTurns.find(
        (candidate) => candidate.id === step.ref.turnId
      );
      if (!source) {
        throw new SoakPlanError(`soak plan step ${id}: unknown ref ${step.ref.episodeId}/${step.ref.turnId}`);
      }
      if (!source.text.trim()) {
        throw new SoakPlanError(`soak plan step ${id}: ref ${step.ref.episodeId}/${step.ref.turnId} carries no wording (a holdout?)`);
      }
      if (!firstTurnRef) firstTurnRef = step.ref;
      turns.push({ id, kind: source.kind, text: source.text, requiredWords: source.requiredWords });
    } else if (step.kind === 'pace') {
      turns.push({ id, kind: 'soak-pace', text: '', requiredWords: [], paceMs: step.ms });
    } else {
      turns.push({ id, kind: 'soak-reconnect', text: '', requiredWords: [] });
    }
  }
  if (!firstTurnRef) throw new SoakPlanError('soak plan carries no operator turn');
  const relayEpisode = episodeById(corpus, firstTurnRef.episodeId);
  const approvalTurns = turns
    .filter((turn) => turn.kind === 'adaptive-confirm')
    .map((turn) => ({ turnId: turn.id, precondition: 'candidate-matched+presentation-complete' as const }));
  if (approvalTurns.length === 0) {
    throw new SoakPlanError('soak plan carries no confirmation turn — a soak without a post-reconnect confirm proves nothing');
  }
  const candidate = {
    schemaVersion: 1,
    id: 'SOAK-10MIN',
    title: plan.title,
    family: 'continuity-soak',
    tier: 'SOAK',
    holdout: false,
    provenance: {
      source: 'voice-native-primary plan §8 soak cell; wording re-used from the committed corpus episodes',
      rationale: plan.description,
    },
    speechLabel: 'synthetic speech based on real wording',
    openingWorkerState: {
      status: 'idle',
      pendingProposal: false,
      attachments: 1,
      description: 'one idle worker attached, no pending proposal',
    },
    inputTurns: turns,
    permittedRouteOutcomes: ['relay-proposal'],
    expectedSlots: plan.expectedSlots,
    requiredNegations: plan.requiredNegations,
    requiredNames: plan.requiredNames,
    requiredNumbers: plan.requiredNumbers,
    approvalTurns,
    repairBranches: relayEpisode.repairBranches,
    perStepDeadlinesMs: plan.perStepDeadlinesMs,
    expectedFinalWorkerArtefact: plan.expectedFinalWorkerArtefact,
  } as unknown as Episode;
  const parsed = EpisodeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SoakPlanError(
      `constructed soak episode failed schema validation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
    );
  }
  return parsed.data;
}

/** A corpus copy with the soak episode joined (planning + verification both need it). */
export function withSoakEpisode(corpus: LoadedCorpus, episode: Episode): LoadedCorpus {
  if (corpus.episodes.some((candidate) => candidate.id === episode.id)) {
    throw new SoakPlanError(`${episode.id} is already present in the corpus`);
  }
  return { ...corpus, episodes: [...corpus.episodes, episode] };
}

/** The soak journey plan: every operator turn rides its SOURCE turn's frozen fixture. */
export function soakJourneyPlan(
  plan: SoakPlan,
  corpus: LoadedCorpus,
  options: { corpusDir: string; arm: string; profileId?: string; tts?: string }
): JourneyPlan {
  if (!ARM_LABELS.includes(options.arm as (typeof ARM_LABELS)[number])) {
    throw new SoakPlanError(`unknown arm "${options.arm}" — expected one of ${ARM_LABELS.join(', ')}`);
  }
  if (options.tts !== undefined && !TTS_MODES.includes(options.tts as (typeof TTS_MODES)[number])) {
    throw new SoakPlanError(`unknown --tts mode "${options.tts}"`);
  }
  const ttsSynthetic = options.tts === 'synthetic';
  const episode = soakEpisodeFromPlan(plan, corpus);
  const profileId = options.profileId ?? 'voice-a';
  const voice = readFrozenVoiceManifest(options.corpusDir, profileId);
  const sourceRefs = plan.steps.filter((step): step is SoakTurnStep => step.kind === 'turn');
  const turns: JourneyTurn[] = episode.inputTurns
    .filter((turn) => !NON_SPEAKABLE_TURN_KINDS.includes(turn.kind))
    .map((turn, index) => {
      const ref = sourceRefs[index]?.ref;
      if (!ref) throw new SoakPlanError(`soak turn ${turn.id} lost its source ref`);
      const sourceTurn = episodeById(corpus, ref.episodeId).inputTurns.find(
        (candidate) => candidate.id === ref.turnId
      );
      if (!sourceTurn || sourceTurn.text !== turn.text) {
        throw new SoakPlanError(`soak turn ${turn.id} drifted from its source ${ref.episodeId}/${ref.turnId}`);
      }
      const fixtureId = `${ref.episodeId}-${ref.turnId}`;
      const fixture = voice.fixtures.find((candidate) => candidate.id === fixtureId);
      if (!fixture) {
        throw new SoakPlanError(`frozen voice manifest ${profileId} has no fixture ${fixtureId} (soak turn ${turn.id})`);
      }
      if (fixture.text !== turn.text) {
        throw new SoakPlanError(
          `fixture ${fixtureId} was frozen for different wording than the source episode now declares — re-freeze the corpus voices`
        );
      }
      if (!fixture.asr.ok || (fixture.asr.wer ?? 1) > 0.08 || (fixture.asr.missingWords ?? []).length > 0) {
        throw new SoakPlanError(`fixture ${fixtureId} failed ASR/WER validation — refusing to plan the soak`);
      }
      return {
        turnId: turn.id,
        kind: turn.kind,
        text: turn.text,
        fixtureId,
        pcm16kSha256: fixture.pcm16kSha256,
        pcm16kPath: fixture.pcm16kPath,
        masterWavPath: fixture.masterWavPath,
        durationMs: fixture.durationMs,
        inputMode: index === 0 ? ('fake-file' as const) : ('synthetic-stream-source' as const),
        speakOnStart: index === 0,
      };
    });
  const routesRelay = episode.permittedRouteOutcomes.some((outcome) =>
    ['relay-proposal', 'parks-while-busy', 'steer-busy'].includes(outcome)
  );
  // The frozen repair wording is director-speakable in a soak too (a deadline
  // expiry): its fixture rides along so the runner can speak it if ever needed.
  const clarification = episode.repairBranches.find((branch) => branch.action === 'one-clarification');
  if (clarification?.say) {
    const fixtureId = `${sourceRefs[0]!.ref.episodeId}-repair-1`;
    const fixture = voice.fixtures.find((candidate) => candidate.id === fixtureId);
    if (fixture && fixture.text === clarification.say && fixture.asr.ok) {
      turns.push({
        turnId: 'repair-1',
        kind: 'repair-clarification',
        text: clarification.say,
        fixtureId,
        pcm16kSha256: fixture.pcm16kSha256,
        pcm16kPath: fixture.pcm16kPath,
        masterWavPath: fixture.masterWavPath,
        durationMs: fixture.durationMs,
        inputMode: 'synthetic-stream-source',
        speakOnStart: false,
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: 'primary-mic-journey',
    episodeId: 'SOAK-10MIN',
    arm: options.arm as JourneyPlan['arm'],
    captureMode: ttsSynthetic ? CAPTURE_MODE_TTS_SYNTHETIC : CAPTURE_MODE_BASE,
    evidenceLevel: 'E2',
    syntheticLabel: SYNTHETIC_LABEL,
    ...(ttsSynthetic ? { tts: 'synthetic' as const, ttsLabel: SYNTHETIC_TTS_LABEL } : {}),
    turns,
    deadlines: plan.perStepDeadlinesMs,
    attemptDeadlineMs: plan.attemptDeadlineMs,
    routesRelay,
    expectedArtefact: plan.expectedFinalWorkerArtefact,
    soak: { minDurationMs: plan.minDurationMs, minOperatorTurns: plan.minOperatorTurns, reconnects: 1 },
    voiceProfileId: profileId,
    server: { engine: 'gemini-live', compiled: true },
    browserArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${turns[0]!.masterWavPath.split('/').pop()}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    corpusHash: soakCorpusHash(corpus),
    instrument: { id: INSTRUMENT_ID, label: 'lab-only boundary observation; never part of the client' },
  };
}

/** Same derivation as journey-plan.ts: the corpus' episode IDS only. */
function soakCorpusHash(corpus: LoadedCorpus): string {
  return (
    corpus.schemaVersion +
    '-' +
    createHash('sha256')
      .update(JSON.stringify(corpus.episodes.map((episode) => episode.id)))
      .digest('hex')
      .slice(0, 16)
  );
}
