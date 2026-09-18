/**
 * Fidelity corpus loader and scoring helpers (Voice Mode execution plan,
 * Phase 6; architecture recommendation 2026-09 §7.1.3).
 *
 * This module is deliberately self-contained. It reads the migrated fixture at
 * `server/tests/fixtures/fidelity-corpus.json` and implements the mechanical
 * scoring rules the eventual Phase 6 veto suites score against:
 *
 *   - **Required-word recall** — the terms that must survive into a composed
 *     send (for composed questions as well as instructions).
 *   - **Critical-token retention** — negations (`not`, `never`), conditionals
 *     (`if`, `unless`), file paths and target names. A phrase survives only when
 *     its content words AND its own qualifier survive: a negation whose "not"
 *     vanished has lost its constraint even though every noun is still there.
 *   - **Recognised → Delivered byte equality** for semi-verbatim operator
 *     instructions (`byteEqual`).
 *
 * The frozen corpus (§7.1.3) is a *data* artefact: this file never writes to it
 * and never re-words it. Where the corpus is silent (it declares no file-path
 * token), the helper still scores the class so the absence is measurable rather
 * than invisible.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIDELITY_CORPUS_SCHEMA = 'voice-lab.fidelity-corpus/1';

export const FIDELITY_CORPUS_ITEM_KEYS = [
  'id',
  'utterance',
  'recognisedText',
  'requiredWords',
  'negations',
  'conditionals',
  'targets',
  'distractors',
  'notes',
] as const;

export interface FidelityItem {
  /** `fc-01` … `fc-20`. */
  id: string;
  /** A realistic spoken instruction: pauses, contractions, thinking aloud. */
  utterance: string;
  /**
   * The frozen recognised text the harness receives from the (hermetic)
   * transcription lane. In the frozen fixture this is byte-identical to the
   * reference `utterance` (the lab never performed a scored live capture); the
   * provenance header records that source. Recognition WER is scored from this
   * field to the reference utterance, and semi-verbatim byte equality is scored
   * from this field to the delivered instruction.
   */
  recognisedText?: string;
  /** Terms that must survive into the composed send. */
  requiredWords: string[];
  /** Negative constraints ("do not touch the migration"). */
  negations: string[];
  /** Conditional constraints ("only after the tests pass"). */
  conditionals: string[];
  /** Which child / file / component the instruction is about. */
  targets: string[];
  /** Preamble or asides the composed send should drop. */
  distractors: string[];
  notes?: string;
}

/** Where the frozen corpus came from, recorded on migration (brief Task 2). */
export interface FidelityCorpusProvenance {
  sourceRepo: string;
  sourcePath: string;
  sourceCommit: string;
  sourceCommitSubject?: string;
  sourceFileCommit?: string;
  sourceFileCommitSubject?: string;
  sourceBlobSha1?: string;
  sourceSha256?: string;
  migratedAt?: string;
  migratedBy?: string;
  note?: string;
}

export interface FidelityCorpus {
  schema: string;
  id: string;
  version: string;
  /** The world every item is set in (one world, §20.5b). */
  world?: string;
  description?: string;
  provenance?: FidelityCorpusProvenance;
  /** Where the frozen recognised text came from (Phase 6 hermetic lane). */
  recognisedProvenance?: {
    source: string;
    note?: string;
    addedAt?: string;
    addedBy?: string;
    recognisedField?: string;
  };
  observedGaps?: string[];
  items: FidelityItem[];
}

const STOPWORDS = new Set([
  'the','and','for','that','this','with','from','they','them','then','than','there','here','into','onto','over',
  'under','about','after','before','when','what','which','while','your','yours','you','yourself','its','it','its',
  'was','were','are','is','be','been','being','have','has','had','will','would','shall','should','can','could',
  'may','might','must','not','but','just','like','also','very','much','more','most','some','any','all','one','two',
  'out','off','down','up','again','only','now','well','really','actually','thing','things','kind','sort','stuff',
  'okay','right','yeah','yep','ok','let','lets','get','got','going','want','need','make','made','use','used',
  'say','said','tell','told','ask','asked','back','around','because','when','whatever','maybe',
]);

