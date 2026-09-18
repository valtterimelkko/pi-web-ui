/**
 * Tier 3 tool surface (L5, plan §17.2).
 *
 * Tier 3 has no talker, no draft store and no relay gate: the live model
 * composes child briefs itself. The gate is therefore the **tool allow-list**
 * plus a **confirmation protocol** for the two consequential actions — creating
 * a child and restarting the service — enforced by the HOST, never by the
 * model's claim. Everything in this module is either pure (argument
 * validation, the `run_checked` grammar, poll accounting) or backed by an
 * injectable seam (`Tier3ApiClient`, `CheckedCommandRunner`, `WatchWaiter`), so
 * the whole surface is testable and runnable without a socket, a model or a
 * child session.
 *
 * Tool contract (§17.2), all `NON_BLOCKING`; responses are scheduled
 * `WHEN_IDLE` (the SDK default, stated explicitly so it cannot drift):
 *
 *   create_child(name, cwd, brief)   POST /sessions with the child invariant
 *                                    FORCED, then the brief; owner confirmation
 *                                    on first use per run; brief bytes recorded
 *   prompt_child(sessionId, message, deliverAs)
 *   child_status(sessionId)          counted as a poll if twice within 30 s
 *                                    without an intervening wait_for
 *   read_child(sessionId, tail)      counted as a poll under the same rule
 *   wait_for(sessionId, condition, text?, timeoutS)
 *                                    registers a watch and RETURNS WHEN IT
 *                                    FIRES — the async result is the wake
 *   run_checked(command)             allow-list only; ctl.sh restart needs
 *                                    owner confirmation
 *   notify_owner(text)               milestone log
 *
 * `confirmRequest` is host → model: the host injects "the owner must confirm;
 * ask them" as a context update and holds the tool result until a committed
 * operator confirmation arrives (or 60 s lapses → `refused: no-confirmation`).
 */

import { Behavior, Type } from '@google/genai';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { EVENT, type EventLog, type MonotonicClock } from './scheduler.js';

// ── Tool names and declarations ──────────────────────────────────────────────

export const TIER3_TOOL_NAMES = [
  'create_child',
  'prompt_child',
  'child_status',
  'read_child',
  'wait_for',
  'run_checked',
  'notify_owner',
] as const;

export type Tier3ToolName = (typeof TIER3_TOOL_NAMES)[number];

/** All tier-3 responses are scheduled WHEN_IDLE (spec §17.2). */
export const TIER3_RESPONSE_SCHEDULING = 'WHEN_IDLE';

/** The confirmation window: a committed `confirm` within 60 s, or a refusal. */
export const CONFIRMATION_WINDOW_MS = 60_000;

/** Poll rule window (§17.2): two status reads inside this window without an
 *  intervening `wait_for` count as one poll. */
export const POLL_WINDOW_MS = 30_000;

export const WAIT_FOR_MAX_TIMEOUT_S = 600;
export const CREATE_CHILD_MAX_BRIEF_CHARS = 4000;
export const READ_CHILD_MAX_TAIL_LINES = 40;
export const NOTIFY_MAX_CHARS = 300;

export interface Tier3FunctionDeclaration {
  name: Tier3ToolName;
  description: string;
  parameters: Record<string, unknown>;
  behavior: string;
}

const str = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: Type.STRING,
  description,
  ...extra,
});
const integer = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: Type.INTEGER,
  description,
  ...extra,
});

/**
 * The seven declared functions. Descriptions are part of the frozen condition:
 * they are hashed into the attempt manifest, so a reworded description is a
 * different condition rather than a silent edit.
 */
export const TIER3_FUNCTION_DECLARATIONS: Tier3FunctionDeclaration[] = [
  {
    name: 'create_child',
    description:
      'Create one child worker session and give it its brief. The child invariant (runtime, provider, model, thinking level) is FORCED by the host; you choose the name, the working directory (inside the run directory) and the brief. The brief is spoken to the child verbatim and its bytes are recorded, so write it as the instruction you want carried out. The owner must confirm the first child you create.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: str('A short human label for the child, e.g. "transfer worker".'),
        cwd: str('Absolute working directory for the child; must be inside the run directory.'),
        brief: str('The full instruction for the child (at most 4000 characters).', {
          maxLength: CREATE_CHILD_MAX_BRIEF_CHARS,
        }),
      },
      required: ['name', 'cwd', 'brief'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'prompt_child',
    description:
      'Send a message to an existing child session. Use deliverAs "prompt" to start a new turn (refused if the child is busy), "follow_up" to deliver after the current turn, or "steer" to interrupt the current turn.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sessionId: str('The child session id returned by create_child.'),
        message: str('The message to deliver.'),
        deliverAs: str('One of: prompt, follow_up, steer.', { enum: ['prompt', 'follow_up', 'steer'] }),
      },
      required: ['sessionId', 'message'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'child_status',
    description:
      'Read one child session: whether it is busy, its status, and its last assistant text. Calling this twice within 30 seconds without an intervening wait_for is counted as polling.',
    parameters: {
      type: Type.OBJECT,
      properties: { sessionId: str('The child session id.') },
      required: ['sessionId'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'read_child',
    description:
      'Read the tail of a child run\'s visible transcript. Calling this twice within 30 seconds without an intervening wait_for is counted as polling.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sessionId: str('The child session id.'),
        tail: integer('How many trailing lines to read (at most 40).', {
          minimum: 1,
          maximum: READ_CHILD_MAX_TAIL_LINES,
        }),
      },
      required: ['sessionId'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'wait_for',
    description:
      'Register a host-side watch on a child and return only when it fires or the timeout expires. This is how you wait without polling: your result arrives as an asynchronous tool response. condition "idle" fires when the child finishes its turn; condition "text-contains" fires when the child emits the given text.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sessionId: str('The child session id to watch.'),
        condition: str('One of: idle, text-contains.', { enum: ['idle', 'text-contains'] }),
        text: str('Required when condition is text-contains.'),
        timeoutS: integer('Give up after this many seconds (at most 600).', {
          minimum: 1,
          maximum: WAIT_FOR_MAX_TIMEOUT_S,
        }),
      },
      required: ['sessionId', 'condition'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'run_checked',
    description:
      'Run one inspection command from a fixed allow-list: "git -C <dir> log|status|diff" inside the run directory, "python3 -m unittest ..." with the run directory as the working directory, "bash <path>/ctl.sh restart|health|status" for the mock service, and "cat"/"ls" of paths inside the run directory. Anything else is refused with a reason. "ctl.sh restart" needs the owner\'s confirmation.',
    parameters: {
      type: Type.OBJECT,
      properties: { command: str('The exact command line to run.') },
      required: ['command'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'notify_owner',
    description:
      'Record one milestone for the owner and say it out loud. Use it for operational milestones only — a child dispatched, a phase verified, a service restarted — not for narration.',
    parameters: {
      type: Type.OBJECT,
      properties: { text: str('The milestone, at most 300 characters.', { maxLength: NOTIFY_MAX_CHARS }) },
      required: ['text'],
    },
    behavior: Behavior.NON_BLOCKING,
  },
];

/** Stable hash of the frozen tool condition (declarations + descriptions). */
export function tier3ToolConditionHash(): string {
  return createHash('sha256').update(JSON.stringify(TIER3_FUNCTION_DECLARATIONS)).digest('hex');
}

// ── Argument schemas (Zod) ───────────────────────────────────────────────────

export const createChildArgs = z.object({
  name: z.string().min(1).max(64),
  cwd: z.string().min(1),
  brief: z.string().min(1).max(CREATE_CHILD_MAX_BRIEF_CHARS),
});

export const promptChildArgs = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  deliverAs: z.enum(['prompt', 'follow_up', 'steer']).optional(),
});

export const childStatusArgs = z.object({ sessionId: z.string().min(1) });

export const readChildArgs = z.object({
  sessionId: z.string().min(1),
  tail: z.number().int().min(1).max(READ_CHILD_MAX_TAIL_LINES).optional(),
});

export const waitForArgs = z.object({
  sessionId: z.string().min(1),
  condition: z.enum(['idle', 'text-contains']),
  text: z.string().min(1).optional(),
  timeoutS: z.number().int().min(1).max(WAIT_FOR_MAX_TIMEOUT_S).optional(),
});

export const runCheckedArgs = z.object({ command: z.string().min(1) });

export const notifyOwnerArgs = z.object({ text: z.string().min(1).max(NOTIFY_MAX_CHARS) });

const SCHEMAS: Record<Tier3ToolName, z.ZodTypeAny> = {
  create_child: createChildArgs,
  prompt_child: promptChildArgs,
  child_status: childStatusArgs,
  read_child: readChildArgs,
  wait_for: waitForArgs,
  run_checked: runCheckedArgs,
  notify_owner: notifyOwnerArgs,
};

/** Validate arguments for one tool. Returns a human-readable refusal reason. */
export function validateToolArgs(
  name: string,
  args: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (!(TIER3_TOOL_NAMES as readonly string[]).includes(name)) {
    return {
      ok: false,
      reason: `unknown tool "${name}"; the available tools are ${TIER3_TOOL_NAMES.join(', ')}`,
    };
  }
  const schema = SCHEMAS[name as Tier3ToolName];
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `invalid arguments for ${name}: ${detail}` };
  }
  const value = parsed.data as Record<string, unknown>;
  if (name === 'wait_for' && value.condition === 'text-contains' && !value.text) {
    return { ok: false, reason: 'invalid arguments for wait_for: text is required when condition is text-contains' };
  }
  return { ok: true, value };
}

