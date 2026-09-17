/**
 * Mechanical director validation for the adaptive operator instrument
 * (Phase L6, plan §23; intent §14.5, §20.1).
 *
 * The adaptive simulator is the only measurement component in the lab with no
 * oracle: nothing records what the operator *would* have said next. The
 * director is the code-level answer to that — it does not judge whether a line
 * is a good line, only whether it is a *legal* line under the beat's declared
 * policy. Everything it decides is re-derivable from the trace, and every
 * refusal is returned as a reason string the simulator is re-asked with.
 *
 * Deliberately model-free. A rejected line is never spoken; the simulator is
 * re-asked exactly once with the reason appended, and a second consecutive
 * rejection ends the beat as `simulator-failure` (recorded under the
 * *simulator* failure in the report taxonomy and excluded from every candidate
 * quality denominator, §14.5 rule 3).
 *
 * Rejection precedence is fixed and documented so the by-reason breakdown is
 * reproducible: `json-shape` (nothing else can be inspected) → `turn-budget`
 * (the run is over, so the line is moot) → `style-violation` →
 * `over-length` → `permissions-violation` → `golden-truth-leakage` →
 * `disallowed-interrupt`.
 *
 * The pre-registered Gate 4 ceiling lives here: if more than 20 % of a
 * condition's adaptive proposals are rejected, that condition's adaptive beats
 * are reported `insufficient-evidence` rather than scored. It is a refusal
 * threshold, not a tuning target, and is fixed before any adaptive attempt.
 */

import { z } from 'zod';

import { classifyOperatorUtterance } from '../../../server/src/talker/utterance-classifier.js';
import type { ScenarioBeat } from './scenario.js';
import { goldenStringsFor, type WorkerWorld } from './worlds.js';

