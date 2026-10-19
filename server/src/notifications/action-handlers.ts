/**
 * Notification action handlers (contract CHANNEL.md §7).
 *
 * A notification may carry up to three tappable actions backed by ONE handler
 * chosen from a registry registered in SERVER CONFIGURATION ONLY — a caller
 * names a handler, never a command. Each handler is an argv template executed
 * with `execFile` (no shell), with `{ref}` and `{action}` substituted as WHOLE
 * argv elements (never interpolated into a larger argument, so a caller can
 * never concatenate themselves into shell syntax or a new flag value).
 *
 * Built-in defaults drive the Agent OS channel/inbox verbs; an environment
 * variable holding JSON (`NOTIFICATION_ACTION_HANDLERS`) replaces the whole map
 * for tests and deployments. Handler stdout must be JSON `{"message": "…"}`;
 * a non-zero exit or bad output degrades to `Could not apply: <first stderr
 * line>`, which is what the Telegram message is edited to show.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';

export const NOTIFICATION_ACTION_HANDLERS_ENV = 'NOTIFICATION_ACTION_HANDLERS';

/** Handler budget (contract §7): a hung handler fails and reports, never hangs the listener. */
export const NOTIFICATION_ACTION_HANDLER_TIMEOUT_MS = 20_000;

/** Safety net so one chatty stderr line cannot flood a Telegram toast. */
const FAILURE_LINE_MAX_CHARS = 200;

export interface NotificationActionHandlerDefinition {
  /** Executable path. Resolved as-is by execFile; never a shell string. */
  command: string;
  /** Argv template; the whole-element placeholders `{ref}` and `{action}` are substituted at run time. */
  args: string[];
}

export const DEFAULT_NOTIFICATION_ACTION_HANDLERS: Record<string, NotificationActionHandlerDefinition> = {
  'agent-os-channel': {
    command: '/root/.npm-global/bin/agent-os',
    args: ['channel', 'decide', '--request', '{ref}', '--decision', '{action}', '--by', 'telegram', '--json'],
  },
  'agent-os-inbox': {
    command: '/root/.npm-global/bin/agent-os',
    args: ['inbox', 'release', '--id', '{ref}', '--decision', '{action}', '--by', 'telegram', '--json'],
  },
};

/**
 * Parse an env-provided JSON override: `{ "<name>": { "command": "…", "args": ["…"] } }`.
 * Throws a clear error naming the env variable on any malformed input, so a
 * misconfiguration is visible at startup instead of at first tap.
 */
export function parseHandlerDefinitionsJson(raw: string): Record<string, NotificationActionHandlerDefinition> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${NOTIFICATION_ACTION_HANDLERS_ENV} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${NOTIFICATION_ACTION_HANDLERS_ENV} must be a JSON object of { name: { command, args } }`);
  }
  const definitions: Record<string, NotificationActionHandlerDefinition> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${NOTIFICATION_ACTION_HANDLERS_ENV}[${name}] must be an object with a command string and an args array`);
    }
    const entry = value as { command?: unknown; args?: unknown };
    if (typeof entry.command !== 'string' || entry.command.length === 0) {
      throw new Error(`${NOTIFICATION_ACTION_HANDLERS_ENV}[${name}].command must be a non-empty string`);
    }
    if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string')) {
      throw new Error(`${NOTIFICATION_ACTION_HANDLERS_ENV}[${name}].args must be an array of strings`);
    }
    definitions[name] = { command: entry.command, args: entry.args };
  }
  return definitions;
}

/**
 * The server's registered handler map: the built-in defaults, with the whole
 * map replaced by `NOTIFICATION_ACTION_HANDLERS` when that env var is set.
 */
export function loadNotificationActionHandlers(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, NotificationActionHandlerDefinition> {
  const raw = env[NOTIFICATION_ACTION_HANDLERS_ENV];
  if (raw === undefined || raw === '') return { ...DEFAULT_NOTIFICATION_ACTION_HANDLERS };
  return parseHandlerDefinitionsJson(raw);
}

/**
 * Resolve a handler's argv template for one tap. `{ref}` and `{action}` are
 * substituted only as WHOLE argv elements — a partial occurrence (e.g.
 * `{ref}-suffix`) passes through verbatim, so substitution can never create a
 * new argument shape the server configuration did not author.
 */
export function resolveHandlerArgv(
  definition: NotificationActionHandlerDefinition,
  ref: string,
  action: string,
): string[] {
  return definition.args.map((element) => {
    if (element === '{ref}') return ref;
    if (element === '{action}') return action;
    return element;
  });
}

/** Immutable-by-construction view over the server's registered handler definitions. */
export class ActionHandlerRegistry {
  private readonly definitions: ReadonlyMap<string, NotificationActionHandlerDefinition>;

  constructor(definitions: Record<string, NotificationActionHandlerDefinition>) {
    this.definitions = new Map(Object.entries(definitions));
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  get(name: string): NotificationActionHandlerDefinition | undefined {
    return this.definitions.get(name);
  }

  names(): string[] {
    return [...this.definitions.keys()];
  }
}

export interface HandlerRunResult {
  /** True when the handler exited 0 with a parseable `{message}`. */
  ok: boolean;
  /** The line the Telegram message is edited to show. */
  message: string;
}

/** Structural seam over node's callback-style execFile so tests never exec anything. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

export interface HandlerRunnerOptions {
  /** Inject for tests; defaults to node's execFile (no shell). */
  execFile?: ExecFileFn;
  timeoutMs?: number;
}

function firstNonEmptyLine(text: string | Buffer): string | undefined {
  const line = text
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return undefined;
  return line.length > FAILURE_LINE_MAX_CHARS ? `${line.slice(0, FAILURE_LINE_MAX_CHARS)}…` : line;
}

/**
 * Run one handler for one tap: execFile (no shell) with the substituted argv
 * and a hard timeout; parse stdout as JSON `{message}`. Any failure — non-zero
 * exit, spawn error, timeout, bad output — becomes `Could not apply: <first
 * stderr line>` (a stable fallback when stderr is empty). Never throws.
 */
export async function runNotificationActionHandler(
  definition: NotificationActionHandlerDefinition,
  ref: string,
  action: string,
  opts: HandlerRunnerOptions = {},
): Promise<HandlerRunResult> {
  const execFile = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const timeoutMs = opts.timeoutMs ?? NOTIFICATION_ACTION_HANDLER_TIMEOUT_MS;
  const argv = resolveHandlerArgv(definition, ref, action);

  const outcome = await new Promise<{ error: ExecFileException | null; stdout: string | Buffer; stderr: string | Buffer }>(
    (resolve) => {
      execFile(definition.command, argv, { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    },
  );

  if (outcome.error === null) {
    try {
      const parsed: unknown = JSON.parse(outcome.stdout.toString('utf8'));
      const message = (parsed as { message?: unknown })?.message;
      if (typeof message === 'string' && message.length > 0) {
        return { ok: true, message };
      }
    } catch {
      /* fall through to the failure message */
    }
  }

  const line = firstNonEmptyLine(outcome.stderr) ?? 'handler failed';
  return { ok: false, message: `Could not apply: ${line}` };
}
