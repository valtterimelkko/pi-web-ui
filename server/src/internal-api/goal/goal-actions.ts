/**
 * Cross-runtime goal function (contract 1.27.0) — Pi slash-command composition.
 *
 * POST /sessions/:id/goal composes a real `/goal …` extension command and
 * dispatches it through the standard prompt pipeline. The composition rules
 * mirror the extension's parser (`pi-enhancement/goal-engine/commands.ts`
 * parseGoalStartOptions): the objective is the quoted remainder after flag
 * extraction; flags accept double-quoted, single-quoted or bare values.
 */
import { ErrorCode } from '../error-codes.js';

export type GoalAction = 'start' | 'pause' | 'resume' | 'clear';

export const GOAL_ACTIONS: readonly GoalAction[] = ['start', 'pause', 'resume', 'clear'];

export interface GoalStartOptions {
  objective?: string;
  maxTurns?: number;
  verifyCommand?: string;
  minReviews?: number;
  budgetTokens?: number;
  budgetUsd?: number;
}

export interface SessionGoalControlRequest extends Partial<GoalStartOptions> {
  action?: string;
}

/** Upper bound for objective text (single-line commands only). */
const MAX_OBJECTIVE_CHARS = 4000;

function validationError(message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message } };
}

/** Quote an objective for the extension parser: wrap in double quotes. Newlines would break the single-command contract. */
function quoteObjective(objective: string): string {
  return `"${objective}"`;
}

/** Quote a verify command choosing a quote style the parser accepts; null when impossible. */
function quoteVerifyCommand(command: string): string | null {
  const hasDouble = command.includes('"');
  const hasSingle = command.includes("'");
  if (!hasDouble) return `"${command}"`;
  if (!hasSingle) return `'${command}'`;
  // Both quote kinds present cannot be expressed through the extension's parser.
  return null;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * 100) / 100;
}

/**
 * Validate a goal-control request body and compose the exact Pi slash command
 * to dispatch. Returns `{ok:false}` with a contracted error payload otherwise.
 */
export function composePiGoalCommand(
  body: SessionGoalControlRequest,
): { ok: true; action: GoalAction; command: string } | { ok: false; error: { code: string; message: string } } {
  const action = body.action;
  if (action !== 'start' && action !== 'pause' && action !== 'resume' && action !== 'clear') {
    return validationError('action must be one of start|pause|resume|clear');
  }

  if (action === 'pause') return { ok: true, action, command: '/goal pause-now' };
  if (action === 'resume') return { ok: true, action, command: '/goal resume' };
  if (action === 'clear') return { ok: true, action, command: '/goal clear' };

  // start
  const objective = body.objective;
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    return validationError("action 'start' requires a non-empty objective");
  }
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return validationError(`objective must be at most ${MAX_OBJECTIVE_CHARS} characters`);
  }
  if (/[\n\r]/.test(objective)) {
    return validationError('objective must be a single line (no newlines)');
  }

  let command = `/goal ${quoteObjective(objective.trim())}`;

  if (body.maxTurns !== undefined) {
    const maxTurns = asPositiveInt(body.maxTurns);
    if (maxTurns === undefined) return validationError('maxTurns must be a positive integer');
    command += ` --max-turns ${maxTurns}`;
  }
  if (body.minReviews !== undefined) {
    const minReviews = asNonNegativeInt(body.minReviews);
    if (minReviews === undefined) return validationError('minReviews must be a non-negative integer');
    command += ` --min-reviews ${minReviews}`;
  }
  if (body.budgetTokens !== undefined) {
    const budgetTokens = asPositiveInt(body.budgetTokens);
    if (budgetTokens === undefined) return validationError('budgetTokens must be a positive integer');
    command += ` --budget-tokens ${budgetTokens}`;
  }
  if (body.budgetUsd !== undefined) {
    const budgetUsd = asPositiveNumber(body.budgetUsd);
    if (budgetUsd === undefined) return validationError('budgetUsd must be a positive number');
    command += ` --budget-usd ${budgetUsd}`;
  }
  if (body.verifyCommand !== undefined) {
    if (typeof body.verifyCommand !== 'string' || body.verifyCommand.trim().length === 0) {
      return validationError('verifyCommand must be a non-empty string');
    }
    if (/[\n\r]/.test(body.verifyCommand)) {
      return validationError('verifyCommand must be a single line (no newlines)');
    }
    const quoted = quoteVerifyCommand(body.verifyCommand.trim());
    if (quoted === null) {
      return validationError('verifyCommand containing both single and double quotes cannot be passed through the /goal parser; restructure the command');
    }
    command += ` --verify ${quoted}`;
  }

  return { ok: true, action, command };
}