// ── run_checked: the allow-list grammar (pure) ───────────────────────────────

export type CheckedCommandKind = 'git' | 'unittest' | 'ctl' | 'read';

export interface ParsedCheckedCommand {
  kind: CheckedCommandKind;
  argv: string[];
  /** Absolute working directory for the spawn. */
  cwd: string;
  /** Absolute path for `read` commands (cat/ls). */
  target?: string;
  requiresConfirmation: boolean;
  /** The exact command line as accepted (recorded verbatim in the ledger). */
  command: string;
}

export type CheckedCommandParse =
  | { allowed: true; parsed: ParsedCheckedCommand }
  | { allowed: false; reason: string };

const FORBIDDEN_METACHARACTERS = /[;&|`$><\n\r\\]/;
const LS_FLAGS = new Set(['-l', '-a', '-la', '-al', '-1', '-h', '-lh', '-hl']);

/** Split a command line on whitespace, honouring simple quotes. */
export function tokeniseCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started || current !== '') tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return null;
  if (started || current !== '') tokens.push(current);
  return tokens;
}

function isInside(root: string, candidate: string): boolean {
  const normalisedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  return candidate === normalisedRoot || candidate.startsWith(`${normalisedRoot}/`);
}

function resolveInside(runDir: string, candidate: string, base = runDir): string | null {
  const absolute = candidate.startsWith('/')
    ? candidate
    : `${base.endsWith('/') ? base.slice(0, -1) : base}/${candidate}`;
  const parts = absolute.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const resolved = `/${stack.join('/')}`;
  return isInside(runDir, resolved) ? resolved : null;
}

/**
 * Parse one `run_checked` command against the §17.2 allow-list. Pure: it never
 * touches the filesystem, so a refusal can be tested without one.
 *
 * Deliberate restrictions, all documented in the refusal reason:
 *   - no shell metacharacters at all (no pipes, no `&&`, no redirection, no
 *     command substitution, no backslashes) — the host spawns without a shell,
 *     so what is validated is exactly what runs;
 *   - `git` runs only with `-C <dir inside the run dir>` and only
 *     `log`/`status`/`diff`;
 *   - `python3 -m unittest` runs with the run dir as cwd;
 *   - `bash … ctl.sh` accepts only `restart`, `health` and `status`, resolved
 *     inside the run dir (the flat form `ctl.sh health` resolves under
 *     `<runDir>/mock-service/`);
 *   - `cat`/`ls` accept only paths inside the run dir.
 */
export function parseCheckedCommand(command: string, runDir: string): CheckedCommandParse {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: 'refused: the command is empty' };
  if (FORBIDDEN_METACHARACTERS.test(trimmed)) {
    return {
      allowed: false,
      reason:
        'refused: the command contains a shell metacharacter (; & | ` $ > < \\ or a newline). ' +
        'run_checked spawns without a shell, so only a single plain command from the allow-list is accepted.',
    };
  }
  const tokens = tokeniseCommand(trimmed);
  if (!tokens || tokens.length === 0) {
    return { allowed: false, reason: 'refused: the command could not be tokenised (unbalanced quotes?)' };
  }
  const [binary, ...rest] = tokens;

  if (binary === 'git') {
    const dashC = rest.indexOf('-C');
    if (dashC === -1 || !rest[dashC + 1]) {
      return { allowed: false, reason: 'refused: git must be run as "git -C <dir inside the run directory> log|status|diff"' };
    }
    const repoArg = rest[dashC + 1];
    const repo = resolveInside(runDir, repoArg);
    if (!repo) {
      return { allowed: false, reason: `refused: git -C ${repoArg} is outside the run directory` };
    }
    const args = rest.filter((_, index) => index !== dashC && index !== dashC + 1);
    const sub = args[0];
    if (!sub || !['log', 'status', 'diff'].includes(sub)) {
      return {
        allowed: false,
        reason: `refused: only "git log", "git status" and "git diff" are allowed; got "${sub ?? ''}"`,
      };
    }
    for (const arg of args.slice(1)) {
      if (arg.startsWith('/')) {
        return { allowed: false, reason: `refused: absolute path ${arg} in a git argument` };
      }
    }
    return {
      allowed: true,
      parsed: {
        kind: 'git',
        argv: ['git', '-C', repo, ...args],
        cwd: runDir,
        requiresConfirmation: false,
        command: trimmed,
      },
    };
  }

  if (binary === 'python3' || binary === 'python') {
    if (rest[0] !== '-m' || rest[1] !== 'unittest') {
      return { allowed: false, reason: 'refused: only "python3 -m unittest …" is allowed' };
    }
    const args = rest.slice(2);
    for (const arg of args) {
      if (arg.startsWith('/') && !resolveInside(runDir, arg)) {
        return { allowed: false, reason: `refused: ${arg} is outside the run directory` };
      }
    }
    return {
      allowed: true,
      parsed: {
        kind: 'unittest',
        argv: [binary, '-m', 'unittest', ...args],
        cwd: runDir,
        requiresConfirmation: false,
        command: trimmed,
      },
    };
  }

  if (binary === 'bash' || binary === 'sh') {
    const ctlArg = rest[0];
    if (!ctlArg) {
      return { allowed: false, reason: 'refused: bash must be given a script path (only ctl.sh is allowed)' };
    }
    // `bash ctl.sh health` resolves under the mock service; a fuller relative
    // journey resolves against the run directory.
    const ctl = resolveInside(runDir, ctlArg, `${runDir}/mock-service`) ?? resolveInside(runDir, ctlArg);
    if (!ctl) {
      return { allowed: false, reason: `refused: ${ctlArg} is outside the run directory` };
    }
    if (!ctl.endsWith('/ctl.sh')) {
      return { allowed: false, reason: "refused: only the mock service's ctl.sh may be run with bash" };
    }
    const verb = rest[1];
    if (!verb || !['restart', 'health', 'status'].includes(verb)) {
      return {
        allowed: false,
        reason: `refused: ctl.sh accepts only restart, health or status; got "${verb ?? ''}"`,
      };
    }
    const extra = rest.slice(2);
    if (extra.length > 0) {
      return { allowed: false, reason: 'refused: ctl.sh takes no further arguments' };
    }
    return {
      allowed: true,
      parsed: {
        kind: 'ctl',
        argv: [binary, ctl, verb],
        cwd: runDir,
        requiresConfirmation: verb === 'restart',
        command: trimmed,
      },
    };
  }

  if (binary === 'cat' || binary === 'ls') {
    const args = rest.filter((arg) => arg !== '');
    let paths: string[];
    if (binary === 'ls') {
      const flags = args.filter((arg) => arg.startsWith('-'));
      for (const flag of flags) {
        if (!LS_FLAGS.has(flag)) {
          return { allowed: false, reason: `refused: ls flag ${flag} is not allowed` };
        }
      }
      paths = args.filter((arg) => !arg.startsWith('-'));
      if (paths.length === 0) paths = [runDir];
    } else {
      paths = args;
      if (paths.length === 0) {
        return { allowed: false, reason: 'refused: cat needs one path inside the run directory' };
      }
    }
    if (paths.length > 1) {
      return { allowed: false, reason: `refused: ${binary} accepts exactly one path inside the run directory` };
    }
    const target = resolveInside(runDir, paths[0]);
    if (!target) {
      return { allowed: false, reason: `refused: ${paths[0]} is outside the run directory` };
    }
    return {
      allowed: true,
      parsed: {
        kind: 'read',
        argv: [binary, ...args],
        cwd: runDir,
        target,
        requiresConfirmation: false,
        command: trimmed,
      },
    };
  }

  return {
    allowed: false,
    reason:
      `refused: "${binary}" is not on the allow-list. Allowed: git -C <dir> log|status|diff, ` +
      'python3 -m unittest …, bash ctl.sh restart|health|status, cat/ls inside the run directory.',
  };
}

