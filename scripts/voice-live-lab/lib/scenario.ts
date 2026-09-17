/**
 * Scenario schema `voice-lab.scenario/1` — loader and validator (L2, §14.2).
 *
 * A scenario is the synthetic operator's script: frozen utterances (the
 * comparison backbone), branching tables, and adaptive beats, each with a
 * trigger relative to observed output and a mechanical `expect` block the
 * scorer can assert from the trace alone.
 *
 * The validator is deliberately strict about the vocabulary the L2 runner and
 * scorer actually implement: unknown trigger sources, unknown permission
 * verbs or unknown expect fields are authoring errors, not silently ignored
 * extras. Scenario files live in
 * `/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/<tier>/`.
 */

import { readFileSync } from 'node:fs';

export const SCENARIO_SCHEMA = 'voice-lab.scenario/1';

export type EndpointLane = 'E' | 'N';

export interface ScenarioVoice {
  engine: string;
  voice: string;
  rate?: number;
}

export interface ScenarioBudgets {
  maxRunMs: number;
  maxOperatorTurns: number;
  maxCandidateSpeechMs: number;
  maxSpendUsd: number;
}

export interface BeatTrigger {
  /** Run start, or an observed-output anchor. */
  at?: 'run-start';
  after?: 'candidate-silence' | 'candidate-speech-start' | 'world-event';
  /** Fixed delay after the anchor (ms). */
  delayMs?: number;
  /** Silence that must precede an `after: candidate-silence` trigger. */
  silenceMs?: number;
  /** World event id for `after: world-event`. */
  event?: string;
}

/** Director verbs the runner enforces per beat (§14.2: permissions allow-list). */
export const PERMISSION_VERBS = [
  'confirm:current-draft',
  'confirm:draft-proposed-in-this-beat',
  'answer:permission-request',
  'card:confirm',
  'card:cancel',
  'card:original',
  'stop-talker',
  'level:verbatim',
  'level:summary',
  'level:headlines',
] as const;

export interface BeatBranch {
  /** Regex over shadow-ASR `heard` text; omit for the default branch. */
  when?: string;
  default?: boolean;
  utterance: string;
}

export interface BeatExpect {
  /** A confirmed release with a delivery happened in this beat's window. */
  relay?: boolean;
  /** Nothing but conversation: no delivery and no draft growth. */
  conversationalOnly?: boolean;
  /** The operator's words were held as a draft (draft grew this beat). */
  draftCreated?: boolean;
  /** Every word must appear (case-insensitive) in the draft or release text. */
  requiredWords?: string[];
  /** Every word must appear in the released delivery text. */
  releasedContains?: string[];
  /** Regexes that must not match the candidate's spoken reply. */
  forbiddenClaims?: string[];
  /** The release ack was one of the fixed trusted strings. */
  ackIsTrusted?: boolean;
  /** The reply answered from exposed context (label for proxy metrics). */
  answeredFromHistory?: boolean;
  /** A worker permission request was answered this beat. */
  permissionAnswered?: boolean;
  /** The answer was spoken at the receipt tier, not paraphrased later. */
  spokenAtReceiptTier?: boolean;
  /** No release outside this beat's permissions. */
  noUnauthorisedRelease?: boolean;
  /** The reply acknowledged a cancellation/correction (barge-in recovery). */
  cancelled?: boolean;
  honestDeliveryStatement?: boolean;
}

export interface ScenarioBeat {
  id: string;
  mode: 'frozen' | 'branching' | 'adaptive';
  /** Frozen beat: the golden utterance (spoken as audio, never sent as text). */
  utterance?: string;
  /** Branching beat: observed-pattern table with a default. */
  branches?: BeatBranch[];
  /** Adaptive beat: the goal the simulator pursues (L6). */
  goal?: string;
  maxTurns?: number;
  trigger: BeatTrigger;
  interrupt?: boolean;
  /** Beat-level gesture delivered with the utterance (§14.6). */
  gesture?:
    | 'card-confirm'
    | 'card-cancel'
    | 'card-original'
    | 'stop-talker'
    | 'level:verbatim'
    | 'level:summary'
    | 'level:headlines';
  /** Director allow-list for this beat. */
  permissions: string[];
  expect: BeatExpect;
  /** Benchmark 3 labels carried through for the interpretive layers. */
  labels?: Record<string, unknown>;
  notes?: string;
}

export interface VoiceScenario {
  schema: string;
  id: string;
  tier: 1 | 2 | 3;
  world?: string;
  persona?: string;
  language: string;
  voice: ScenarioVoice;
  endpointing: EndpointLane;
  budgets: ScenarioBudgets;
  beats: ScenarioBeat[];
  description?: string;
}

export interface ValidationProblems {
  ok: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TRIGGER_SOURCES = ['candidate-silence', 'candidate-speech-start', 'world-event'] as const;

/**
 * Validate one parsed scenario document. Structural mistakes (wrong schema
 * string, duplicate beat ids, an expect block promising a relay without a
 * confirming permission) are returned as named problems, never thrown.
 */
export function validateScenario(value: unknown): ValidationProblems {
  const problems: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['scenario is not an object'] };
  const scenario = value as unknown as VoiceScenario;

