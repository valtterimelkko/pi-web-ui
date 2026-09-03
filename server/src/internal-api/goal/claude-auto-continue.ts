/**
 * Cross-runtime goal function (contract 1.27.0) — Claude auto-continue nudger.
 *
 * D3 (wide): the upstream CLI advances a goal only while a `query()` call is
 * open, so an unmet goal + idle server-side session would sit still forever.
 * This component closes that gap: a bounded sweeper sends the continuation
 * prompt as an ordinary detached prompt whenever
 *
 *   - the session is supported (SDK backend) and NOT currently running;
 *   - the latest transcript projection says unmet + auto-continue armed;
 *   - the exponential backoff window since the last nudge has elapsed;
 *   - the per-goal nudge budget (default 20) is not exhausted.
 *
 * Pause = disarm auto-continue for the session (no further nudges). Resume =
 * re-arm + one continuation prompt. Budget exhaustion marks the goal
 * failed/pausedReason:'budget' and emits exactly one `goal_end`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_GOAL_CONTINUATION_PROMPT } from './claude-goal.js';
import type { SessionGoalProjection } from './types.js';
import { isTerminalGoalStatus } from './types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ClaudeGoalAutoContinueConfig {
  enabled: boolean;
  sweepIntervalMs: number;
  maxNudges: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadClaudeGoalAutoContinueConfig(env: Record<string, string | undefined> = process.env): ClaudeGoalAutoContinueConfig {
  return {
    enabled: env.CLAUDE_GOAL_AUTO_CONTINUE !== 'false',
    sweepIntervalMs: positiveInt(env.CLAUDE_GOAL_AUTO_CONTINUE_SWEEP_MS, 30_000),
    maxNudges: positiveInt(env.CLAUDE_GOAL_AUTO_CONTINUE_MAX_NUDGES, 20),
    baseBackoffMs: positiveInt(env.CLAUDE_GOAL_AUTO_CONTINUE_BASE_BACKOFF_MS, 30_000),
    maxBackoffMs: positiveInt(env.CLAUDE_GOAL_AUTO_CONTINUE_MAX_BACKOFF_MS, 600_000),
  };
}

/** Exponential backoff for nudge n (0-based), clamped to maxBackoffMs. */
export function backoffDelayMs(baseBackoffMs: number, maxBackoffMs: number, nudgeIndex: number): number {
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, nudgeIndex));
}

// ─── Per-session control store (restart-safe budgets) ───────────────────────

export interface ClaudeGoalControlRecord {
  /** undefined/true = armed; false = user paused. */
  autoContinue?: boolean;
  nudges?: number;
  lastNudgeAt?: number;
  exhaustedAt?: number;
  /** Server-side clear marker (epoch ms): attachments older than this are history. */
  clearedAt?: number;
}