// ── Injectable seams ─────────────────────────────────────────────────────────

export interface Tier3ChildSessionInfo {
  sessionId: string;
  busy: boolean;
  status: string;
  lastText: string;
  /** Conversation message count reported by `GET /sessions/:id` (when present). */
  messageCount?: number;
  /** On-disk session file reported by `GET /sessions/:id` (when present). */
  sessionPath?: string;
}

export interface Tier3CreateSessionInput {
  runtime: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  source: string;
  label: string;
}

export type Tier3DeliverMode = 'prompt' | 'follow_up' | 'steer';

export interface Tier3WatchOutcome {
  fired: boolean;
  timedOut: boolean;
  conditionId?: string;
  fireCount?: number;
  atMs: number;
}

export interface Tier3ApiClient {
  createSession(input: Tier3CreateSessionInput): Promise<{ sessionId: string; model?: string; runtime?: string }>;
  prompt(sessionId: string, message: string, mode: Tier3DeliverMode): Promise<{ dispatchMode?: string; status: number }>;
  childInfo(sessionId: string): Promise<Tier3ChildSessionInfo>;
  transcriptTail(sessionId: string, tail: number): Promise<string[]>;
  /**
   * Register a durable watch and resolve when it fires or the timeout expires.
   * The implementer polls the server's durable ledger — the MODEL never polls.
   */
  awaitWatch(
    sessionId: string,
    spec: { condition: 'idle' | 'text-contains'; text?: string; timeoutS: number },
    onRegistered?: (watchId: string) => void
  ): Promise<Tier3WatchOutcome>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface CheckedCommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface CheckedCommandRunner {
  run(parsed: ParsedCheckedCommand): Promise<CheckedCommandOutcome>;
}

/** Host → model context updates (the `confirmRequest` injection). */
export interface ConfirmRequestSink {
  (request: { action: 'create_child' | 'restart_service'; text: string }): void;
}

export interface OperatorUtteranceClassification {
  /** Committed operator text. */
  text: string;
  /** The talker's own classifier: only `confirm` grants anything. */
  kind: 'confirm' | 'cancel' | 'question' | 'statement';
}

// ── Poll accounting (§17.2) ──────────────────────────────────────────────────

/**
 * The polling rule: `child_status`/`read_child` called twice within 30 s
 * without an intervening `wait_for` is one poll. A `run_checked` command that
 * sleeps is also a poll (the classic in-turn sleep loop).
 */
export class PollTracker {
  private lastPollableAtMs: number | null = null;
  private waitSinceLastPollable = false;
  private count = 0;

  constructor(private readonly windowMs: number = POLL_WINDOW_MS) {}

  noteWaitFor(): void {
    this.waitSinceLastPollable = true;
  }

  /** Record a pollable read; returns true when it counts as a poll. */
  noteRead(atMs: number): boolean {
    const counted =
      this.lastPollableAtMs !== null &&
      atMs - this.lastPollableAtMs < this.windowMs &&
      !this.waitSinceLastPollable;
    this.lastPollableAtMs = atMs;
    this.waitSinceLastPollable = false;
    if (counted) this.count += 1;
    return counted;
  }

