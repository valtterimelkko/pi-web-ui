/**
 * Cross-runtime goal function (contract 1.27.0) — Claude (SDK backend) read path.
 *
 * Claude Code 2.1.245+ has a native `/goal [<condition>|clear]`. The CLI's
 * Stop-hook verifier drives the loop inside one `query()` call and persists
 * every verdict as a `goal_status` attachment in the session transcript JSONL:
 *
 *   {"type":"attachment","attachment":{"type":"goal_status",
 *    "met":false,"sentinel":true,"condition":"…"}}          ← goal set
 *   {"type":"attachment","attachment":{"type":"goal_status",
 *    "met":false,"condition":"…","reason":"verdict text"}}  ← unmet verdict
 *   {"type":"attachment","attachment":{"type":"goal_status",
 *    "met":true,"condition":"…","reason":"verdict text"}}   ← achieved
 *
 * `active_goal` stream frames are dropped by the SDK message adapter, so these
 * transcript attachments are the only reliable read path. The upstream CLI has
 * NO pause/resume — pause/resume are server-side semantics on top of the
 * auto-continue nudger (see claude-auto-continue.ts).
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ErrorCode } from '../error-codes.js';
import type { CanonicalGoalStatus, SessionGoalProjection } from './types.js';

/**
 * Resolve the Claude projects transcript root.
 * Honours CLAUDE_CONFIG_DIR (set by real Claude profiles / channel backends);
 * defaults to ~/.claude/projects. Injectable so tests can redirect without
 * env tricks (worker threads snapshot process.env, making os.homedir()
 * redirection unreliable under vitest).
 */
export function resolveClaudeProjectsRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Full transcript path for a claude session (mirrors the CLI's own encoding).
 *
 * The CLI encodes the cwd by replacing '/' and '.' with '-' — '/tmp/w' becomes
 * '-tmp-w' (the leading dash IS the replaced root slash; no extra prefix).
 * Verified against live CLI 2.1.245 transcripts. Note: claude-process-pool's
 * resolveClaudeSessionPath adds an extra prefix and does NOT match the CLI's
 * on-disk layout — do not copy from there.
 */
export function resolveClaudeTranscriptPath(cwd: string, claudeSessionId: string, projectsRoot?: string): string {
  const root = projectsRoot ?? resolveClaudeProjectsRoot();
  const encodedCwd = cwd.replace(/[/.]/g, '-');
  return path.join(root, encodedCwd, `${claudeSessionId}.jsonl`);
}

export interface ClaudeGoalStatus {
  met?: boolean;
  sentinel?: boolean;
  impossible?: boolean;
  condition?: string;
  reason?: string;
  /** Raw timestamp as written by the CLI (ISO string or epoch ms). */
  timestamp?: number | string;
  /** Normalised epoch-ms timestamp (set by the reader). */
  timestampMs?: number;
  [key: string]: unknown;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export interface ReadClaudeGoalOptions {
  /** Maximum number of tail bytes to scan. Transcripts can be huge; goals live at the end. */
  maxTailBytes?: number;
}

const DEFAULT_MAX_TAIL_BYTES = 512 * 1024;

/**
 * Read the latest `goal_status` attachments from a Claude transcript JSONL.
 * Missing file / malformed lines answer with an empty list — never throw.
 */
export async function readClaudeGoalStatuses(
  transcriptPath: string,
  options: ReadClaudeGoalOptions = {},
): Promise<ClaudeGoalStatus[]> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(transcriptPath);
  } catch {
    return [];
  }
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const start = Math.max(0, stat.size - maxTailBytes);
  let buf: Buffer;
  try {
    const handle = await fsp.open(transcriptPath, 'r');
    try {
      buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  // Drop a possibly-truncated leading line when we skipped bytes.
  const text = buf.toString('utf8');
  const effective = start > 0 ? text.slice(text.indexOf('\n') + 1) : text;

  const statuses: ClaudeGoalStatus[] = [];
  for (const rawLine of effective.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === 'attachment') {
        const attachment = parsed.attachment as Record<string, unknown> | undefined;
        if (attachment && attachment.type === 'goal_status') {
          const status = attachment as ClaudeGoalStatus;
          status.timestampMs = toMs(status.timestamp) ?? toMs(parsed.timestamp);
          statuses.push(status);
        }
      } else if (parsed.type === 'goal_status') {
        // Shape-drift tolerance: some CLI versions may write the entry flat.
        const status = parsed as ClaudeGoalStatus;
        status.timestampMs = toMs(status.timestamp);
        statuses.push(status);
      }
    } catch {
      /* malformed line — transcripts tolerate third-party noise; skip */
    }
  }
  return statuses;
}