  if (scenario.schema !== SCENARIO_SCHEMA) {
    problems.push(`schema must be ${SCENARIO_SCHEMA}, got ${String(scenario.schema)}`);
  }
  if (typeof scenario.id !== 'string' || !/^t[123]-[a-z0-9-]+$/.test(scenario.id)) {
    problems.push(`id must match t<tier>-<slug>, got ${String(scenario.id)}`);
  }
  if (![1, 2, 3].includes(scenario.tier)) problems.push('tier must be 1, 2 or 3');
  if (scenario.language !== 'en-GB') problems.push('language must be en-GB (lab condition)');
  if (!isRecord(scenario.voice) || typeof scenario.voice.engine !== 'string' || typeof scenario.voice.voice !== 'string') {
    problems.push('voice must be { engine, voice }');
  }
  if (scenario.endpointing !== 'E' && scenario.endpointing !== 'N') {
    problems.push('endpointing must be "E" or "N"');
  }
  const budgets = scenario.budgets as unknown as ScenarioBudgets;
  if (!isRecord(scenario.budgets) || typeof budgets.maxRunMs !== 'number' || typeof budgets.maxOperatorTurns !== 'number' ||
      typeof budgets.maxCandidateSpeechMs !== 'number' || typeof budgets.maxSpendUsd !== 'number') {
    problems.push('budgets must carry maxRunMs, maxOperatorTurns, maxCandidateSpeechMs and maxSpendUsd');
  }
  if (!Array.isArray(scenario.beats) || scenario.beats.length === 0) {
    problems.push('beats must be a non-empty array');
    return { ok: false, problems };
  }

  const seenIds = new Set<string>();
  scenario.beats.forEach((beat, index) => {
    const where = `beat[${index}]`;
    if (!isRecord(beat as unknown as Record<string, unknown>) || typeof beat.id !== 'string') {
      problems.push(`${where}: missing id`);
      return;
    }
    if (seenIds.has(beat.id)) problems.push(`duplicate beat id: ${beat.id}`);
    seenIds.add(beat.id);

    if (beat.mode === 'frozen') {
      if (typeof beat.utterance !== 'string' || beat.utterance.trim() === '') {
        problems.push(`${where} (${beat.id}): frozen beats need a non-empty utterance`);
      }
    } else if (beat.mode === 'branching') {
      if (!Array.isArray(beat.branches) || beat.branches.length === 0) {
        problems.push(`${where} (${beat.id}): branching beats need branches`);
      } else if (!beat.branches.some((b) => b.default)) {
        problems.push(`${where} (${beat.id}): branching beats need a default branch`);
      }
    } else if (beat.mode === 'adaptive') {
      if (typeof beat.goal !== 'string' || beat.goal.trim() === '') {
        problems.push(`${where} (${beat.id}): adaptive beats need a goal`);
      }
    } else {
      problems.push(`${where} (${beat.id}): mode must be frozen, branching or adaptive`);
    }

    const trigger = beat.trigger as unknown as BeatTrigger;
    if (!isRecord(beat.trigger as unknown as Record<string, unknown>)) {
      problems.push(`${where} (${beat.id}): missing trigger`);
    } else if (trigger.at !== 'run-start' && !TRIGGER_SOURCES.includes(trigger.after as (typeof TRIGGER_SOURCES)[number])) {
      problems.push(`${where} (${beat.id}): trigger needs at: "run-start" or a known after: source`);
    } else if (trigger.after === 'world-event' && typeof trigger.event !== 'string') {
      problems.push(`${where} (${beat.id}): world-event triggers need an event id`);
    }

    if (!Array.isArray(beat.permissions)) {
      problems.push(`${where} (${beat.id}): permissions must be an array (empty allowed)`);
    } else {
      for (const permission of beat.permissions) {
        const allowed = (PERMISSION_VERBS as readonly string[]).some(
          (verb) => permission === verb || permission.startsWith(`${verb}-`)
        );
        if (!allowed) problems.push(`${where} (${beat.id}): unknown permission "${String(permission)}"`);
      }
    }

    if (!isRecord(beat.expect as unknown as Record<string, unknown>)) {
      problems.push(`${where} (${beat.id}): missing expect block`);
      return;
    }
    const expect = beat.expect as BeatExpect;
    if (expect.relay === true) {
      // A relay is an authorisation: the beat must permit a confirmation,
      // otherwise the director would have to break policy to satisfy it.
      const confirms = (beat.permissions ?? []).some((p) => p.startsWith('confirm:'));
      if (!confirms) problems.push(`${where} (${beat.id}): expect.relay=true needs a confirm: permission`);
      if (expect.releasedContains !== undefined && !Array.isArray(expect.releasedContains)) {
        problems.push(`${where} (${beat.id}): releasedContains must be a string array`);
      }
    }
    if (expect.forbiddenClaims !== undefined && !Array.isArray(expect.forbiddenClaims)) {
      problems.push(`${where} (${beat.id}): forbiddenClaims must be a regex-string array`);
    }
  });

  return { ok: problems.length === 0, problems };
}

export function loadScenarioFile(filePath: string): VoiceScenario {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const outcome = validateScenario(parsed);
  if (!outcome.ok) {
    throw new Error(`invalid scenario ${filePath}:\n  - ${outcome.problems.join('\n  - ')}`);
  }
  return parsed as VoiceScenario;
}

/**
 * Words a frozen/branching utterance's beat requires, resolved from the beat
 * (expect.requiredWords) — the scorer's fidelity floor for this beat.
 */
export function requiredWordsFor(beat: ScenarioBeat): string[] {
  return beat.expect.requiredWords ?? [];
}