  noteSleepCommand(atMs: number): void {
    this.count += 1;
    this.lastPollableAtMs = atMs;
    this.waitSinceLastPollable = false;
  }

  get polls(): number {
    return this.count;
  }
}

// ── The confirmation protocol (host-enforced) ────────────────────────────────

export type ConfirmationOutcome =
  | { confirmed: true; text: string }
  | { confirmed: false; reason: 'no-confirmation' };

export interface ConfirmationTimers {
  nowMs(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

interface PendingConfirmation {
  action: 'create_child' | 'restart_service';
  requestedAtMs: number;
  resolve: (outcome: ConfirmationOutcome) => void;
  cancelTimer: () => void;
  /** Settles with the same outcome; lets later requests queue behind this one. */
  promise: Promise<ConfirmationOutcome>;
}

/**
 * The confirmation registry. A confirmation is a *committed operator utterance
 * classified `confirm` within 60 s of the tool's request* — never the model's
 * claim. Requests are serialised: only one consequential action can be pending,
 * so a later request cannot be satisfied by an earlier grant.
 */
export class ConfirmationRegistry {
  private pendingEntry: PendingConfirmation | null = null;
  private grantedActions = new Set<string>();
  private requestSeq = 0;
  private requestSink: ConfirmRequestSink | undefined;

  constructor(
    private readonly timers: ConfirmationTimers,
    onRequest?: ConfirmRequestSink,
    private readonly windowMs: number = CONFIRMATION_WINDOW_MS
  ) {
    this.requestSink = onRequest;
  }

  /**
   * Wire (or re-wire) the sink that injects "the owner must confirm; ask them"
   * into the model's context. The tier-3 orchestrator installs its own context
   * update here, so a confirmation request can never be a silent wait.
   */
  setRequestSink(sink: ConfirmRequestSink | undefined): void {
    this.requestSink = sink;
  }

  get pending(): { action: string; requestedAtMs: number } | null {
    return this.pendingEntry
      ? { action: this.pendingEntry.action, requestedAtMs: this.pendingEntry.requestedAtMs }
      : null;
  }

  /** True when the action has already been granted once this run. */
  wasGranted(action: 'create_child' | 'restart_service'): boolean {
    return this.grantedActions.has(action);
  }

  /**
   * Ask the owner. The returned promise settles when a committed confirmation
   * arrives or the 60 s window lapses.
   *
   * Requests are serialised rather than refused: a request for an action the
   * owner has already granted this run is satisfied immediately (the §17.3
   * permission table grants each consequential action once), and anything else
   * queues behind the request in flight so a second tool call cannot race the
   * first into a spurious refusal. A grant for one action never satisfies a
   * different one.
   */
  async request(
    action: 'create_child' | 'restart_service',
    description: string
  ): Promise<ConfirmationOutcome> {
    if (this.wasGranted(action)) {
      return { confirmed: true, text: `${action} was already confirmed by the owner this run` };
    }
    let guard = 0;
    while (this.pendingEntry && guard < 100) {
      guard += 1;
      await this.pendingEntry.promise;
      if (this.wasGranted(action)) {
        return { confirmed: true, text: `${action} was already confirmed by the owner this run` };
      }
    }
    if (this.wasGranted(action)) {
      return { confirmed: true, text: `${action} was already confirmed by the owner this run` };
    }
    return this.begin(action, description);
  }

  private begin(
    action: 'create_child' | 'restart_service',
    description: string
  ): Promise<ConfirmationOutcome> {
    this.requestSeq += 1;
    const text = `The owner must confirm before you ${description}. Ask them now, in one short question, and wait.`;
    let settlePromise: (outcome: ConfirmationOutcome) => void = () => {};
    const promise = new Promise<ConfirmationOutcome>((resolve) => {
      settlePromise = resolve;
    });
    this.pendingEntry = {
      action,
      requestedAtMs: this.timers.nowMs(),
      resolve: (outcome) => {
        settlePromise(outcome);
      },
      cancelTimer: () => undefined,
      promise,
    };
    const cancelTimer = this.timers.setTimeout(() => {
      this.settle({ confirmed: false, reason: 'no-confirmation' });
    }, this.windowMs);
    this.pendingEntry.cancelTimer = cancelTimer;
    this.requestSink?.({ action, text });
    return promise;
  }

  /**
   * Feed a committed operator utterance. Returns true when it settled the
   * pending request. Only a committed `confirm` grants; anything else — a
   * question, a re-statement, the model's own claim — does not.
   */
  noteOperatorUtterance(utterance: OperatorUtteranceClassification): boolean {
    if (!this.pendingEntry) return false;
    if (utterance.kind !== 'confirm') return false;
    return this.settle({ confirmed: true, text: utterance.text });
  }

  /** Force the window closed (used when a connection dies mid-request). */
  lapse(): void {
    if (this.pendingEntry) this.settle({ confirmed: false, reason: 'no-confirmation' });
  }

  private settle(outcome: ConfirmationOutcome): boolean {
    const entry = this.pendingEntry;
    if (!entry) return false;
    this.pendingEntry = null;
    entry.cancelTimer();
    if (outcome.confirmed) this.grantedActions.add(entry.action);
    entry.resolve(outcome);
    return true;
  }
}

// ── The tool host ────────────────────────────────────────────────────────────

export interface ChildInvariant {
  runtime: string;
  provider: string;
  model: string;
  thinkingLevel: string;
}

export const DEFAULT_CHILD_INVARIANT: ChildInvariant = {
  runtime: 'pi',
  provider: 'zai',
  model: 'zai/glm-5.3-flash',
  thinkingLevel: 'high',
};

/** The GLM peak-window twin (§10.1): same route, command-code subscription. */
export const PEAK_WINDOW_TWIN: ChildInvariant = {
  runtime: 'pi',
  provider: 'commandcode',
  model: 'commandcode/z-ai/glm-5.3-flash',
  thinkingLevel: 'high',
};

export interface Tier3ChildRecord {
  sessionId: string;
  name: string;
  cwd: string;
  brief: string;
  briefBytes: number;
  briefSha256: string;
  model: string;
  thinkingLevel: string;
  generation: number;
  createdAtMs: number;
}

export interface Tier3LedgerEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'completed' | 'refused' | 'error';
  startedAtMs: number;
  completedAtMs?: number;
  result: Record<string, unknown>;
  generation: number;
  /** Set when the call needed (and received) owner confirmation. */
  confirmed?: boolean;
  /** Set when the call was counted as a poll. */
  poll?: boolean;
}

export interface Tier3ToolHostOptions {
  log: EventLog;
  clock: MonotonicClock;
  api: Tier3ApiClient;
  runDir: string;
  confirmations: ConfirmationRegistry;
  /** Real shell runner in a measured run; a scripted runner in a dry run. */
  commandRunner: CheckedCommandRunner;
  childInvariant?: ChildInvariant;
  /** Peak-window twin selection is explicit: the host never guesses a route. */
  peakWindow?: boolean;
  pollTracker?: PollTracker;
  /** Milestone sink (the orchestrator speaks it). */
  onMilestone?: (text: string, atMs: number) => void;
  /** Generation counter owner; lets reconnects tag ledger entries. */
  generationProvider?: () => number;
  readChildDefaultTail?: number;
}

export interface Tier3ToolExecution {
  ok: boolean;
  status: 'completed' | 'refused' | 'error';
  /** The object sent back to the model as the function response. */
  response: Record<string, unknown>;
}

const MILESTONE_PREFIX = 'milestone';

/**
 * Executes the seven tools. Every call is recorded in the ledger with its id,
 * args, status, result, wall time and connection generation, so the record can
 * be re-derived offline and so a reconnect can restore state from the HOST
 * rather than from the model's memory.
 */
export class Tier3ToolHost {
  readonly ledger: Tier3LedgerEntry[] = [];
  readonly children: Tier3ChildRecord[] = [];
  readonly milestones: Array<{ text: string; atMs: number }> = [];

  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly api: Tier3ApiClient;
  private readonly runDir: string;
  private readonly confirmations: ConfirmationRegistry;
  private readonly commandRunner: CheckedCommandRunner;
  private readonly invariant: ChildInvariant;
  private readonly pollTracker: PollTracker;
  private readonly onMilestone?: (text: string, atMs: number) => void;
  private readonly generationProvider: () => number;
  private readonly readChildDefaultTail: number;
  private createChildCount = 0;

