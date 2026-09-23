/**
 * Phase 1 corpus schema and loader (native-primary plan §5.1–§5.2).
 *
 * One schema-versioned episode per catalogue ID under `corpus/episodes/`.
 * The corpus is DATA for the deterministic director and the offline verifier:
 *
 *   - exactly 24 IDs; tiers P (12, the dev set), H (4 holdout, wording frozen
 *     by a separate validator — surface forms are EMPTY here), E (8 extend);
 *   - every episode declares provenance, opening worker state, exact input
 *     turns, permitted route outcomes, expected semantic slots, forbidden
 *     additions, required negations/names/numbers, approval turns (each with
 *     the only legal precondition: an observed matching candidate plus a
 *     completed presentation), frozen repair branches, per-step deadlines and
 *     the expected final worker artefact;
 *   - holdout files keep the family requirements but leave wording empty with
 *     `validatorFrozen: true` placeholders.
 *
 * The loader is strict: it refuses a corpus that violates the plan's approval
 * semantics (approval without a relay route, or an approval turn whose
 * precondition is anything other than the observed-candidate rule).
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const CORPUS_SCHEMA_VERSION = 1;

export const EPISODE_IDS = Array.from({ length: 24 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`) as unknown as [
  string,
  ...string[],
];

export const FAMILIES = [
  'relay-addressing',
  'constraint-integrity',
  'conversation-separation',
  'session-retrieval',
  'correction-identity',
  'approval-semantics',
  'busy-parking',
  'attachment-switch',
  'continuity-soak',
] as const;
export type Family = (typeof FAMILIES)[number];

export const TIERS = ['P', 'H', 'E', 'SOAK'] as const;
export type Tier = (typeof TIERS)[number];

export const ROUTE_OUTCOMES = [
  'relay-proposal',
  'conversational-only',
  'parks-while-busy',
  'steer-busy',
] as const;
export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];

export const TURN_KINDS = [
  'opening',
  'conversational',
  'adaptive-confirm',
  'adaptive-amend',
  'adaptive-cancel',
  'adaptive-repeat',
  'adaptive-repair',
  'adaptive-steer',
  // W4 harness capabilities. `adaptive-promote` drives the product's own
  // one-item promote path for the busy-parking family; `soak-pace` and
  // `soak-reconnect` exist ONLY in the constructed continuity-soak episode —
  // the loader refuses them in committed episode FILES.
  'adaptive-promote',
  'soak-pace',
  'soak-reconnect',
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/** The one legal approval precondition — structural, not conventional. */
export const APPROVAL_PRECONDITION = 'candidate-matched+presentation-complete' as const;

export const REPAIR_TRIGGERS = [
  'no-candidate-within-deadline',
  'mismatched-candidate',
  'wrong-target',
] as const;
export const REPAIR_ACTIONS = [
  'one-clarification',
  'repeat-identical',
  'terminal-interaction-failure',
] as const;

export const ARTEFACT_KINDS = [
  'worker-input-persisted',
  'no-worker-action',
  'parked-item-promoted',
  'steer-delivered',
] as const;

// ── Zod schemas ─────────────────────────────────────────────────────────────

const TurnSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TURN_KINDS),
  /** Empty ONLY for a validator-frozen holdout turn or a soak pace/reconnect step. */
  text: z.string(),
  /** Words that must survive synthesis + ASR (known-word check). */
  requiredWords: z.array(z.string().min(1)),
  /** True only in holdout files whose surface form the validator owns. */
  validatorFrozen: z.boolean().optional(),
  /** soak-pace only: how long the operator stays silent, in milliseconds. */
  paceMs: z.number().int().positive().optional(),
});

const ApprovalTurnSchema = z.object({
  /** Must reference an inputTurn of kind `adaptive-confirm` / `adaptive-steer`. */
  turnId: z.string().min(1),
  precondition: z.literal(APPROVAL_PRECONDITION),
});

const RepairBranchSchema = z.object({
  trigger: z.enum(REPAIR_TRIGGERS),
  action: z.enum(REPAIR_ACTIONS),
  /** Exact clarification wording when action is `one-clarification`. */
  say: z.string().optional(),
});

/** The declared semantic-slot set an episode's candidate must satisfy. Shared with the validator overlay schema. */
export const ExpectedSlotsSchema = z.object({
  /** Substrings (normalised) the delivered candidate MUST contain. */
  mustContain: z.array(z.string().min(2)),
  mustNotContain: z.array(z.string().min(2)),
  mustNotStartWith: z.array(z.string().min(2)).optional(),
  /** Substrings the final spoken/grounded response MUST contain. */
  responseMustContain: z.array(z.string().min(2)),
  responseMustNotContain: z.array(z.string().min(2)),
  /**
   * Open-response grading (fix-loop pass 4, C09/C14/C15): the episode's
   * conversational answer is graded without deterministic required words —
   * one independent evaluator pass owns the wording — while the
   * forbidden-claim check (negation-aware) and the routing/no-release
   * evidence checks still apply. Exclusive with a non-empty
   * `responseMustContain`.
   */
  openResponse: z.boolean().optional(),
  /** Response must cite where its claim came from (worker evidence). */
  sourceAttributionRequired: z.boolean().optional(),
  numericSlots: z
    .array(z.object({ value: z.string().min(1), acceptAnyOf: z.array(z.string().min(1)) }))
    .optional(),
});