/** Lower-cased alphanumeric tokens of three or more characters, stopwords out. */
export function contentTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[-']+|[-']+$/g, ''))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function tokenSet(text: string): Set<string> {
  return new Set(contentTokens(text));
}

// ── Qualifier cues ──────────────────────────────────────────────────────────

/** Negation qualifiers. `not`/`never` are the §7.1.3 headline cues. */
export const NEGATION_CUES = /\b(not|never|no|without|avoid|untouched|alone|don'?t|doesn'?t|mustn'?t|shouldn'?t|isn'?t)\b/gi;
/** Conditional qualifiers. `if`/`unless` are the §7.1.3 headline cues. */
export const CONDITIONAL_CUES = /\b(if|only|after|once|before|when|unless|provided|until|wait)\b/gi;
/** The strict §7.1.3 negation tokens. */
export const CRITICAL_NEGATION_CUES = /\b(not|never)\b/gi;
/** The strict §7.1.3 conditional tokens. */
export const CRITICAL_CONDITIONAL_CUES = /\b(if|unless)\b/gi;

/**
 * A path-like token: at least one slash, e.g. `src/talker/policy-core.ts`,
 * `./scripts/x.mjs`, `/root/pi-web-ui/server`. Deliberately permissive: the
 * class exists to catch a dropped path, not to be a filesystem parser.
 */
export const FILE_PATH_PATTERN = /(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The qualifier words this phrase actually uses ("only after" → both). */
export function cueWordsIn(phrase: string, pattern: RegExp): string[] {
  const matches = phrase.match(new RegExp(pattern.source, pattern.flags)) ?? [];
  return [...new Set(matches.map((match) => match.toLowerCase()))];
}

/** Distinct file-path tokens in a piece of text. */
export function filePathsIn(text: string): string[] {
  const matches = text.match(new RegExp(FILE_PATH_PATTERN.source, FILE_PATH_PATTERN.flags)) ?? [];
  return [...new Set(matches.map((match) => match.trim()).filter((match) => /[a-z]/i.test(match)))];
}

/** Distinct cue words (not|never, or if|unless) present in a piece of text. */
export function criticalCuesIn(text: string, pattern: RegExp): string[] {
  return cueWordsIn(text, pattern);
}

// ── Per-class survival ──────────────────────────────────────────────────────

export interface FidelityClassSurvival {
  total: number;
  survived: number;
  ratio: number;
  dropped: string[];
}

function phrasePresent(phrase: string, sentText: string, sentTokens: Set<string>): boolean {
  const tokens = contentTokens(phrase);
  if (tokens.length === 0) return sentText.toLowerCase().includes(phrase.toLowerCase());
  return tokens.every((token) => sentTokens.has(token));
}

/**
 * A phrase survives only when its content words AND its OWN qualifier words
 * survive. A phrase whose qualifier vanished has lost its constraint even when
 * every noun is still present.
 */
function phraseSurvives(phrase: string, sentText: string, sentTokens: Set<string>, pattern?: RegExp): boolean {
  if (!phrasePresent(phrase, sentText, sentTokens)) return false;
  if (!pattern) return true;
  return cueWordsIn(phrase, pattern).every((cue) =>
    new RegExp(`\\b${escapeRegExp(cue)}\\b`, 'i').test(sentText)
  );
}

function survivalOf(phrases: string[], sentText: string, sentTokens: Set<string>, cue?: RegExp): FidelityClassSurvival {
  const dropped: string[] = [];
  let survived = 0;
  for (const phrase of phrases) {
    if (phraseSurvives(phrase, sentText, sentTokens, cue)) survived += 1;
    else dropped.push(phrase);
  }
  return {
    total: phrases.length,
    survived,
    ratio: phrases.length === 0 ? 1 : survived / phrases.length,
    dropped,
  };
}

/** Literal-token survival for tokens that must appear verbatim (cues, paths). */
function literalSurvival(tokens: string[], sentText: string): FidelityClassSurvival {
  const dropped = tokens.filter(
    (token) => !new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(sentText)
  );
  return {
    total: tokens.length,
    survived: tokens.length - dropped.length,
    ratio: tokens.length === 0 ? 1 : (tokens.length - dropped.length) / tokens.length,
    dropped,
  };
}

// ── The §7.1.3 critical-token retention view ────────────────────────────────

export interface CriticalTokenRetention {
  /** Negation phrases ("do not touch the auth routes"). */
  negations: FidelityClassSurvival;
  /** Conditional phrases ("only if the tests pass"). */
  conditionals: FidelityClassSurvival;
  /** Target names / components. */
  targets: FidelityClassSurvival;
  /** File paths declared inside the item's critical phrases. */
  filePaths: FidelityClassSurvival;
  /** Bare negation cues (not|never) inside the declared negations. */
  negationCues: FidelityClassSurvival;
  /** Bare conditional cues (if|unless) inside the declared conditionals. */
  conditionalCues: FidelityClassSurvival;
  /** True when every critical class retained all of its tokens. */
  intact: boolean;
}

/**
 * Critical-token retention for one item: negations, conditionals, file paths
 * and target names, scored on the delivered/recognised text.
 *
 * Cue and path tokens are derived from the item's *declared critical phrases*
 * (required words, targets, negations, conditionals) rather than the raw
 * utterance. A bare "not" inside a separable preamble is not a constraint, and
 * counting it would report a retention failure for a correct composer that
 * dropped the preamble.
 */
export function criticalTokenRetention(item: FidelityItem, sentText: string): CriticalTokenRetention {
  const sentTokens = tokenSet(sentText);
  const negations = survivalOf(item.negations, sentText, sentTokens, NEGATION_CUES);
  const conditionals = survivalOf(item.conditionals, sentText, sentTokens, CONDITIONAL_CUES);
  const targets = survivalOf(item.targets, sentText, sentTokens);
  const criticalPhrases = [
    ...item.requiredWords,
    ...item.targets,
    ...item.negations,
    ...item.conditionals,
  ].join(' ');
  const filePaths = literalSurvival(filePathsIn(criticalPhrases), sentText);
  const negationCues = literalSurvival(
    criticalCuesIn(item.negations.join(' '), CRITICAL_NEGATION_CUES),
    sentText
  );
  const conditionalCues = literalSurvival(
    criticalCuesIn(item.conditionals.join(' '), CRITICAL_CONDITIONAL_CUES),
    sentText
  );
  const classes = [negations, conditionals, targets, filePaths, negationCues, conditionalCues];
  return {
    negations,
    conditionals,
    targets,
    filePaths,
    negationCues,
    conditionalCues,
    intact: classes.every((entry) => entry.ratio === 1),
  };
}

// ── Whole-item scoring ──────────────────────────────────────────────────────

export interface FidelityScore {
  itemId: string;
  /** Required-word recall on the text being scored. */
  recall: number;
  requiredTotal: number;
  requiredRecalled: number;
  missingRequired: string[];
  negations: FidelityClassSurvival;
  conditionals: FidelityClassSurvival;
  targets: FidelityClassSurvival;
  /** Critical-token retention, including file paths and bare cues. */
  critical: CriticalTokenRetention;
  /** Fraction of the item's distractors still present (0 = all dropped). */
  distractorLeakage: number;
  leakedDistractors: string[];
  /** Sent words / operator words. */
  lengthRatio: number;
  sentWords: number;
  operatorWords: number;
  /** Content tokens in the send that are NOT in the operator's utterance and
   *  are not filler: a candidate list for the added-constraints rubric, never
   *  an automatic verdict. */
  unexplainedAdditions: string[];
}

/**
 * Score one composed/delivered send against one corpus item. Every rule is
 * mechanical: recall is required-word presence; a negation survives only when
 * its content words AND a negation cue are present; a conditional likewise; a
 * target needs its words; a distractor is "leaked" when ≥ 2 of its distinctive
 * words appear.
 */
export function scoreFidelityItem(item: FidelityItem, sentText: string, operatorText?: string): FidelityScore {
  const operator = operatorText ?? item.utterance;
  const sentTokens = tokenSet(sentText);
  const sentWords = sentText.trim().split(/\s+/).filter(Boolean).length;
  const operatorWords = operator.trim().split(/\s+/).filter(Boolean).length;

  const missingRequired = item.requiredWords.filter((word) => !phrasePresent(word, sentText, sentTokens));
  const requiredRecalled = item.requiredWords.length - missingRequired.length;

  const protectedTokens = new Set<string>([
    ...item.requiredWords.flatMap((word) => contentTokens(word)),
    ...item.targets.flatMap((word) => contentTokens(word)),
    ...item.negations.flatMap((phrase) => contentTokens(phrase)),
    ...item.conditionals.flatMap((phrase) => contentTokens(phrase)),
  ]);

  const leakedDistractors: string[] = [];
  for (const distractor of item.distractors) {
    const distinctive = contentTokens(distractor).filter((token) => token.length >= 4 && !protectedTokens.has(token));
    const present = distinctive.filter((token) => sentTokens.has(token));
    if (present.length >= 2) leakedDistractors.push(distractor);
  }

  const operatorTokens = tokenSet(operator);
  const unexplainedAdditions = [...sentTokens].filter((token) => !operatorTokens.has(token) && token.length >= 4);

  return {
    itemId: item.id,
    recall: item.requiredWords.length === 0 ? 1 : requiredRecalled / item.requiredWords.length,
    requiredTotal: item.requiredWords.length,
    requiredRecalled,
    missingRequired,
    negations: survivalOf(item.negations, sentText, sentTokens, NEGATION_CUES),
    conditionals: survivalOf(item.conditionals, sentText, sentTokens, CONDITIONAL_CUES),
    targets: survivalOf(item.targets, sentText, sentTokens),
    critical: criticalTokenRetention(item, sentText),
    distractorLeakage: item.distractors.length === 0 ? 0 : leakedDistractors.length / item.distractors.length,
    leakedDistractors,
    lengthRatio: operatorWords === 0 ? 0 : sentWords / operatorWords,
    sentWords,
    operatorWords,
    unexplainedAdditions,
  };
}

export interface FidelityAggregate {
  items: number;
  /** Mean required-word recall across items. */
  recall: number;
  requiredWordsRecalled: number;
  requiredWordsTotal: number;
  negationSurvival: number;
  conditionalSurvival: number;
  targetSurvival: number;
  /** Mean critical-token retention across items. */
  criticalSurvival: number;
  /** Mean leaked-distractor fraction (0 = every distractor dropped). */
  distractorLeakage: number;
  lengthRatio: number;
  perItem: FidelityScore[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateFidelity(scores: FidelityScore[]): FidelityAggregate {
  return {
    items: scores.length,
    recall: mean(scores.map((score) => score.recall)),
    requiredWordsRecalled: scores.reduce((sum, score) => sum + score.requiredRecalled, 0),
    requiredWordsTotal: scores.reduce((sum, score) => sum + score.requiredTotal, 0),
    negationSurvival: mean(scores.map((score) => score.negations.ratio)),
    conditionalSurvival: mean(scores.map((score) => score.conditionals.ratio)),
    targetSurvival: mean(scores.map((score) => score.targets.ratio)),
    criticalSurvival: mean(scores.map((score) => score.critical.intact ? 1 : 0)),
    distractorLeakage: mean(scores.map((score) => score.distractorLeakage)),
    lengthRatio: mean(scores.map((score) => score.lengthRatio)),
    perItem: scores,
  };
}

// ── Semi-verbatim delivery ──────────────────────────────────────────────────

/**
 * Recognised → Delivered byte equality: for semi-verbatim operator
 * instructions the bytes handed to the worker must equal the recognised bytes,
 * character for character (§7.1.3).
 */
export function byteEqual(recognised: string, delivered: string): boolean {
  return recognised === delivered;
}

/**
 * The hermetic "perfect composer": keeps the operator's words verbatim and
 * removes the declared distractors. A scripted stand-in, never a model — it
 * exists to prove the corpus is scoreable and to give a worked example.
 */
export function composeCandidateText(item: FidelityItem): string {
  let text = item.utterance;
  for (const distractor of item.distractors) {
    text = text.split(distractor).join(' ');
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

// ── Recognition (WER) and the hermetic transcription lane ─────────────────

/**
 * Words for the recognition metric: lower-cased letters/digits, apostrophes
 * folded away, punctuation a separator — the same normalisation the lab's own
 * fixture gate uses (`scripts/voice-live-lab/lib/fixtures.ts:normaliseWords`),
 * restated here so the regression suite stays self-contained and hermetic.
 */
export function recognitionWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/**
 * Levenshtein word error rate: (substitutions + insertions + deletions) over
 * the reference length. 0 is perfect; 1 means every reference word was lost.
 * Pure and deterministic, so recognition scoring is repeated identically.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = recognitionWords(reference);
  const hyp = recognitionWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let previous = new Array<number>(hyp.length + 1);
  for (let j = 0; j <= hyp.length; j += 1) previous[j] = j;
  for (let i = 1; i <= ref.length; i += 1) {
    const current = new Array<number>(hyp.length + 1);
    current[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[hyp.length] / ref.length;
}

/**
 * One item's recognition score: how faithfully the frozen recognised text
 * carries the operator's words, and whether anything that must survive was
 * lost at the recognition step (before any composition or relay).
 */
export interface RecognitionScore {
  itemId: string;
  referenceWords: number;
  recognisedWords: number;
  wer: number;
  /** Required-word recall measured on the recognised text. */
  recall: number;
  missingRequired: string[];
  /** Negation / conditional / cue / target retention on the recognised text. */
  critical: CriticalTokenRetention;
  /** True when recognition dropped nothing that matters (§7.1.3). */
  intact: boolean;
}

/**
 * Score recognition for one item: WER of the frozen recognised text against
 * the reference utterance, plus recall and critical-token retention measured on
 * that same recognised text.
 */
export function scoreRecognition(item: FidelityItem, recognisedText: string): RecognitionScore {
  const recognised = recognisedText ?? item.utterance;
  const recognisedTokens = tokenSet(recognised);
  const missingRequired = item.requiredWords.filter(
    (word) => !phrasePresent(word, recognised, recognisedTokens)
  );
  const critical = criticalTokenRetention(item, recognised);
  return {
    itemId: item.id,
    referenceWords: recognitionWords(item.utterance).length,
    recognisedWords: recognitionWords(recognised).length,
    wer: wordErrorRate(item.utterance, recognised),
    recall:
      item.requiredWords.length === 0
        ? 1
        : (item.requiredWords.length - missingRequired.length) / item.requiredWords.length,
    missingRequired,
    critical,
    intact: missingRequired.length === 0 && critical.intact,
  };
}

export interface RecognitionAggregate {
  items: number;
  /** Mean recognition WER across items. */
  wer: number;
  /** Greatest per-item WER (a single bad item cannot hide behind the mean). */
  maxWer: number;
  recall: number;
  /** Fraction of items that lost nothing at recognition. */
  intactRatio: number;
  negationCueRetention: number;
  conditionalCueRetention: number;
  perItem: RecognitionScore[];
}

function recognitionMean(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateRecognition(scores: RecognitionScore[]): RecognitionAggregate {
  return {
    items: scores.length,
    wer: recognitionMean(scores.map((score) => score.wer)),
    maxWer: scores.reduce((max, score) => Math.max(max, score.wer), 0),
    recall: recognitionMean(scores.map((score) => score.recall)),
    intactRatio: recognitionMean(scores.map((score) => (score.intact ? 1 : 0))),
    negationCueRetention: recognitionMean(scores.map((score) => score.critical.negationCues.ratio)),
    conditionalCueRetention: recognitionMean(scores.map((score) => score.critical.conditionalCues.ratio)),
    perItem: scores,
  };
}

/**
 * Coverage of the frozen recognised text: every item carries it, and the
 * provenance header names where it came from. Returns named problems, so a
 * missing or damaged hermetic transcription lane is a failure rather than a
 * silent WER of 0.
 */
export function recognisedTextProblems(corpus: FidelityCorpus): string[] {
  const problems: string[] = [];
  if (!corpus.recognisedProvenance) {
    problems.push('recognisedProvenance is missing: the frozen recognised text has no recorded source');
  } else if (
    typeof corpus.recognisedProvenance.source !== 'string' ||
    corpus.recognisedProvenance.source.trim() === ''
  ) {
    problems.push('recognisedProvenance.source must be a non-empty string');
  }
  for (const item of corpus.items) {
    if (typeof item.recognisedText !== 'string' || item.recognisedText.trim() === '') {
      problems.push(
        `${item.id}: recognisedText is missing or empty (the suite cannot score a recognition lane it does not have)`
      );
    }
  }
  return problems;
}

// ─ Validation + loading ────────────────────────────────────────────────────

/** Validate one corpus document. Structural mistakes are named problems. */
export function validateFidelityCorpus(value: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: ['corpus is not an object'] };
  }
  const corpus = value as unknown as FidelityCorpus;
  if (corpus.schema !== FIDELITY_CORPUS_SCHEMA) {
    problems.push(`schema must be ${FIDELITY_CORPUS_SCHEMA}, got ${String(corpus.schema)}`);
  }
  if (typeof corpus.id !== 'string' || corpus.id.trim() === '') problems.push('id must be a non-empty string');
  if (typeof corpus.version !== 'string' || corpus.version.trim() === '') {
    problems.push('version must be a non-empty string (a frozen corpus is versioned)');
  }
  if (!Array.isArray(corpus.items) || corpus.items.length === 0) {
    return { ok: false, problems: [...problems, 'items must be a non-empty array'] };
  }
  if (corpus.items.length !== 20) {
    problems.push(`the corpus is 20 instruction utterances (§20.5b); got ${corpus.items.length}`);
  }
  const seen = new Set<string>();
  corpus.items.forEach((item, index) => {
    const where = `items[${index}]`;
    if (typeof item !== 'object' || item === null) {
      problems.push(`${where}: not an object`);
      return;
    }
    for (const key of Object.keys(item as unknown as Record<string, unknown>)) {
      if (!(FIDELITY_CORPUS_ITEM_KEYS as readonly string[]).includes(key)) {
        problems.push(`${where}: unknown key "${key}" (a frozen corpus rejects extras rather than ignoring them)`);
      }
    }
    if (typeof item.id !== 'string' || !/^fc-\d{2}$/.test(item.id)) {
      problems.push(`${where}: id must be fc-NN, got ${String(item.id)}`);
    } else if (seen.has(item.id)) {
      problems.push(`${where}: duplicate id ${item.id}`);
    } else {
      seen.add(item.id);
    }
    if (typeof item.utterance !== 'string' || item.utterance.trim().split(/\s+/).length < 8) {
      problems.push(`${where}: utterance must be a spoken instruction of at least 8 words`);
    }
    for (const field of ['requiredWords', 'negations', 'conditionals', 'targets', 'distractors'] as const) {
      const entries = item[field];
      if (!Array.isArray(entries)) {
        problems.push(`${where}: ${field} must be a string array (empty is allowed for a real absence)`);
        continue;
      }
      entries.forEach((entry, entryIndex) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          problems.push(`${where}.${field}[${entryIndex}]: must be a non-empty string`);
        }
      });
    }
    for (const field of ['requiredWords', 'targets', 'distractors'] as const) {
      if (Array.isArray(item[field]) && item[field].length === 0) {
        problems.push(`${where}: ${field} must declare at least one entry`);
      }
    }
    const negations = Array.isArray(item.negations) ? item.negations.length : 0;
    const conditionals = Array.isArray(item.conditionals) ? item.conditionals.length : 0;
    if (negations + conditionals === 0) {
      problems.push(`${where}: an instruction that constrains nothing declares no negation and no conditional`);
    }
    if (typeof item.utterance === 'string') {
      const utteranceTokens = tokenSet(item.utterance);
      if (Array.isArray(item.requiredWords)) {
        for (const word of item.requiredWords) {
          if (!phrasePresent(word, item.utterance, utteranceTokens)) {
            problems.push(`${where}: required word "${word}" does not appear in the utterance`);
          }
          if (contentTokens(word).length === 0) {
            problems.push(`${where}: required word "${word}" has no content tokens to score`);
          }
        }
      }
      for (const field of ['negations', 'conditionals'] as const) {
        if (!Array.isArray(item[field])) continue;
        for (const phrase of item[field]) {
          if (!phrasePresent(phrase, item.utterance, utteranceTokens)) {
            problems.push(`${where}: ${field} phrase "${phrase}" does not appear in the utterance`);
          }
        }
      }
      if (Array.isArray(item.targets)) {
        for (const target of item.targets) {
          const tokens = contentTokens(target);
          if (tokens.length > 0 && !tokens.every((token) => utteranceTokens.has(token))) {
            problems.push(`${where}: target "${target}" does not appear in the utterance`);
          }
        }
      }
    }
    if (Array.isArray(item.negations)) {
      for (const phrase of item.negations) {
        if (cueWordsIn(phrase, NEGATION_CUES).length === 0) {
          problems.push(`${where}: negation "${phrase}" carries no negative qualifier to lose`);
        }
      }
    }
    if (Array.isArray(item.conditionals)) {
      for (const phrase of item.conditionals) {
        if (cueWordsIn(phrase, CONDITIONAL_CUES).length === 0) {
          problems.push(`${where}: conditional "${phrase}" carries no conditional qualifier to lose`);
        }
      }
    }
    if (Array.isArray(item.distractors) && Array.isArray(item.requiredWords)) {
      const required = new Set(item.requiredWords.flatMap((word) => contentTokens(word)));
      for (const distractor of item.distractors) {
        const distinctive = contentTokens(distractor).filter((token) => token.length >= 4 && !required.has(token));
        if (distinctive.length < 3) {
          problems.push(
            `${where}: distractor "${distractor}" needs at least 3 distinctive words (got ${distinctive.length})`
          );
        }
      }
    }
  });
  if (!seen.has('fc-01')) problems.push('ids must run fc-01 … fc-20');
  const totals = {
    required: corpus.items.reduce((sum, item) => sum + (item.requiredWords?.length ?? 0), 0),
    negations: corpus.items.reduce((sum, item) => sum + (item.negations?.length ?? 0), 0),
    conditionals: corpus.items.reduce((sum, item) => sum + (item.conditionals?.length ?? 0), 0),
    targets: corpus.items.reduce((sum, item) => sum + (item.targets?.length ?? 0), 0),
    distractors: corpus.items.reduce((sum, item) => sum + (item.distractors?.length ?? 0), 0),
  };
  if (totals.required < 50) problems.push(`corpus declares ${totals.required} required words; at least 50 are needed`);
  if (totals.negations < 8) problems.push(`corpus declares ${totals.negations} negations; at least 8 are needed`);
  if (totals.conditionals < 8) {
    problems.push(`corpus declares ${totals.conditionals} conditionals; at least 8 are needed`);
  }
  if (totals.targets < 20) problems.push(`corpus declares ${totals.targets} targets; at least 20 are needed`);
  if (totals.distractors < 20) {
    problems.push(`corpus declares ${totals.distractors} distractors; at least 20 are needed`);
  }
  return { ok: problems.length === 0, problems };
}

/** The migrated fixture this harness scores against. */
export const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/fidelity-corpus.json', import.meta.url));

export function loadFidelityCorpus(filePath: string = DEFAULT_FIXTURE_PATH): FidelityCorpus {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const outcome = validateFidelityCorpus(parsed);
  if (!outcome.ok) {
    throw new Error(`invalid fidelity corpus ${filePath}:\n  - ${outcome.problems.join('\n  - ')}`);
  }
  return parsed as FidelityCorpus;
}