  constructor(options: Tier3ToolHostOptions) {
    this.log = options.log;
    this.clock = options.clock;
    this.api = options.api;
    this.runDir = options.runDir;
    this.confirmations = options.confirmations;
    this.commandRunner = options.commandRunner;
    this.invariant = options.peakWindow
      ? (options.childInvariant ?? PEAK_WINDOW_TWIN)
      : (options.childInvariant ?? DEFAULT_CHILD_INVARIANT);
    this.pollTracker = options.pollTracker ?? new PollTracker();
    this.onMilestone = options.onMilestone;
    this.generationProvider = options.generationProvider ?? (() => 0);
    this.readChildDefaultTail = options.readChildDefaultTail ?? 20;
  }

  get childInvariant(): ChildInvariant {
    return this.invariant;
  }

  get polls(): number {
    return this.pollTracker.polls;
  }

  get createChildCalls(): number {
    return this.createChildCount;
  }

  childBySessionId(sessionId: string): Tier3ChildRecord | undefined {
    return this.children.find((child) => child.sessionId === sessionId);
  }

  childByName(name: string): Tier3ChildRecord | undefined {
    return this.children.find((child) => child.name === name);
  }

  pendingCallIds(): string[] {
    return this.ledger.filter((entry) => entry.status === 'pending').map((entry) => entry.callId);
  }

  /** The consequential action awaiting the owner's confirmation, if any. */
  pendingConfirmationAction(): string | null {
    return this.confirmations.pending?.action ?? null;
  }

  /** The registry the operator's committed utterances must be fed into. */
  get confirmationRegistry(): ConfirmationRegistry {
    return this.confirmations;
  }

  /** Host-owned state, as the reconnect context update (§17.4). */
  snapshotForReconnect(): string {
    const open = this.ledger
      .filter((entry) => entry.status === 'pending')
      .map((entry) => `${entry.name}(${entry.callId})`);
    const children = this.children.map(
      (child) => `${child.name}=${child.sessionId} @ ${child.model}/${child.thinkingLevel}`
    );
    const pending = this.confirmations.pending;
    return [
      'Reconnected.',
      `Open tool calls: ${open.length > 0 ? open.join(', ') : 'none'}.`,
      `Children: ${children.length > 0 ? children.join('; ') : 'none'}.`,
      pending ? `Awaiting your confirmation for ${pending.action}.` : 'No confirmation pending.',
    ].join(' ');
  }