export class ClaudeGoalControlStore {
  constructor(
    private readonly dir: string,
    /** Invoked after every patch so sweep caches can invalidate per-session. */
    private readonly onWrite?: (sessionId: string) => void,
  ) {}

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<ClaudeGoalControlRecord | null> {
    try {
      const raw = await fsp.readFile(this.fileFor(sessionId), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async patch(sessionId: string, patch: ClaudeGoalControlRecord): Promise<ClaudeGoalControlRecord> {
    await fsp.mkdir(this.dir, { recursive: true });
    const current = (await this.get(sessionId)) ?? {};
    const next = { ...current, ...patch };
    await fsp.writeFile(this.fileFor(sessionId), JSON.stringify(next), 'utf8');
    this.onWrite?.(sessionId);
    return next;
  }
}

/**
 * mtime-keyed memo for nudger sweep reads (2026-09-03 defect batch).
 *
 * The sweep re-read EVERY supported Claude transcript each tick — with a large
 * registry that is a log/IO flood (measured on production: ~4.4 log lines/s,
 * hundreds of transcript reads per sweep). A projection is a pure function of
 * (transcript content, control record); the control record invalidates
 * per-session via {@link ClaudeGoalControlStore}'s onWrite hook, so an
 * unchanged transcript mtime can safely return the cached projection.
 */
export class GoalSweepReadCache<V> {
  private readonly entries = new Map<string, { key: string; value: V }>();

  constructor(private readonly limit = 500) {}

  get(id: string, key: string): V | undefined {
    const hit = this.entries.get(id);
    return hit && hit.key === key ? hit.value : undefined;
  }

  set(id: string, key: string, value: V): void {
    if (this.entries.size >= this.limit && !this.entries.has(id)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(id, { key, value });
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Nudger ──────────────────────────────────────────────────────────────────

export interface ClaudeGoalNudgerDeps {
  config: ClaudeGoalAutoContinueConfig;
  now?: () => number;
  /** Sessions eligible for goal supervision (SDK-backend claude entries). */
  listSupportedSessions: () => Promise<Array<{ sessionId: string }>>;
  /** Runtime liveness — never nudge a streaming session. */
  isRunning: (sessionId: string) => boolean;
  /** Canonical projection from the transcript (null = unreadable/no transcript). */
  readGoal: (sessionId: string) => Promise<SessionGoalProjection | null>;
  /** Control-record accessor (nudge budgets / pause flags). */
  getStore: () => ClaudeGoalControlStore;
  /** Send the continuation prompt through the normal detached pipeline. */
  dispatchDetached: (sessionId: string, message: string) => Promise<void>;
  /** Broker publisher; receives the session id + event (goal_state/goal_end). */
  publish?: (sessionId: string, event: { type: string; timestamp: number; data: unknown }) => void;
}

export interface ClaudeGoalNudger {
  sweepOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createClaudeGoalNudger(deps: ClaudeGoalNudgerDeps): ClaudeGoalNudger {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  /** Last published projection signature per session, so only CHANGES emit events. */
  const lastPublished = new Map<string, string>();
  /** Last terminal status emitted as goal_end per session (transition-once). */
  const lastTerminal = new Map<string, string>();

  function signatureOf(p: SessionGoalProjection): string {
    return JSON.stringify([p.status, p.objective, p.completedAt, p.pausedReason, p.lastReason, p.autoContinue]);
  }

  function publishIfChanged(sessionId: string, projection: SessionGoalProjection): void {
    if (!deps.publish) return;
    const signature = signatureOf(projection);
    if (lastPublished.get(sessionId) === signature) return;
    lastPublished.set(sessionId, signature);
    deps.publish(sessionId, { type: 'goal_state', timestamp: now(), data: projection });
    if (isTerminalGoalStatus(projection.status) && lastTerminal.get(sessionId) !== projection.status) {
      lastTerminal.set(sessionId, projection.status);
      deps.publish(sessionId, { type: 'goal_end', timestamp: now(), data: projection });
    } else if (!isTerminalGoalStatus(projection.status)) {
      lastTerminal.delete(sessionId);
    }
  }
  async function handleBudgetExhaustion(sessionId: string, record: ClaudeGoalControlRecord): Promise<void> {
    if (!record.exhaustedAt) {
      await deps.getStore().patch(sessionId, { exhaustedAt: now(), autoContinue: false });
      if (deps.publish) {
        const timestamp = now();
        const data: SessionGoalProjection = {
          supported: true,
          status: 'failed',
          pausedReason: 'budget',
          lastReason: `auto-continue nudge budget exhausted (${deps.config.maxNudges} nudges); start or resume to re-arm`,
        };
        deps.publish(sessionId, { type: 'goal_state', timestamp, data });
        deps.publish(sessionId, { type: 'goal_end', timestamp, data });
      }
    }
  }

  const nudger: ClaudeGoalNudger = {
    async sweepOnce(): Promise<void> {
      try {
        if (!deps.config.enabled) return;
        const sessions = await deps.listSupportedSessions();
        for (const { sessionId } of sessions) {
          try {
            if (deps.isRunning(sessionId)) continue;
            const projection = await deps.readGoal(sessionId);
            if (!projection || !projection.supported) continue;
            // Contract 1.27.0 (2d): emit goal_state on projection changes; the
            // sweep is the Claude path's state-change detector.
            publishIfChanged(sessionId, projection);
            const store = deps.getStore();
            let record = (await store.get(sessionId)) ?? {};

            // Terminal states reset the budget so a NEW goal starts fresh.
            if (projection.status === 'achieved' || projection.status === 'cleared' || projection.status === 'failed') {
              if ((record.nudges ?? 0) > 0 || record.exhaustedAt) {
                record = await store.patch(sessionId, { nudges: 0, lastNudgeAt: undefined, exhaustedAt: undefined });
              }
              continue;
            }
            if (projection.status !== 'running') continue; // paused / idle / unknown

            if (record.exhaustedAt || (record.nudges ?? 0) >= deps.config.maxNudges) {
              await handleBudgetExhaustion(sessionId, record);
              continue;
            }

            const nudges = record.nudges ?? 0;
            const lastNudgeAt = record.lastNudgeAt;
            const due = lastNudgeAt === undefined
              || now() - lastNudgeAt >= backoffDelayMs(deps.config.baseBackoffMs, deps.config.maxBackoffMs, Math.max(0, nudges));
            if (!due) continue;

            await deps.dispatchDetached(sessionId, CLAUDE_GOAL_CONTINUATION_PROMPT);
            await store.patch(sessionId, { nudges: nudges + 1, lastNudgeAt: now() });
          } catch {
            /* per-session isolation: one bad session cannot stop the sweep */
          }
        }
      } catch {
        /* listing failure — retry on next sweep */
      }
    },
    start(): void {
      if (timer || !deps.config.enabled) return;
      timer = setInterval(() => { void nudger.sweepOnce(); }, deps.config.sweepIntervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return nudger;
}
