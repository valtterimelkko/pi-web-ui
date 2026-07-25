/**
 * Goal-engine model: read-only projection of the companion Pi extension's UI events.
 *
 * The extension (see docs/GOAL-EXTENSION-UI.md) owns goal semantics and ships
 * its state to the browser as two runtime-neutral extension UI events: a
 * one-line `extension_status` and a `widget_content` line array. This module
 * turns those lines into a structured model so the client can render a
 * collapsible panel, a live phase chip, and post-completion history instead of
 * a flat text blob — without reimplementing any goal semantics or mutating
 * extension state.
 *
 * Parsing is defensive by design: every field is optional, unknown lines are
 * preserved in `raw`, and a payload that does not look like a goal widget
 * returns null so the generic extension-widget rendering still applies.
 */

/** Widget key the goal extension registers (`ctx.ui.setWidget`). */
export const GOAL_WIDGET_KEY = 'goal-engine-status';

/** Status key the goal extension registers (`ctx.ui.setStatus`). */
export const GOAL_STATUS_KEY = 'goal-engine';

export type GoalStatus = 'running' | 'paused' | 'wrapping-up' | 'awaiting-input' | 'idle';

export interface GoalPlanItem {
  text: string;
  done: boolean;
}

export interface GoalModel {
  status: GoalStatus;
  objective: string;
  startedAt: string | null;
  completedAt: string | null;
  runs: number;
  maxRuns: number | null;
  question: string | null;
  lastRun: string | null;
  continuationIntervalMs: number | null;
  suspicionRung: string | null;
  consecutiveSuspectRuns: number | null;
  tokensSpent: number | null;
  /** null = no budget (the extension prints "disabled"). */
  tokenBudget: number | null;
  usdSpent: number | null;
  usdBudget: number | null;
  progress: { label: string; current: number; total: number } | null;
  verification: { command: string | null; status: string | null; result: string | null };
  reviewCycles: { completed: number; required: number } | null;
  compactions: number | null;
  errors: { consecutive: number; lastMessage: string | null } | null;
  plan: GoalPlanItem[];
  /** Lines that no rule claimed, kept so nothing the extension emits is lost. */
  raw: string[];
}

export type GoalPhaseKind =
  | 'working'
  | 'continuing'
  | 'wrapping-up'
  | 'paused'
  | 'awaiting-input'
  | 'done';

export interface GoalPhase {
  kind: GoalPhaseKind;
  /** Short human label for the chip ("running…", "continuing in 20s"). */
  label: string;
  /** Agent run currently in flight (1-based), or the last completed run. */
  displayRun: number;
  /** Whether the live pulse should animate. */
  pulsing: boolean;
  /** Whether this phase is a stopped one (drives amber vs emerald styling). */
  paused: boolean;
  /** Seconds until the extension auto-continues, when known. */
  secondsUntilContinue: number | null;
}

const HIDE_HINT = /goal status again to hide/i;
const HEADER = /^🎯\s*Goal (Status|Report)/i;