  /** Execute one model tool call. Never throws: a failure is a tool result. */
  async execute(call: { name: string; args: Record<string, unknown>; id: string }): Promise<Tier3ToolExecution> {
    const startedAtMs = this.clock.nowMs();
    const generation = this.generationProvider();
    const args = call.args ?? {};
    const entry: Tier3LedgerEntry = {
      callId: call.id,
      name: call.name,
      args,
      status: 'pending',
      startedAtMs,
      result: {},
      generation,
    };
    this.ledger.push(entry);
    this.log.append({
      source: 'tier3-tools',
      kind: EVENT.PROVIDER_CONTENT,
      id: `tier3:tool-call:${call.id}`,
      payload: { toolCall: { name: call.name, args, id: call.id }, generation },
    });

    const validated = validateToolArgs(call.name, args);
    if (!validated.ok) {
      return this.settle(entry, 'refused', { ok: false, refused: validated.reason });
    }

    try {
      switch (call.name as Tier3ToolName) {
        case 'create_child':
          return await this.createChild(entry, validated.value, startedAtMs);
        case 'prompt_child':
          return await this.promptChild(entry, validated.value);
        case 'child_status':
          return await this.childStatus(entry, validated.value);
        case 'read_child':
          return await this.readChild(entry, validated.value);
        case 'wait_for':
          return await this.waitFor(entry, validated.value, startedAtMs);
        case 'run_checked':
          return await this.runChecked(entry, validated.value, startedAtMs);
        case 'notify_owner':
          return this.notifyOwner(entry, validated.value);
        default:
          return this.settle(entry, 'refused', { ok: false, refused: `unknown tool ${call.name}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.settle(entry, 'error', { ok: false, error: message });
    }
  }

  // ── individual tools ──────────────────────────────────────────────────────

  private async createChild(
    entry: Tier3LedgerEntry,
    args: Record<string, unknown>,
    startedAtMs: number
  ): Promise<Tier3ToolExecution> {
    const name = args.name as string;
    const cwd = args.cwd as string;
    const brief = args.brief as string;

    const inside = ((): boolean => {
      const normalisedRunDir = this.runDir.endsWith('/') ? this.runDir.slice(0, -1) : this.runDir;
      return cwd === normalisedRunDir || cwd.startsWith(`${normalisedRunDir}/`);
    })();
    if (!inside) {
      return this.settle(entry, 'refused', {
        ok: false,
        refused: `refused: cwd ${cwd} is outside the run directory ${this.runDir}`,
      });
    }
    if (this.childByName(name)) {
      return this.settle(entry, 'refused', { ok: false, refused: `refused: a child named "${name}" already exists` });
    }

    // The first child of a run needs the owner's confirmation; later children
    // do not (§17.2).
    if (this.createChildCount === 0) {
      const outcome = await this.confirmations.request('create_child', 'create the first child worker');
      if (!outcome.confirmed) {
        return this.settle(entry, 'refused', {
          ok: false,
          refused: 'refused: no-confirmation (the owner did not confirm creating a child)',
        });
      }
      entry.confirmed = true;
    }

    const created = await this.api.createSession({
      runtime: this.invariant.runtime,
      cwd,
      model: this.invariant.model,
      thinkingLevel: this.invariant.thinkingLevel,
      source: 'voice-live-lab-tier3',
      label: `voice-live-lab:${name}`,
    });
    this.createChildCount += 1;
    const record: Tier3ChildRecord = {
      sessionId: created.sessionId,
      name,
      cwd,
      brief,
      briefBytes: Buffer.byteLength(brief, 'utf8'),
      briefSha256: createHash('sha256').update(brief).digest('hex'),
      model: created.model ?? this.invariant.model,
      thinkingLevel: this.invariant.thinkingLevel,
      generation: entry.generation,
      createdAtMs: startedAtMs,
    };
    this.children.push(record);

    const dispatched = await this.api.prompt(created.sessionId, brief, 'prompt');
    this.log.append({
      source: 'tier3-tools',
      kind: EVENT.PROVIDER_CONTENT,
      id: `tier3:child-created:${created.sessionId}`,
      payload: {
        name,
        sessionId: created.sessionId,
        briefBytes: record.briefBytes,
        briefSha256: record.briefSha256,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
        dispatchMode: dispatched.dispatchMode ?? 'prompt',
      },
    });
    return this.settle(entry, 'completed', {
      ok: true,
      sessionId: created.sessionId,
      name,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      briefBytes: record.briefBytes,
    });
  }

  private async promptChild(
    entry: Tier3LedgerEntry,
    args: Record<string, unknown>
  ): Promise<Tier3ToolExecution> {
    const sessionId = args.sessionId as string;
    const message = args.message as string;
    const deliverAs = (args.deliverAs as Tier3DeliverMode | undefined) ?? 'prompt';
    const child = this.childBySessionId(sessionId);
    if (!child) {
      return this.settle(entry, 'refused', {
        ok: false,
        refused: `refused: ${sessionId} is not a child created in this run; the host will not prompt an unknown session`,
      });
    }
    const result = await this.api.prompt(sessionId, message, deliverAs);
    this.log.append({
      source: 'tier3-tools',
      kind: EVENT.PROVIDER_CONTENT,
      id: `tier3:prompt-child:${entry.callId}`,
      payload: {
        sessionId,
        childName: child.name,
        deliverAs,
        dispatchMode: result.dispatchMode ?? deliverAs,
        messageChars: message.length,
        messageSha256: createHash('sha256').update(message).digest('hex'),
      },
    });
    return this.settle(entry, 'completed', {
      ok: true,
      sessionId,
      deliverAs,
      dispatchMode: result.dispatchMode ?? deliverAs,
    });
  }

  private async childStatus(
    entry: Tier3LedgerEntry,
    args: Record<string, unknown>
  ): Promise<Tier3ToolExecution> {
    const sessionId = args.sessionId as string;
    const info = await this.api.childInfo(sessionId);
    const counted = this.pollTracker.noteRead(this.clock.nowMs());
    entry.poll = counted;
    if (counted) {
      this.log.append({
        source: 'tier3-tools',
        kind: EVENT.HARNESS_MECHANICAL,
        id: `tier3:poll:${entry.callId}`,
        payload: { tool: 'child_status', sessionId, polls: this.pollTracker.polls },
      });
    }
    return this.settle(entry, 'completed', {
      ok: true,
      busy: info.busy,
      status: info.status,
      lastText: info.lastText,
      countedAsPoll: counted,
    });
  }

  private async readChild(
    entry: Tier3LedgerEntry,
    args: Record<string, unknown>
  ): Promise<Tier3ToolExecution> {
    const sessionId = args.sessionId as string;
    const tail = (args.tail as number | undefined) ?? this.readChildDefaultTail;
    const lines = await this.api.transcriptTail(sessionId, tail);
    const counted = this.pollTracker.noteRead(this.clock.nowMs());
    entry.poll = counted;
    if (counted) {
      this.log.append({
        source: 'tier3-tools',
        kind: EVENT.HARNESS_MECHANICAL,
        id: `tier3:poll:${entry.callId}`,
        payload: { tool: 'read_child', sessionId, polls: this.pollTracker.polls },
      });
    }
    return this.settle(entry, 'completed', { ok: true, lines, countedAsPoll: counted });
  }

  private async waitFor(
    entry: Tier3LedgerEntry,
    args: Record<string, unknown>,
    startedAtMs: number
  ): Promise<Tier3ToolExecution> {
    const sessionId = args.sessionId as string;
    const condition = args.condition as 'idle' | 'text-contains';
    const text = args.text as string | undefined;
    const timeoutS = (args.timeoutS as number | undefined) ?? WAIT_FOR_MAX_TIMEOUT_S;
    this.pollTracker.noteWaitFor();
    this.log.append({
      source: 'tier3-tools',
      kind: EVENT.HARNESS_MECHANICAL,
      id: `tier3:wait-for:${entry.callId}`,
      payload: { sessionId, condition, text, timeoutS },
    });
    const outcome = await this.api.awaitWatch(sessionId, { condition, text, timeoutS }, (watchId) => {
      this.log.append({
        source: 'tier3-tools',
        kind: EVENT.LIFECYCLE,
        id: `tier3:watch:${entry.callId}`,
        payload: { watchId, sessionId, condition },
      });
    });
    const waitedMs = this.clock.nowMs() - startedAtMs;
    return this.settle(entry, 'completed', {
      ok: true,
      sessionId,
      condition,
      fired: outcome.fired,
      timedOut: outcome.timedOut,
      waitedMs,
      ...(outcome.conditionId ? { conditionId: outcome.conditionId } : {}),
      ...(outcome.fireCount !== undefined ? { fireCount: outcome.fireCount } : {}),
    });
  }

  private async runChecked(
    entry: Tier3LedgerEntry,
    args: Record<string, unknown>,
    startedAtMs: number
  ): Promise<Tier3ToolExecution> {
    const command = args.command as string;
    const parsed = parseCheckedCommand(command, this.runDir);
    if (!parsed.allowed) {
      this.log.append({
        source: 'tier3-tools',
        kind: EVENT.HARNESS_MECHANICAL,
        id: `tier3:refused-command:${entry.callId}`,
        payload: { command, reason: parsed.reason },
      });
      return this.settle(entry, 'refused', { ok: false, refused: parsed.reason });
    }
    if (parsed.parsed.requiresConfirmation) {
      const outcome = await this.confirmations.request(
        'restart_service',
        'restart the service with "ctl.sh restart"'
      );
      if (!outcome.confirmed) {
        return this.settle(entry, 'refused', {
          ok: false,
          refused: 'refused: no-confirmation (the owner did not confirm the service restart)',
        });
      }
      entry.confirmed = true;
    }
    const outcome = await this.commandRunner.run(parsed.parsed);
    if (/\bsleep\b/.test(command)) {
      this.pollTracker.noteSleepCommand(this.clock.nowMs());
    }
    const totalMs = this.clock.nowMs() - startedAtMs;
    this.log.append({
      source: 'tier3-tools',
      kind: EVENT.HARNESS_MECHANICAL,
      id: `tier3:run-checked:${entry.callId}`,
      payload: {
        command,
        kind: parsed.parsed.kind,
        ...parsed.parsed.target ? { target: parsed.parsed.target } : {},
        exitCode: outcome.exitCode,
        ms: outcome.ms,
        stdoutChars: outcome.stdout.length,
        confirmed: entry.confirmed ?? false,
      },
    });
    return this.settle(
      entry,
      outcome.exitCode === 0 ? 'completed' : 'error',
      {
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        ms: totalMs,
      }
    );
  }

  private notifyOwner(entry: Tier3LedgerEntry, args: Record<string, unknown>): Tier3ToolExecution {
    const text = args.text as string;
    const atMs = this.clock.nowMs();
    this.milestones.push({ text, atMs });
    this.log.append({
      source: 'tier3-tools',
      kind: EVENT.HARNESS_RECEIPT,
      id: `tier3:${MILESTONE_PREFIX}:${entry.callId}`,
      payload: { text, milestoneIndex: this.milestones.length },
    });
    this.onMilestone?.(text, atMs);
    return this.settle(entry, 'completed', { ok: true, recorded: true, milestoneIndex: this.milestones.length });
  }

  // ── completion ────────────────────────────────────────────────────────────

  private settle(
    entry: Tier3LedgerEntry,
    status: 'completed' | 'refused' | 'error',
    response: Record<string, unknown>
  ): Tier3ToolExecution {
    entry.status = status;
    entry.completedAtMs = this.clock.nowMs();
    entry.result = response;
    this.log.append({
      source: 'tier3-tools',
      kind: status === 'completed' ? EVENT.HARNESS_RECEIPT : EVENT.HARNESS_MECHANICAL,
      id: `tier3:tool-result:${entry.callId}`,
      payload: {
        callId: entry.callId,
        name: entry.name,
        status,
        polls: this.pollTracker.polls,
        response,
      },
    });
    return { ok: status === 'completed', status, response };
  }
}

// ── The real Internal API client (measured runs) ─────────────────────────────

import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const DEFAULT_INTERNAL_API_SOCKET = `${homedir()}/.pi-web-ui/internal-api.sock`;
export const DEFAULT_INTERNAL_API_TOKEN = `${homedir()}/.pi-web-ui/internal-api-token`;

export interface HttpTier3ApiOptions {
  socketPath?: string;
  tokenPath?: string;
  token?: string;
  requestTimeoutMs?: number;
  /** Poll period while waiting on a watch ledger. */
  watchPollIntervalMs?: number;
  /** Injectable sleep, so a test never waits on a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

interface InternalApiEnvelope {
  status: number;
  body: any;
}

/**
 * The Internal API over its Unix socket, restricted to what tier 3 needs. The
 * shapes are the documented Internal API ones (`POST /sessions`,
 * `POST /sessions/:id/prompt`, `GET /sessions/:id`, `GET /sessions/:id/transcript`,
 * `POST|GET /sessions/:id/watch`). Nothing here writes to production: the
 * caller supplies the socket, and the lab's own boot script creates a
 * disposable server outside the production cgroup.
 */
export function createHttpTier3Api(options: HttpTier3ApiOptions = {}): Tier3ApiClient {
  const socketPath = options.socketPath ?? DEFAULT_INTERNAL_API_SOCKET;
  const token =
    options.token ??
    (options.tokenPath
      ? readFileSync(options.tokenPath, 'utf8').trim()
      : readFileSync(DEFAULT_INTERNAL_API_TOKEN, 'utf8').trim());
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const watchPollIntervalMs = options.watchPollIntervalMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const request = (method: string, path: string, body?: unknown): Promise<InternalApiEnvelope> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          path,
          method,
          timeout: requestTimeoutMs,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk.toString();
          });
          res.on('end', () => {
            let parsed: any = {};
            try {
              parsed = raw.trim() ? JSON.parse(raw) : {};
            } catch {
              parsed = { raw };
            }
            resolve({ status: res.statusCode ?? 500, body: parsed });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`Internal API ${method} ${path} timed out`)));
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  return {
    async createSession(input) {
      const envelope = await request('POST', '/api/v1/sessions', {
        runtime: input.runtime,
        cwd: input.cwd,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        source: input.source,
      });
      if (envelope.status >= 400) {
        throw new Error(
          `create_session failed: HTTP ${envelope.status} ${JSON.stringify(envelope.body).slice(0, 300)}`
        );
      }
      const body = (envelope.body?.data ?? envelope.body) as { sessionId?: string; model?: string; runtime?: string };
      if (!body?.sessionId) throw new Error('create_session returned no sessionId');
      return { sessionId: body.sessionId, model: body.model, runtime: body.runtime };
    },

    async prompt(sessionId, message, mode) {
      const envelope = await request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        message,
        mode,
        verbosity: 'answers',
        detach: true,
      });
      const body = (envelope.body?.data ?? envelope.body) as { dispatchMode?: string };
      return { dispatchMode: body?.dispatchMode, status: envelope.status };
    },

    async childInfo(sessionId) {
      const envelope = await request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
      const body = (envelope.body?.data ?? envelope.body) as Record<string, unknown>;
      const lastText = typeof body?.lastText === 'string' ? body.lastText : '';
      return {
        sessionId,
        busy: Boolean(body?.busy),
        status: typeof body?.status === 'string' ? body.status : 'unknown',
        lastText,
        ...(typeof body?.messageCount === 'number' ? { messageCount: body.messageCount } : {}),
        ...(typeof body?.sessionPath === 'string' ? { sessionPath: body.sessionPath } : {}),
      };
    },

    async transcriptTail(sessionId, tail) {
      const envelope = await request(
        'GET',
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?view=screen`
      );
      const body = (envelope.body?.data ?? envelope.body) as Record<string, unknown>;
      const lines = Array.isArray(body?.lines)
        ? (body.lines as unknown[]).map((line) => String(line))
        : typeof body?.text === 'string'
          ? body.text.split('\n')
          : [];
      return lines.slice(-tail);
    },

    async awaitWatch(sessionId, spec, onRegistered) {
      const startedAtMs = Date.now();
      const deadline = startedAtMs + spec.timeoutS * 1000;
      const condition: Record<string, unknown> =
        spec.condition === 'idle'
          ? { id: 'idle', type: 'event_type', eventType: 'agent_end', once: true }
          : { id: 'text', type: 'text', contains: spec.text, source: 'any', once: true };
      const registered = await request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
        conditions: [condition],
      });
      if (registered.status >= 400) {
        throw new Error(`watch registration failed: HTTP ${registered.status}`);
      }
      const watched = (registered.body?.data ?? registered.body) as { watchId?: string; id?: string };
      if (watched?.watchId ?? watched?.id) onRegistered?.((watched.watchId ?? watched.id) as string);

      // A one-shot watch releases its residency claim when it fires; a watch
      // that timed out would hold one for the rest of the run, so it is always
      // deleted on the way out (best effort: cleanup must not mask the result).
      const release = async (): Promise<void> => {
        try {
          await request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`);
        } catch {
          /* the ledger stays readable either way */
        }
      };

      try {
        for (;;) {
          const poll = await request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`);
          const body = (poll.body?.data ?? poll.body) as Record<string, unknown>;
          const allFired = Boolean(body?.allFired);
          const firings = Array.isArray(body?.firings) ? (body.firings as unknown[]) : [];
          if (allFired && firings.length > 0) {
            return {
              fired: true,
              timedOut: false,
              conditionId: 'idle',
              fireCount: firings.length,
              atMs: Date.now() - startedAtMs,
            };
          }
          if (Date.now() >= deadline) {
            return { fired: false, timedOut: true, atMs: Date.now() - startedAtMs };
          }
          await sleep(watchPollIntervalMs);
        }
      } finally {
        await release();
      }
    },