export const EpisodeSchema = z
  .object({
    schemaVersion: z.literal(CORPUS_SCHEMA_VERSION),
    // The 24 catalogue ids, plus the continuity-soak episode the W4 soak
    // runner constructs in code (never a file in episodes/).
    id: z.string().regex(/^(?:C\d{2}|SOAK-10MIN)$/),
    title: z.string().min(3),
    family: z.enum(FAMILIES),
    tier: z.enum(TIERS),
    holdout: z.boolean(),
    provenance: z.object({
      source: z.string().min(6),
      rationale: z.string().min(6),
    }),
    /** Fixed label for every speech fixture derived from this episode. */
    speechLabel: z.literal('synthetic speech based on real wording'),
    openingWorkerState: z.object({
      status: z.enum(['idle', 'working', 'busy']),
      pendingProposal: z.boolean(),
      attachments: z.number().int().min(1).max(3),
      description: z.string().min(4),
    }),
    inputTurns: z.array(TurnSchema).min(1),
    permittedRouteOutcomes: z.array(z.enum(ROUTE_OUTCOMES)).min(1),
    expectedSlots: ExpectedSlotsSchema,
    requiredNegations: z.array(z.string().min(2)),
    requiredNames: z.array(z.string().min(2)),
    requiredNumbers: z.array(z.string().min(1)),
    approvalTurns: z.array(ApprovalTurnSchema),
    repairBranches: z.array(RepairBranchSchema),
    identity: z
      .object({
        invalidateOnCancel: z.boolean(),
        newIdentityOnRepeatAfterCancel: z.boolean(),
      })
      .optional(),
    perStepDeadlinesMs: z.object({
      candidateMs: z.number().int().positive(),
      presentationMs: z.number().int().positive(),
      deliveryMs: z.number().int().positive(),
      workerStoreMs: z.number().int().positive(),
    }),
    expectedFinalWorkerArtefact: z.object({
      kind: z.enum(ARTEFACT_KINDS),
      description: z.string().min(6),
    }),
  })
  .superRefine((episode, ctx) => {
    // Holdout structure: family requirements present, surface forms absent.
    if (episode.holdout) {
      for (const turn of episode.inputTurns) {
        if (turn.text !== '' || turn.validatorFrozen !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${episode.id}: holdout surface forms must be empty and validator-frozen`,
          });
        }
      }
    } else {
      const opening = episode.inputTurns[0];
      // C08 opens conversationally (a jointly developed question); every other
      // non-holdout episode opens with the scripted first instruction.
      if (
        !['opening', 'conversational'].includes(opening.kind) ||
        opening.text.trim().length < 12
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${episode.id}: non-holdout episodes need a real opening turn`,
        });
      }
    }
    const turnsById = new Map(episode.inputTurns.map((turn) => [turn.id, turn]));
    if (episode.expectedSlots.openResponse === true && episode.expectedSlots.responseMustContain.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${episode.id}: an open-response episode declares no deterministic required words (the evaluator pass grades the wording)`,
      });
    }
    for (const approval of episode.approvalTurns) {
      const turn = turnsById.get(approval.turnId);
      if (!turn || !['adaptive-confirm', 'adaptive-steer'].includes(turn.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${episode.id}: approval ${approval.turnId} must reference an adaptive-confirm/steer input turn`,
        });
      }
    }
    const routesRelay = episode.permittedRouteOutcomes.some((outcome) =>
      ['relay-proposal', 'parks-while-busy', 'steer-busy'].includes(outcome)
    );
    if (!routesRelay && episode.approvalTurns.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${episode.id}: a conversation-only episode must not carry approval turns`,
      });
    }
    const clarifications = episode.repairBranches.filter((branch) => branch.action === 'one-clarification');
    if (clarifications.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${episode.id}: at most one clarification repair (plan §5.3 budget)`,
      });
    }
    for (const branch of episode.repairBranches) {
      if (branch.action === 'one-clarification' && (!branch.say || branch.say.trim().length < 8)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${episode.id}: a clarification repair needs its exact frozen wording`,
        });
      }
    }
  });

export type Episode = z.infer<typeof EpisodeSchema>;
export type InputTurn = z.infer<typeof TurnSchema>;
/** The declared semantic-slot set an episode's candidate must satisfy. */
export type EpisodeExpectedSlots = Episode['expectedSlots'];

export interface CorpusIndex {
  schemaVersion: number;
  ids: string[];
  /** Populated by the loader, not stored in the file. */
  [key: string]: unknown;
}

export interface LoadedCorpus {
  schemaVersion: number;
  episodes: Episode[];
  index: CorpusIndex;
  corpusDir: string;
  /**
   * Present only on the product of {@link withValidatorOverlays}: the holdout
   * ids that were merged from validator overlays, with each overlay's freeze
   * timestamp (provenance; the merged episodes are drivable copies whose
   * `holdout` flag is false — the corpus FILES stay empty, always).
   */
  validatorOverlays?: Record<string, { validatorFrozenAtIso: string }>;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusError';
  }
}

/** The 12 P-tier IDs: the fix-loop dev set and comparison core. */
export const P_TIER_DEV_SET: string[] = [
  'C01',
  'C03',
  'C05',
  'C09',
  'C14',
  'C15',
  'C16',
  'C17',
  'C18',
  'C19',
  'C20',
  'C21',
];

/** The 4 holdout IDs whose surface forms the separate validator freezes. */
export const HOLDOUT_IDS: string[] = ['C10', 'C11', 'C22', 'C24'];

function defaultCorpusDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
}

/** Load and validate the whole corpus from a directory. Throws CorpusError on any violation. */
export function loadCorpusFromDir(corpusDir: string): LoadedCorpus {
  const episodesDir = path.join(corpusDir, 'episodes');
  const indexPath = path.join(corpusDir, 'index.json');
  let index: CorpusIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as CorpusIndex;
  } catch (error) {
    throw new CorpusError(`corpus index unreadable: ${String(error)}`);
  }
  if (index.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    throw new CorpusError(`index schemaVersion ${String(index.schemaVersion)} != ${CORPUS_SCHEMA_VERSION}`);
  }

  const files = readdirSync(episodesDir).filter((name) => /^C\d{2}\.json$/.test(name)).sort();
  const episodes: Episode[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const full = path.join(episodesDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'));
    } catch (error) {
      problems.push(`${file}: invalid JSON (${String(error)})`);
      continue;
    }
    const parsed = EpisodeSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${file}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      continue;
    }
    if (parsed.data.inputTurns.some((turn) => turn.kind === 'soak-pace' || turn.kind === 'soak-reconnect')) {
      problems.push(`${file}: soak turn kinds belong to the soak plan, never a committed episode file`);
      continue;
    }
    episodes.push(parsed.data);
  }
  if (problems.length > 0) throw new CorpusError(`corpus invalid:\n  ${problems.join('\n  ')}`);

  const ids = episodes.map((episode) => episode.id);
  if (new Set(ids).size !== ids.length) throw new CorpusError('duplicate episode ids');
  const missing = EPISODE_IDS.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new CorpusError(`missing episodes: ${missing.join(', ')}`);
  const indexIds = (index.ids ?? []) as string[];
  if ([...indexIds].sort().join(',') !== [...ids].sort().join(',')) {
    throw new CorpusError('index.json ids disagree with the episode files');
  }
  return { schemaVersion: CORPUS_SCHEMA_VERSION, episodes, index, corpusDir };
}

/** Load the committed corpus. */
export function loadCorpus(): LoadedCorpus {
  return loadCorpusFromDir(defaultCorpusDir());
}

export function episodeById(corpus: LoadedCorpus, id: string): Episode {
  const episode = corpus.episodes.find((candidate) => candidate.id === id);
  if (!episode) throw new CorpusError(`unknown episode ${id}`);
  return episode;
}

// ── Holdout validator overlays (Wave 4 conductor scope) ──────────────────

/**
 * The validator overlay: the separate validator's FROZEN surface form and
 * expected facts for one holdout episode, stored OUTSIDE the corpus files at
 * `corpus/holdout/<ID>.validator.json`. The episode files themselves stay
 * empty, always — the overlay is the only place holdout wording may live.
 * Strict shape: an unknown field is a malformed overlay, and a malformed or
 * missing overlay fails closed (it never degrades to empty wording).
 */
const ValidatorOverlayTurnSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(TURN_KINDS),
    text: z.string().min(1),
    requiredWords: z.array(z.string().min(1)),
  })
  .strict();

export const ValidatorOverlaySchema = z
  .object({
    schemaVersion: z.literal(CORPUS_SCHEMA_VERSION),
    id: z.string().regex(/^C\d{2}$/),
    validatorFrozenAtIso: z.string().min(8),
    note: z.string().min(4),
    inputTurns: z.array(ValidatorOverlayTurnSchema).min(1),
    expectedSlots: ExpectedSlotsSchema,
    approvalTurns: z.array(ApprovalTurnSchema),
    repairBranches: z.array(RepairBranchSchema),
  })
  .strict();

export type ValidatorOverlay = z.infer<typeof ValidatorOverlaySchema>;

/**
 * Merge every holdout episode's validator overlay into a drivable copy.
 *
 * Fails closed (CorpusError) when: a holdout episode's overlay file is
 * missing; it is not valid JSON; it violates the strict overlay schema; its
 * id disagrees with the file/episode; a turn id does not exist in the episode
 * structure or its kind disagrees; any episode turn is left without wording;
 * the merged episode fails episode-schema validation (approval references,
 * holdout rules); or an overlay file names a NON-holdout episode.
 *
 * The merged episode carries `holdout: false` — the surface form is now
 * frozen by the overlay, so the existing holdout refusals (director,
 * journeyPlan) correctly stop refusing it. The RAW corpus object and the
 * corpus FILES are never mutated; the committed episodes stay empty.
 */
export function withValidatorOverlays(corpus: LoadedCorpus, corpusDir: string): LoadedCorpus {
  const holdouts = corpus.episodes.filter((episode) => episode.holdout);
  const holdoutIds = new Set(holdouts.map((episode) => episode.id));
  const overlayDir = path.join(corpusDir, 'holdout');
  let overlayFiles: string[] = [];
  try {
    overlayFiles = readdirSync(overlayDir).filter((name) => name.endsWith('.validator.json'));
  } catch {
    overlayFiles = [];
  }
  for (const name of overlayFiles) {
    const id = name.replace(/\.validator\.json$/, '');
    if (!holdoutIds.has(id)) {
      throw new CorpusError(`holdout overlay ${name} names "${id}", which is not a holdout episode`);
    }
  }
  if (holdouts.length === 0) return corpus;

  const overlays: Record<string, { validatorFrozenAtIso: string }> = {};
  const mergedById = new Map<string, Episode>();
  for (const episode of holdouts) {
    const file = path.join(overlayDir, `${episode.id}.validator.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new CorpusError(
        `${episode.id}: holdout overlay missing (${file}) — the validator must freeze the surface form before holdout cells may run`
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new CorpusError(`${episode.id}: holdout overlay is not valid JSON (${String(error)})`);
    }
    const overlay = ValidatorOverlaySchema.safeParse(json);
    if (!overlay.success) {
      throw new CorpusError(
        `${episode.id}: holdout overlay malformed: ${overlay.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }
    if (overlay.data.id !== episode.id) {
      throw new CorpusError(`${episode.id}: overlay file declares id ${overlay.data.id}`);
    }
    const baseById = new Map(episode.inputTurns.map((turn) => [turn.id, turn]));
    for (const turn of overlay.data.inputTurns) {
      const base = baseById.get(turn.id);
      if (!base) {
        throw new CorpusError(`${episode.id}: overlay turn ${turn.id} does not exist in the episode structure`);
      }
      if (base.kind !== turn.kind) {
        throw new CorpusError(
          `${episode.id}: overlay turn ${turn.id} is kind ${turn.kind}, episode declares ${base.kind}`
        );
      }
    }
    const inputTurns = episode.inputTurns.map((baseTurn) => {
      const overlayTurn = overlay.data.inputTurns.find((candidate) => candidate.id === baseTurn.id);
      if (!overlayTurn) {
        throw new CorpusError(`${episode.id}: overlay carries no wording for turn ${baseTurn.id}`);
      }
      return { id: baseTurn.id, kind: baseTurn.kind, text: overlayTurn.text, requiredWords: overlayTurn.requiredWords };
    });
    const revalidated = EpisodeSchema.safeParse({
      ...episode,
      holdout: false,
      inputTurns,
      expectedSlots: overlay.data.expectedSlots,
      approvalTurns: overlay.data.approvalTurns,
      repairBranches: overlay.data.repairBranches,
    });
    if (!revalidated.success) {
      throw new CorpusError(
        `${episode.id}: merged holdout episode failed schema validation: ${revalidated.error.issues
          .map((issue) => issue.message)
          .join('; ')}`
      );
    }
    mergedById.set(episode.id, revalidated.data);
    overlays[episode.id] = { validatorFrozenAtIso: overlay.data.validatorFrozenAtIso };
  }
  return {
    ...corpus,
    episodes: corpus.episodes.map((episode) => mergedById.get(episode.id) ?? episode),
    validatorOverlays: overlays,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/** Content hash over every episode plus the index — freezes with the corpus. */
export function corpusHash(corpus: LoadedCorpus): string {
  return createHash('sha256')
    .update(
      stableStringify({
        schemaVersion: corpus.schemaVersion,
        index: corpus.index,
        episodes: corpus.episodes,
      }),
      'utf8'
    )
    .digest('hex');
}