/** Every rejection reason the director can emit, in precedence order. */
export const REJECTION_REASONS = [
  'json-shape',
  'turn-budget',
  'style-violation',
  'over-length',
  'permissions-violation',
  'golden-truth-leakage',
  'disallowed-interrupt',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** `say` ≤ 60 words (intent §14.5). */
export const MAX_SAY_WORDS = 60;
/** `waitMs` is an integer in 0..4000 (intent §14.5). */
export const MAX_WAIT_MS = 4000;
/** Pre-registered Gate 4 refusal ceiling: > 20 % rejected ⇒ insufficient-evidence. */
export const MAX_REJECTION_RATE = 0.2;

/**
 * One segment of audio that actually PLAYED, as shadow-ASR text.
 *
 * Only played audio is evidence here: unplayed, muted or tool-logged text is
 * invisible to the operator by construction (§14.5, "What it sees").
 */
export interface HeardSegment {
  /** Played-segment index in the run, monotonic. */
  index: number;
  /** Shadow-ASR text of the segment. */
  text: string;
  /** Seconds into the run at which the segment started playing. */
  atSeconds: number;
  /** True when the operator barged in and cut this segment short. */
  interrupted?: boolean;
  /** Who was speaking: `assistant` (the candidate) by default. */
  source?: string;
}

/**
 * The simulator's per-turn reply, validated as a whole. Unknown keys are
 * stripped rather than rejected: a model that volunteers a little extra
 * bookkeeping is not the failure mode the ceiling exists to catch, and a strict
 * schema would inflate the rejection rate with instrument noise.
 */
export const directorProposalSchema = z.object({
  say: z.string().nullable(),
  interrupt: z.boolean(),
  waitMs: z.number().int().min(0).max(MAX_WAIT_MS),
  beatDone: z.boolean(),
  why: z.string(),
});
export type DirectorProposal = z.infer<typeof directorProposalSchema>;

export interface DirectorAcceptance {
  ok: true;
  proposal: DirectorProposal;
}
export interface DirectorRejection {
  ok: false;
  reason: RejectionReason;
  /** Human-readable explanation, no trailing punctuation. */
  detail: string;
  /** `${reason}: ${detail}` — the `R` appended to the re-ask (§14.5). */
  message: string;
}
export type DirectorDecision = DirectorAcceptance | DirectorRejection;

export function formatReAsk(rejection: DirectorRejection): string {
  return (
    'Your last proposed line was rejected by the director because: ' +
    `${rejection.message}. Please revise your response to respect the rules.`
  );
}

function rejection(reason: RejectionReason, detail: string): DirectorRejection {
  return { ok: false, reason, detail, message: `${reason}: ${detail}` };
}

// ---------------------------------------------------------------------------
// Style: British English, spoken prose, no markdown, no spelled-out paths
// ---------------------------------------------------------------------------

/**
 * Unambiguous American orthography. Deliberately spelling-only: a colloquialism
 * ("gotten", "math") is not evidence of a non-British *phrasing*, and adding it
 * would reject lines for being informal rather than for being off-language.
 */
const AMERICANISMS: Array<{ pattern: RegExp; british: string }> = [
  { pattern: /\bcolor(?:s|ed|ing)?\b/i, british: 'colour' },
  { pattern: /\bbehavior(?:s|al)?\b/i, british: 'behaviour' },
  { pattern: /\bcatalog\b/i, british: 'catalogue' },
  { pattern: /\borganiz(?:e|es|ed|ing|ation)\b/i, british: 'organise' },
  { pattern: /\brealiz(?:e|es|ed|ing)\b/i, british: 'realise' },
  { pattern: /\banalyz(?:e|es|ed|ing)\b/i, british: 'analyse' },
  { pattern: /\bcenter(?:s|ed|ing)?\b/i, british: 'centre' },
  { pattern: /\bdefense\b/i, british: 'defence' },
  { pattern: /\bfavor(?:s|ed|ing)?\b/i, british: 'favour' },
  { pattern: /\bhonor(?:s|ed|ing)?\b/i, british: 'honour' },
  { pattern: /\blabor\b/i, british: 'labour' },
  { pattern: /\bneighbor(?:s|hood|hoods)?\b/i, british: 'neighbour' },
  { pattern: /\bcanceled\b/i, british: 'cancelled' },
  { pattern: /\bmodeling\b/i, british: 'modelling' },
  { pattern: /\btraveled\b/i, british: 'travelled' },
];

/** Raw markdown that must never be spoken aloud. */
const MARKDOWN_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /`/, label: 'a backtick code span' },
  { pattern: /(^|\n)\s{0,3}#{1,6}\s/, label: 'a markdown heading' },
  { pattern: /\*\*[^*]+\*\*|\b__[^_]+__\b/, label: 'markdown bold' },
  { pattern: /\[[^\]]+\]\([^)]+\)/, label: 'a markdown link' },
  { pattern: /(^|\n)\s{0,3}[-*+]\s+\S/, label: 'a markdown list item' },
  { pattern: /(^|\n)\s*```/, label: 'a fenced code block' },
];

/** "c o n f i g" / "c-o-n-f-i-g": four or more single characters in a row. */
const SPELLED_OUT_RUN = /(^|\s)\w(?:[\s-]+\w){3,}(?=\s|$)/;
/** Two or more path-symbol words mean a path is being read aloud character by character. */
const PATH_WORD = /\b(?:slash|backslash|underscore|hyphen)\b/gi;