function num(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStatus(text: string): GoalStatus {
  const value = text.toLowerCase();
  if (value.includes('awaiting user input')) return 'awaiting-input';
  if (value.includes('wrapping up')) return 'wrapping-up';
  if (value.includes('paus')) return 'paused';
  if (value.includes('running')) return 'running';
  return 'idle';
}

/** "30s" / "2m" → milliseconds. */
export function parseIntervalMs(text: string): number | null {
  const match = text.match(/([\d.]+)\s*(ms|s|m)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'ms') return value;
  return unit === 'm' ? value * 60_000 : value * 1000;
}

/**
 * Parse a goal-engine widget payload. Returns null when the lines are not a
 * goal widget, so callers can fall back to generic widget rendering.
 */
export function parseGoalWidget(lines: string[]): GoalModel | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (!HEADER.test(String(lines[0] ?? ''))) return null;

  const model: GoalModel = {
    status: 'idle',
    objective: '',
    startedAt: null,
    completedAt: null,
    runs: 0,
    maxRuns: null,
    question: null,
    lastRun: null,
    continuationIntervalMs: null,
    suspicionRung: null,
    consecutiveSuspectRuns: null,
    tokensSpent: null,
    tokenBudget: null,
    usdSpent: null,
    usdBudget: null,
    progress: null,
    verification: { command: null, status: null, result: null },
    reviewCycles: null,
    compactions: null,
    errors: null,
    plan: [],
    raw: [],
  };

  let inPlan = false;

  for (const rawLine of lines.slice(1)) {
    const line = String(rawLine ?? '');
    const trimmed = line.trim();
    if (!trimmed || HIDE_HINT.test(trimmed)) continue;

    if (/^Plan:$/i.test(trimmed)) {
      inPlan = true;
      continue;
    }
    if (inPlan) {
      const planMatch = trimmed.match(/^([✓☐])\s*(.*)$/);
      if (planMatch) {
        model.plan.push({ text: planMatch[2].trim(), done: planMatch[1] === '✓' });
        continue;
      }
      inPlan = false;
    }

    const kv = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!kv) {
      model.raw.push(trimmed);
      continue;
    }
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim();

    switch (key) {
      case 'status':
        model.status = parseStatus(value);
        break;
      case 'objective':
        model.objective = value;
        break;
      case 'started':
        model.startedAt = value;
        break;
      case 'completed':
        model.completedAt = value;
        break;
      case 'agent runs':
        model.runs = num(value) ?? 0;
        break;
      case 'max runs':
        model.maxRuns = num(value);
        break;
      case 'question':
        model.question = value;
        break;
      case 'last run':
        model.lastRun = value;
        break;
      case 'continuation interval': {
        model.continuationIntervalMs = parseIntervalMs(value);
        const rung = value.match(/rung\s*([\d]+\/[\d]+)/i);
        model.suspicionRung = rung ? rung[1] : null;
        break;
      }
      case 'consecutive suspect runs':
        model.consecutiveSuspectRuns = num(value);
        break;
      case 'token spend': {
        const spend = value.match(/^([\d,]+)\s*\/\s*(disabled|[\d,]+)/i);
        if (spend) {
          model.tokensSpent = num(spend[1]);
          model.tokenBudget = /disabled/i.test(spend[2]) ? null : num(spend[2]);
        }
        break;
      }
      case 'usd spend': {
        const spend = value.match(/^\$([\d.]+)\s*\/\s*(disabled|\$[\d.]+)/i);
        if (spend) {
          model.usdSpent = num(spend[1]);
          model.usdBudget = /disabled/i.test(spend[2]) ? null : num(spend[2].replace('$', ''));
        }
        break;
      }
      case 'verification command':
        model.verification.command = value;
        break;
      case 'verification status':
        model.verification.status = value;
        break;
      case 'verification result':
        model.verification.result = value;
        break;
      case 'critical-review cycles': {
        const cycles = value.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (cycles) model.reviewCycles = { completed: Number(cycles[1]), required: Number(cycles[2]) };
        break;
      }
      case 'compactions':
        model.compactions = num(value);
        break;
      case 'consecutive errors':
        model.errors = { consecutive: num(value) ?? 0, lastMessage: model.errors?.lastMessage ?? null };
        break;
      case 'last error':
        model.errors = { consecutive: model.errors?.consecutive ?? 0, lastMessage: value };
        break;
      default: {
        // Any remaining "<label>: n/m" line is the extension's free-form
        // progress counter (`Species completed: 160/200`).
        const progress = value.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (progress && !model.progress) {
          model.progress = {
            label: kv[1].trim(),
            current: Number(progress[1]),
            total: Number(progress[2]),
          };
        } else {
          model.raw.push(trimmed);
        }
      }
    }
  }

  return model;
}

export interface GoalPhaseInput {
  model: GoalModel;
  isStreaming: boolean;
  /** When the current widget payload arrived (ms epoch) — the last run boundary. */
  updatedAt: number;
  now: number;
}