    async deleteSession(sessionId) {
      await request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    },
  };
}

// ── Hermetic doubles (dry runs and tests) ────────────────────────────────────

export interface FakeChildSessionOptions {
  sessionId: string;
  busy?: boolean;
  status?: string;
  lastText?: string;
  transcript?: string[];
}

export interface FakeTier3ApiOptions {
  sessions?: FakeChildSessionOptions[];
  /** Outcome for each awaitWatch call. Default: fire immediately. */
  watchOutcome?: (sessionId: string, spec: { condition: string }) => 'fire' | 'timeout';
  /** Await this before resolving a watch — lets a test hold a tool call open. */
  watchGate?: () => Promise<void>;
  /** Ids handed to created sessions, in order. Default: child-<n>. */
  newSessionIds?: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FakeTier3Api extends Tier3ApiClient {
  readonly created: Tier3CreateSessionInput[];
  readonly prompts: Array<{ sessionId: string; message: string; mode: Tier3DeliverMode }>;
  readonly watches: Array<{ sessionId: string; condition: string; text?: string; timeoutS: number }>;
  readonly deleted: string[];
  completeTurn(sessionId: string, lastText?: string): void;
}

/**
 * A fully scripted Internal API. No socket, no child session, no service: the
 * dry run's children live here, so a hermetic attempt exercises the real tool
 * surface without ever touching the operator's world.
 */
export function createFakeTier3Api(options: FakeTier3ApiOptions = {}): FakeTier3Api {
  const now = options.now ?? (() => 0);
  const sleep = options.sleep ?? (async () => undefined);
  const sessions = new Map<string, Required<FakeChildSessionOptions>>();
  for (const session of options.sessions ?? []) {
    sessions.set(session.sessionId, {
      sessionId: session.sessionId,
      busy: session.busy ?? false,
      status: session.status ?? 'idle',
      lastText: session.lastText ?? '',
      transcript: session.transcript ?? [],
    });
  }
  const created: Tier3CreateSessionInput[] = [];
  const prompts: Array<{ sessionId: string; message: string; mode: Tier3DeliverMode }> = [];
  const watches: Array<{ sessionId: string; condition: string; text?: string; timeoutS: number }> = [];
  const deleted: string[] = [];
  let createIndex = 0;

  return {
    created,
    prompts,
    watches,
    deleted,
    completeTurn(sessionId, lastText) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.busy = false;
      session.status = 'idle';
      if (lastText !== undefined) {
        session.lastText = lastText;
        session.transcript.push(lastText);
      }
    },
    async createSession(input) {
      created.push(input);
      const sessionId = options.newSessionIds?.[createIndex] ?? `child-${createIndex + 1}`;
      createIndex += 1;
      sessions.set(sessionId, {
        sessionId,
        busy: true,
        status: 'running',
        lastText: '',
        transcript: [],
      });
      return { sessionId, model: input.model, runtime: input.runtime };
    },
    async prompt(sessionId, message, mode) {
      prompts.push({ sessionId, message, mode });
      const session = sessions.get(sessionId);
      if (session) {
        session.busy = true;
        session.status = 'running';
        session.transcript.push(`> ${message}`);
      }
      return { dispatchMode: mode, status: 200 };
    },
    async childInfo(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return { sessionId, busy: session.busy, status: session.status, lastText: session.lastText };
    },
    async transcriptTail(sessionId, tail) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return session.transcript.slice(-tail);
    },
    async awaitWatch(sessionId, spec, onRegistered) {
      watches.push({ sessionId, condition: spec.condition, text: spec.text, timeoutS: spec.timeoutS });
      onRegistered?.(`watch-${watches.length}`);
      if (options.watchGate) await options.watchGate();
      const outcome = options.watchOutcome?.(sessionId, spec) ?? 'fire';
      if (outcome === 'timeout') {
        return { fired: false, timedOut: true, atMs: now() + spec.timeoutS * 1000 };
      }
      if (spec.condition === 'idle') this.completeTurn(sessionId);
      await sleep(0);
      return { fired: true, timedOut: false, conditionId: 'idle', fireCount: 1, atMs: now() };
    },
    async deleteSession(sessionId) {
      deleted.push(sessionId);
      sessions.delete(sessionId);
    },
  };
}