/** Markdown, spelled-out paths and American orthography in one `say` value. */
export function styleIssues(say: string, language = 'en-GB'): string[] {
  const issues: string[] = [];
  for (const marker of MARKDOWN_MARKERS) {
    if (marker.pattern.test(say)) issues.push(`contains ${marker.label}`);
  }
  if (SPELLED_OUT_RUN.test(say)) issues.push('spells a word or path out character by character');
  const pathWords = say.match(PATH_WORD) ?? [];
  if (pathWords.length >= 2) issues.push('reads a path aloud character by character');
  // The British-English rule is a property of the *scenario language*: a
  // non-en-GB variant keeps its markdown and path bans but not this one.
  if (language.toLowerCase().startsWith('en-gb')) {
    for (const americanism of AMERICANISMS) {
      if (americanism.pattern.test(say)) issues.push(`uses American spelling ("${americanism.british}")`);
    }
  }
  return issues;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Confirmation / proposal detection
// ---------------------------------------------------------------------------

/**
 * The confirmation-shaped vocabulary is the shipped talker classifier's
 * (`server/src/talker/utterance-classifier.ts`) so the lab's policy and the
 * product's gate can never drift into two different definitions of "yes".
 */
export function isConfirmationShaped(say: string): boolean {
  return classifyOperatorUtterance(say) === 'confirm';
}

/** The assistant proposed something the operator could now authorise. */
const PROPOSAL_PATTERN =
  /\b(shall i|should i|want me to|do you want me to|would you like me to|i(?:'ll| will) (?:send|ask|tell|relay)|i can (?:send|ask|tell|relay)|let me (?:send|ask|tell|relay)|ready to (?:send|relay)|here(?:'s| is) (?:what|the drafting)|proposed|draft(?:ed|ing)?|confirm)\b/i;
/** "...?" — a question is an invitation to confirm. */
const QUESTION_SHAPE = /\?\s*$/;

/**
 * True when what the operator actually HEARD contains a proposal or a question
 * that a confirmation could legitimately answer. A question counts only when it
 * is also an invitation (trailing `?` and a proposal-ish or read-back shape):
 * "what is worker two doing?" is a question, not an authorisation.
 */
export function heardHasPendingProposal(heard: HeardSegment[]): boolean {
  return heard.some((segment) => {
    const text = segment.text.trim();
    if (text === '') return false;
    if (PROPOSAL_PATTERN.test(text)) return true;
    return QUESTION_SHAPE.test(text) && /\b(send|ask|tell|relay|draft|ready|confirm|okay|ok|shall|should|want)\b/i.test(text);
  });
}

// ---------------------------------------------------------------------------
// Golden-truth leakage
// ---------------------------------------------------------------------------

function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** True when `needle` appears as a contiguous word run inside `haystack`. */
export function containsWordRun(haystack: string, needle: string): boolean {
  const hay = normaliseWords(haystack);
  const run = normaliseWords(needle);
  if (run.length === 0) return false;
  for (let start = 0; start + run.length <= hay.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < run.length; offset += 1) {
      if (hay[start + offset] !== run[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

export interface LeakCheckInput {
  say: string;
  goldenStrings: string[];
  /** Text the operator has already heard or said — a fact here is revealed. */
  revealed: string[];
}

/**
 * A hidden fact may be *referred to* only after it has been revealed. Before
 * that, mentioning it is the simulator inventing the world truth — the exact
 * failure the plan names as the simulator's likeliest and most damaging.
 */
export function findGoldenTruthLeak(input: LeakCheckInput): string | null {
  for (const golden of input.goldenStrings) {
    if (golden.trim() === '') continue;
    if (!containsWordRun(input.say, golden)) continue;
    const alreadyRevealed = input.revealed.some((text) => containsWordRun(text, golden));
    if (!alreadyRevealed) return golden;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rejection ledger
// ---------------------------------------------------------------------------

export interface RejectionEntry {
  reason: RejectionReason;
  detail: string;
  beatId: string;
  /** The proposal text (or the raw model text when it did not parse). */
  say: string | null;
}

export function emptyReasonCounts(): Record<RejectionReason, number> {
  const counts = {} as Record<RejectionReason, number>;
  for (const reason of REJECTION_REASONS) counts[reason] = 0;
  return counts;
}

/**
 * Every proposal ever validated by this director, accepted or not. A re-ask is
 * a *new* proposal, so it counts too — that is precisely what lets a bad
 * simulator shrink the sample visibly instead of silently.
 */
export class RejectionLedger {
  readonly entries: RejectionEntry[] = [];
  totalProposals = 0;
  acceptedProposals = 0;

  record(entry: RejectionEntry): void {
    this.entries.push(entry);
  }

  noteProposal(): void {
    this.totalProposals += 1;
  }

  noteAccepted(): void {
    this.acceptedProposals += 1;
  }

  get rejectedCount(): number {
    return this.entries.length;
  }

  /** rejected / total; 0 total ⇒ 0 (an instrument that never proposed is not "clean"). */
  get rejectionRate(): number {
    return this.totalProposals === 0 ? 0 : this.rejectedCount / this.totalProposals;
  }

  byReason(): Record<RejectionReason, number> {
    const counts = emptyReasonCounts();
    for (const entry of this.entries) counts[entry.reason] += 1;
    return counts;
  }

  /** The pre-registered Gate 4 refusal rule (§14.5 rule 2). */
  insufficientEvidence(ceiling: number = MAX_REJECTION_RATE): boolean {
    return this.rejectionRate > ceiling;
  }
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

export interface DirectorPolicy {
  scenarioId: string;
  /** Scenario language; the lab condition is `en-GB`. */
  language: string;
  /** Hidden truth for the leakage check; omit when the scenario has no world. */
  world?: WorkerWorld;
  /** `scenario.budgets.maxOperatorTurns`, total across the run. */
  maxOperatorTurns?: number;
}

export interface ProposalContext {
  beat: ScenarioBeat;
  /** Segments that actually played this beat, oldest first. */
  heard: HeardSegment[];
  /** The operator's own lines so far this beat, oldest first. */
  earlierLines: string[];
}

export interface BeatMode {
  beatId: string;
  mode: ScenarioBeat['mode'];
}

export type BeatRunStatus =
  | 'completed'
  | 'simulator-failure'
  | 'budget-stopped'
  | 'missed-condition'
  | 'not-run';

export interface BeatOutcome extends BeatMode {
  status: BeatRunStatus;
}

export interface InstrumentReport {
  totalProposals: number;
  accepted: number;
  rejected: number;
  rejectionRate: number;
  byReason: Record<RejectionReason, number>;
  ceiling: number;
  /** True when the rejection rate exceeds the pre-registered ceiling. */
  insufficientEvidence: boolean;
  /** Beats that died as instrument failures. */
  simulatorFailures: string[];
  /** Beats excluded from every candidate quality denominator. */
  excludedBeats: string[];
  /** Beats a candidate may legitimately be scored on. */
  scorableBeats: string[];
  /** §20.1(a): a headline may not rest on adaptive beats alone. */
  adaptiveOnly: boolean;
}

export class Director {
  private readonly policy: DirectorPolicy;
  private readonly ledger = new RejectionLedger();
  private readonly beatTurns = new Map<string, number>();
  private totalTurns = 0;

  constructor(policy: DirectorPolicy) {
    this.policy = policy;
  }

  get rejections(): RejectionLedger {
    return this.ledger;
  }

  get turnsUsed(): number {
    return this.totalTurns;
  }

  turnsUsedIn(beatId: string): number {
    return this.beatTurns.get(beatId) ?? 0;
  }

  /** Interruption is permitted by the beat flag or an explicit `stop-talker` grant. */
  canInterrupt(beat: ScenarioBeat): boolean {
    return beat.interrupt === true || (beat.permissions ?? []).includes('stop-talker');
  }

  private hasConfirmGrant(beat: ScenarioBeat): boolean {
    return (beat.permissions ?? []).some(
      (permission) => permission.startsWith('confirm:') || permission === 'card:confirm'
    );
  }

  private maxTurnsFor(beat: ScenarioBeat): number {
    return beat.maxTurns ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Validate one simulator proposal. On acceptance of a *spoken* line the
   * operator turn is consumed immediately; a silent/beat-done move does not
   * spend turn budget.
   */
  validate(raw: unknown, context: ProposalContext): DirectorDecision {
    const { beat, heard, earlierLines } = context;
    this.ledger.noteProposal();

    const parsed = directorProposalSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return this.reject(rejection('json-shape', `expected { say, interrupt, waitMs, beatDone, why } — ${issues}`), beat, null);
    }
    const proposal = parsed.data;

    if (proposal.say !== null) {
      const beatLimit = this.maxTurnsFor(beat);
      if (this.turnsUsedIn(beat.id) + 1 > beatLimit) {
        return this.reject(
          rejection('turn-budget', `the beat budget of ${beatLimit} operator turns is exhausted`),
          beat,
          proposal.say
        );
      }
      if (this.policy.maxOperatorTurns !== undefined && this.totalTurns + 1 > this.policy.maxOperatorTurns) {
        return this.reject(
          rejection('turn-budget', `the run budget of ${this.policy.maxOperatorTurns} operator turns is exhausted`),
          beat,
          proposal.say
        );
      }

      const say = proposal.say.trim();
      const style = styleIssues(say, this.policy.language);
      if (style.length > 0) {
        return this.reject(rejection('style-violation', style.join('; ')), beat, proposal.say);
      }

      const words = countWords(say);
      if (words > MAX_SAY_WORDS) {
        return this.reject(
          rejection('over-length', `${words} words exceeds the ${MAX_SAY_WORDS}-word limit`),
          beat,
          proposal.say
        );
      }

      if (isConfirmationShaped(say)) {
        if (!this.hasConfirmGrant(beat)) {
          return this.reject(
            rejection('permissions-violation', 'this beat does not authorise a confirmation'),
            beat,
            proposal.say
          );
        }
        if (!heardHasPendingProposal(heard)) {
          return this.reject(
            rejection(
              'permissions-violation',
              'a confirmation needs an assistant proposal the operator actually heard, and nothing heard so far proposes one'
            ),
            beat,
            proposal.say
          );
        }
      }

      const goldenStrings = this.policy.world ? goldenStringsFor(this.policy.world) : [];
      if (goldenStrings.length > 0) {
        const revealed = [...heard.map((segment) => segment.text), ...earlierLines];
        const leak = findGoldenTruthLeak({ say, goldenStrings, revealed });
        if (leak !== null) {
          return this.reject(
            rejection('golden-truth-leakage', `the line reveals a hidden world fact the operator has not heard`),
            beat,
            proposal.say
          );
        }
      }

      if (proposal.interrupt && !this.canInterrupt(beat)) {
        return this.reject(
          rejection('disallowed-interrupt', 'this beat does not permit interruption'),
          beat,
          proposal.say
        );
      }
    }

    this.ledger.noteAccepted();
    // An operator turn is a *spoken* line: a silent/beat-done move consumes no
    // turn budget, so the model cannot exhaust a beat by staying quiet.
    if (proposal.say !== null) {
      this.totalTurns += 1;
      this.beatTurns.set(beat.id, this.turnsUsedIn(beat.id) + 1);
    }
    return { ok: true, proposal };
  }

  private reject(decision: DirectorRejection, beat: ScenarioBeat, say: string | null): DirectorRejection {
    // A leakage rejection must never persist the offending text: the hidden
    // truth is by definition not yet revealed, so keeping it here would put a
    // golden string into the trace and make the offline verifier fail a run for
    // the *instrument's* own mistake. The detail is worded so it names no fact.
    const recorded = decision.reason === 'golden-truth-leakage' ? null : say;
    this.ledger.record({ reason: decision.reason, detail: decision.detail, beatId: beat.id, say: recorded });
    return decision;
  }
}

/** Aggregate the ledger and the beat outcomes into the Gate 4 instrument report. */
export function evaluateInstrument(
  ledger: RejectionLedger,
  beats: BeatOutcome[],
  options: { ceiling?: number } = {}
): InstrumentReport {
  const ceiling = options.ceiling ?? MAX_REJECTION_RATE;
  const simulatorFailures = beats.filter((beat) => beat.status === 'simulator-failure').map((beat) => beat.beatId);
  // §14.2: a missed overlap condition is reported as `missed-condition`, not scored.
  const missed = beats.filter((beat) => beat.status === 'missed-condition').map((beat) => beat.beatId);
  const excludedBeats = [...new Set([...simulatorFailures, ...missed])];
  const scorableBeats = beats
    .filter((beat) => !excludedBeats.includes(beat.beatId) && beat.status !== 'not-run')
    .map((beat) => beat.beatId);
  const adaptiveIds = new Set(beats.filter((beat) => beat.mode === 'adaptive').map((beat) => beat.beatId));

  return {
    totalProposals: ledger.totalProposals,
    accepted: ledger.acceptedProposals,
    rejected: ledger.rejectedCount,
    rejectionRate: ledger.rejectionRate,
    byReason: ledger.byReason(),
    ceiling,
    insufficientEvidence: ledger.insufficientEvidence(ceiling),
    simulatorFailures,
    excludedBeats,
    scorableBeats,
    adaptiveOnly: scorableBeats.length > 0 && scorableBeats.every((beatId) => adaptiveIds.has(beatId)),
  };
}