function canonicalFromLast(
  last: ClaudeGoalStatus,
  hasAny: boolean,
  autoContinue: boolean | undefined,
): { status: CanonicalGoalStatus; pausedReason?: string } {
  if (!hasAny) return { status: 'idle' };
  if (last.met === true) return { status: 'achieved' };
  if (last.impossible === true) return { status: 'failed' };
  // Unmet (sentinel or verdict): armed nudger keeps it honestly 'running';
  // disarmed auto-continue is exactly what server-side pause means.
  return autoContinue === false ? { status: 'paused', pausedReason: 'user' } : { status: 'running' };
}

/**
 * Project Claude transcript attachments into the canonical vocabulary.
 * `control` carries server-side auto-continue state (undefined = default ON).
 */
export function projectClaudeGoal(
  statuses: ClaudeGoalStatus[],
  control: { autoContinue?: boolean; nudges?: number; maxNudges?: number; clearedAt?: number } = {},
): SessionGoalProjection {
  if (statuses.length === 0) {
    return { supported: true, status: 'idle', autoContinue: control.autoContinue !== false };
  }
  const last = statuses[statuses.length - 1];
  // A server-side clear marker suppresses stale attachments: anything at or
  // before the clear moment is history, not a live goal.
  if (control.clearedAt !== undefined) {
    const lastMs = last.timestampMs;
    if (lastMs === undefined || lastMs <= control.clearedAt) {
      return {
        supported: true,
        status: 'cleared',
        objective: typeof last.condition === 'string' ? last.condition : undefined,
        autoContinue: control.autoContinue !== false,
        runtimeState: statuses.slice(-10),
      };
    }
  }
  const { status, pausedReason } = canonicalFromLast(last, statuses.length > 0, control.autoContinue);
  const objective = typeof last.condition === 'string' ? last.condition : undefined;
  const projection: SessionGoalProjection = {
    supported: true,
    status,
    objective,
    verification: last.reason !== undefined ? { message: last.reason ?? null } : undefined,
    lastReason: last.reason ?? null,
    startedAt: undefined,
    completedAt: status === 'achieved' ? (last.timestampMs ?? null) : null,
    pausedReason: pausedReason ?? null,
    autoContinue: control.autoContinue !== false,
    runtimeState: statuses.slice(-10),
  };
  if (typeof last.sentinel === 'boolean' || last.impossible === true) {
    projection.runtimeState = statuses.slice(-10);
  }
  return projection;
}

// ─── Control composition ─────────────────────────────────────────────────────

export type ClaudeGoalAction = 'start' | 'pause' | 'resume' | 'clear';

const MAX_OBJECTIVE_CHARS = 4000;

/** Upstream `/goal` takes only `<condition> | clear`; pause/resume are ours. */
export function composeClaudeGoalCommand(
  body: { action?: string; objective?: string },
): { ok: true; action: ClaudeGoalAction; command: string } | { ok: false; error: { code: string; message: string } } {
  const action = body.action;
  if (action === 'pause' || action === 'resume') {
    // Server-side only: there is no upstream command; handled by the caller.
    return { ok: false, error: { code: ErrorCode.UNSUPPORTED_OPERATION, message: `action '${action}' is server-side for Claude and is handled by the goal route, not composed as a prompt` } };
  }
  if (action === 'clear') {
    return { ok: true, action, command: '/goal clear' };
  }
  if (action !== 'start') {
    return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message: 'action must be one of start|pause|resume|clear' } };
  }
  const objective = body.objective;
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message: "action 'start' requires a non-empty objective" } };
  }
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message: `objective must be at most ${MAX_OBJECTIVE_CHARS} characters` } };
  }
  if (/[\n\r]/.test(objective)) {
    return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message: 'objective must be a single line (no newlines)' } };
  }
  return { ok: true, action, command: `/goal ${objective.trim()}` };
}

/** Detached continuation prompt sent by the auto-continue nudger on resume/nudge. */
export const CLAUDE_GOAL_CONTINUATION_PROMPT =
  'Continue working toward the active goal. Re-check the goal condition against current reality, make progress, and report whether it is now fully met.';