/** A scripted `run_checked` runner: matches by command substring, else exit 0. */
export function createScriptedCommandRunner(
  script: Array<{ contains: string; exitCode?: number; stdout?: string; stderr?: string }> = []
): CheckedCommandRunner & { readonly calls: ParsedCheckedCommand[] } {
  const calls: ParsedCheckedCommand[] = [];
  return {
    calls,
    async run(parsed) {
      calls.push(parsed);
      const rule = script.find((entry) => parsed.command.includes(entry.contains));
      return {
        exitCode: rule?.exitCode ?? 0,
        stdout: rule?.stdout ?? '',
        stderr: rule?.stderr ?? '',
        ms: 1,
      };
    },
  };
}

/** A real runner: spawn without a shell, so the validated command is what runs. */
export function createLocalCommandRunner(options: { timeoutMs?: number } = {}): CheckedCommandRunner {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async run(parsed) {
      const { spawn } = await import('node:child_process');
      const startedMs = Date.now();
      return new Promise<CheckedCommandOutcome>((resolve) => {
        const child = spawn(parsed.argv[0], parsed.argv.slice(1), {
          cwd: parsed.cwd,
          shell: false,
          env: { ...process.env },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ exitCode: 127, stdout, stderr: `${stderr}${String(error)}`, ms: Date.now() - startedMs });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout, stderr, ms: Date.now() - startedMs });
        });
      });
    },
  };
}