/**
 * Derive what the goal is doing *right now*.
 *
 * The extension only refreshes its widget at run boundaries, so between runs
 * the UI would otherwise look idle ("Awaiting input") while the goal is in fact
 * about to continue on its own timer. Combining the last payload with the live
 * streaming flag and the extension-reported continuation interval gives an
 * honest phase without asking the extension for anything new.
 */
export function deriveGoalPhase({ model, isStreaming, updatedAt, now }: GoalPhaseInput): GoalPhase {
  const displayRun = model.status === 'running' || model.status === 'wrapping-up'
    ? model.runs + 1
    : model.runs;

  if (model.status === 'idle') {
    return { kind: 'done', label: 'completed', displayRun: model.runs, pulsing: false, paused: false, secondsUntilContinue: null };
  }
  if (model.status === 'awaiting-input') {
    return { kind: 'awaiting-input', label: 'needs you', displayRun, pulsing: false, paused: true, secondsUntilContinue: null };
  }
  if (model.status === 'wrapping-up') {
    return { kind: 'wrapping-up', label: 'wrapping up…', displayRun, pulsing: isStreaming, paused: true, secondsUntilContinue: null };
  }
  if (model.status === 'paused') {
    return { kind: 'paused', label: 'paused', displayRun, pulsing: false, paused: true, secondsUntilContinue: null };
  }

  if (isStreaming) {
    return { kind: 'working', label: 'running…', displayRun, pulsing: true, paused: false, secondsUntilContinue: null };
  }

  // Running but not streaming: the extension is waiting out its continuation
  // interval before the next agent run.
  if (model.continuationIntervalMs === null) {
    return { kind: 'continuing', label: 'continuing…', displayRun, pulsing: false, paused: false, secondsUntilContinue: null };
  }
  const remainingMs = Math.max(0, updatedAt + model.continuationIntervalMs - now);
  const seconds = Math.ceil(remainingMs / 1000);
  return {
    kind: 'continuing',
    label: seconds > 0 ? `continuing in ${seconds}s` : 'continuing…',
    displayRun,
    pulsing: false,
    paused: false,
    secondsUntilContinue: seconds,
  };
}

/** Compact token spend, e.g. "38.3k / 5M tokens". */
export function formatSpend(spent: number | null, budget: number | null): string | null {
  if (spent === null) return null;
  const short = (value: number): string => {
    if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
    if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
    return String(value);
  };
  return budget === null ? `${short(spent)} tokens` : `${short(spent)} / ${short(budget)} tokens`;
}

/**
 * One-line summary for the collapsed panel header.
 *
 * `includeRun` is off when the caller already renders the run counter, so the
 * chip does not read "Run 1/4 · Run 1/4".
 */
export function summarizeGoal(model: GoalModel, phase: GoalPhase, options: { includeRun?: boolean } = {}): string {
  const parts: string[] = [];
  if (options.includeRun !== false) {
    if (phase.kind === 'done') {
      parts.push(`${model.runs} runs`);
    } else {
      parts.push(model.maxRuns ? `Run ${phase.displayRun}/${model.maxRuns}` : `Run ${phase.displayRun}`);
    }
  }
  if (model.progress) parts.push(`${model.progress.label} ${model.progress.current}/${model.progress.total}`);
  if (model.usdSpent) parts.push(`$${model.usdSpent.toFixed(2)}`);
  else {
    const tokens = formatSpend(model.tokensSpent, model.tokenBudget);
    if (tokens) parts.push(tokens);
  }
  if (model.plan.length > 0) {
    parts.push(`${model.plan.filter((item) => item.done).length}/${model.plan.length} plan`);
  }
  return parts.join(' · ');
}

/**
 * Prompts the goal extension sends on the user's behalf to drive the next run.
 * They arrive as ordinary user messages, so the transcript needs them labelled
 * to stay readable. Matching is anchored on the extension's exact wording.
 */
const CONTINUATION_PROMPTS = [
  /^continue working toward the goal\./i,
  /^resume working toward the goal\./i,
  /^resume the persisted goal\./i,
];

export function isGoalContinuationPrompt(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return CONTINUATION_PROMPTS.some((pattern) => pattern.test(trimmed));
}
