/**
 * B4 — drain-then-restart (contract 1.51.0).
 *
 * WHY
 *
 * `pi-web-ui.service` runs every in-process orchestration child inside the
 * unit's control group, so a restart kills them all. Before B4 the only guard
 * was a restart script refusing while `activeTurns > 0`; about half of all
 * restarts checked first, and a child that was queued but not yet turning, or
 * that started a turn between the check and the restart, died silently.
 *
 * WHAT THIS MODULE OWNS
 *
 * The drain state machine:
 *
 *   idle ──start──▶ draining ──(nothing in flight)──▶ settled ─┐
 *                      │                                        ├─(hold expires | cancel)─▶ idle
 *                      └────────(timeout elapsed)───▶ timed_out ┘
 *
 * - `start` closes admission for new P2/P3 execution through the shared
 *   admission seam (`setDraining`); P0/P1 control and session DELETE keep
 *   working.
 * - The settle wait covers BOTH active execution turns AND nonterminal run
 *   receipts (`accepted`/`queued`/`started`). A queued follow-up has no active
 *   turn yet but is still work a restart would destroy. Quarantined capacity
 *   debt (a terminal run whose runtime never confirmed cessation) is excluded:
 *   no wait can clear it, and waiting on it would always run to the timeout.
 * - `settled`/`timed_out` are verdicts, not the end of the drain: admission
 *   stays closed until the restart (which starts a fresh process) or until the
 *   hold window lapses without one, at which point admission reopens so a
 *   crashed deploy script cannot leave the server refusing work forever.
 * - The verdict is written to a small durable record so the NEXT process can
 *   tell a planned cut-off (`drain_timeout`) from an unplanned restart when it
 *   reconciles interrupted run receipts at boot.
 *
 * The drain never aborts or terminalises anything itself. Runs still in
 * flight when the restart happens are recovered at boot by the run-receipt
 * store (status `interrupted`, `errorCode: SERVER_RESTART`), and their parents'
 * watches fire then — see `WatchManager.reconcileRestartInterruptions`.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('InternalApiDrain');

export type DrainState = 'idle' | 'draining' | 'settled' | 'timed_out';

/** Payload-free reference to one nonterminal run. */
export interface DrainRunRef {
  runId: string;
  sessionId: string;
  runtime: string;
  status: string;
}

export interface DrainStatus {
  state: DrainState;
  /** Whether admission is currently refusing new P2/P3 execution for the drain. */
  draining: boolean;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs?: number;
  /** When a settled/timed-out drain reopens admission if no restart follows. */
  holdUntil?: string;
  waitedMs?: number;
  initial?: { activeTurns: number; nonterminalRuns: number };
  remaining: { activeTurns: number; quarantinedTurns: number; nonterminalRuns: number; runs: DrainRunRef[] };
  /** Runs nonterminal at drain start that reached a terminal state during the drain. */
  completedDuringDrain: number;
  /** Runs still in flight when the drain timed out: the restart will cut these off. */
  cutOffRunIds: string[];
  retryAfterSeconds: number;
  /** The most recent drain verdict after it ended (hold expiry or cancel). */
  lastOutcome?: { state: 'settled' | 'timed_out' | 'draining'; endedBy: string; endedAt: string; cutOffRunIds: string[] };
}

export interface DrainAdmission {
  setDraining(state: { since: number; reason: string } | null): void;
  getDraining(): { since: number; reason: string } | null;
  snapshot(): { activeTurns: number };
}

export interface DrainControllerDeps {
  admission: DrainAdmission;
  /** Current nonterminal run receipts (accepted/queued/started). */
  listNonterminalRuns: () => DrainRunRef[];
  /** Admission slots held by quarantined terminal runs (capacity debt). */
  quarantinedTurns?: () => number;
  /** Durable verdict record read by the next process at boot. Omit for memory-only. */
  recordPath?: string;
  now?: () => number;
  pollIntervalMs?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  holdMs?: number;
  retryAfterSeconds?: number;
}

export interface DrainStartInput {
  reason: string;
  timeoutMs?: number;
  holdMs?: number;
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 600_000;
export const MAX_DRAIN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_DRAIN_HOLD_MS = 300_000;
export const DEFAULT_DRAIN_RETRY_AFTER_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Durable drain verdict, read once by the next process at boot. */
export interface DrainRecord {
  version: 1;
  state: 'settled' | 'timed_out';
  reason: string;
  startedAt: string;
  finishedAt: string;
  cutOffRunIds: string[];
}

const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export class DrainController {
  private readonly admission: DrainAdmission;
  private readonly listNonterminalRuns: () => DrainRunRef[];
  private readonly quarantinedTurns: () => number;
  private readonly recordPath?: string;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly defaultHoldMs: number;
  readonly retryAfterSeconds: number;

  private state: DrainState = 'idle';
  private reason?: string;
  private startedAtMs?: number;
  private finishedAtMs?: number;
  private timeoutMs?: number;
  private holdMs?: number;
  private holdUntilMs?: number;
  private initial?: { activeTurns: number; nonterminalRuns: number };
  private initialRunIds = new Set<string>();
  private remaining: DrainStatus['remaining'] = { activeTurns: 0, quarantinedTurns: 0, nonterminalRuns: 0, runs: [] };
  private cutOffRunIds: string[] = [];
  private lastOutcome?: DrainStatus['lastOutcome'];
  private pollTimer?: NodeJS.Timeout;
  private holdTimer?: NodeJS.Timeout;
  private waiters: Array<(status: DrainStatus) => void> = [];

  constructor(deps: DrainControllerDeps) {
    this.admission = deps.admission;
    this.listNonterminalRuns = deps.listNonterminalRuns;
    this.quarantinedTurns = deps.quarantinedTurns ?? (() => 0);
    this.recordPath = deps.recordPath;
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = clampInt(deps.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1, 60_000);
    this.maxTimeoutMs = clampInt(deps.maxTimeoutMs, MAX_DRAIN_TIMEOUT_MS, 0, MAX_DRAIN_TIMEOUT_MS);
    this.defaultTimeoutMs = clampInt(deps.defaultTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 0, this.maxTimeoutMs);
    this.defaultHoldMs = clampInt(deps.holdMs, DEFAULT_DRAIN_HOLD_MS, 1, MAX_DRAIN_TIMEOUT_MS);
    this.retryAfterSeconds = clampInt(deps.retryAfterSeconds, DEFAULT_DRAIN_RETRY_AFTER_SECONDS, 1, 3600);
  }

  /** Begin draining, or join the drain already in progress (its parameters win). */
  start(input: DrainStartInput): { status: DrainStatus; joined: boolean } {
    if (this.state !== 'idle') return { status: this.status(), joined: true };
    this.clearTimers();
    this.state = 'draining';
    this.reason = input.reason;
    this.startedAtMs = this.now();
    this.finishedAtMs = undefined;
    this.holdUntilMs = undefined;
    this.timeoutMs = clampInt(input.timeoutMs, this.defaultTimeoutMs, 0, this.maxTimeoutMs);
    this.holdMs = clampInt(input.holdMs, this.defaultHoldMs, 1, MAX_DRAIN_TIMEOUT_MS);
    this.cutOffRunIds = [];
    this.admission.setDraining({ since: this.startedAtMs, reason: input.reason });
    this.measure();
    this.initial = { activeTurns: this.remaining.activeTurns, nonterminalRuns: this.remaining.nonterminalRuns };
    this.initialRunIds = new Set(this.remaining.runs.map((r) => r.runId));
    logger.info(`[InternalAPI] drain started: reason=${JSON.stringify(input.reason)} timeoutMs=${this.timeoutMs} activeTurns=${this.initial.activeTurns} nonterminalRuns=${this.initial.nonterminalRuns}`);
    this.evaluate();
    if (this.state === 'draining') {
      this.pollTimer = setInterval(() => this.evaluate(), this.pollIntervalMs);
      this.pollTimer.unref?.();
    }
    return { status: this.status(), joined: false };
  }

  /** Resolves when the drain reaches a verdict (settled / timed_out) or is cancelled. */
  waitForOutcome(): Promise<DrainStatus> {
    if (this.state !== 'draining') return Promise.resolve(this.status());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** End the drain without a restart: admission reopens and the record is removed. */
  async cancel(endedBy = 'cancelled'): Promise<DrainStatus> {
    if (this.state === 'idle') return this.status();
    this.measure();
    this.lastOutcome = {
      state: this.state as 'settled' | 'timed_out' | 'draining',
      endedBy,
      endedAt: new Date(this.now()).toISOString(),
      cutOffRunIds: [...this.cutOffRunIds],
    };
    this.clearTimers();
    this.state = 'idle';
    this.admission.setDraining(null);
    this.removeRecord();
    logger.warn(`[InternalAPI] drain ended without restart: endedBy=${endedBy} previousState=${this.lastOutcome.state}; admission reopened`);
    const status = this.status();
    this.flushWaiters(status);
    return status;
  }

  status(): DrainStatus {
    const nowMs = this.now();
    const endMs = this.finishedAtMs ?? (this.state === 'draining' ? nowMs : undefined);
    return {
      state: this.state,
      draining: this.admission.getDraining() !== null && this.state !== 'idle',
      reason: this.state === 'idle' ? undefined : this.reason,
      startedAt: this.state === 'idle' || this.startedAtMs === undefined ? undefined : new Date(this.startedAtMs).toISOString(),
      finishedAt: this.state === 'idle' || this.finishedAtMs === undefined ? undefined : new Date(this.finishedAtMs).toISOString(),
      timeoutMs: this.state === 'idle' ? undefined : this.timeoutMs,
      holdUntil: this.state === 'idle' || this.holdUntilMs === undefined ? undefined : new Date(this.holdUntilMs).toISOString(),
      waitedMs: this.state === 'idle' || this.startedAtMs === undefined || endMs === undefined ? undefined : endMs - this.startedAtMs,
      initial: this.state === 'idle' ? undefined : this.initial,
      remaining: this.state === 'idle'
        ? { activeTurns: 0, quarantinedTurns: 0, nonterminalRuns: 0, runs: [] }
        : { ...this.remaining, runs: this.remaining.runs.map((r) => ({ ...r })) },
      completedDuringDrain: this.state === 'idle' ? 0 : this.completedCount(),
      cutOffRunIds: this.state === 'idle' ? [] : [...this.cutOffRunIds],
      retryAfterSeconds: this.retryAfterSeconds,
      ...(this.lastOutcome ? { lastOutcome: { ...this.lastOutcome, cutOffRunIds: [...this.lastOutcome.cutOffRunIds] } } : {}),
    };
  }

  /** Stop timers (server shutdown). Admission state is left as is: the process is ending. */
  shutdown(): void {
    this.clearTimers();
    this.flushWaiters(this.status());
  }

  private completedCount(): number {
    const stillOpen = new Set(this.remaining.runs.map((r) => r.runId));
    let completed = 0;
    for (const runId of this.initialRunIds) if (!stillOpen.has(runId)) completed += 1;
    return completed;
  }

  private measure(): void {
    let runs: DrainRunRef[] = [];
    try {
      runs = this.listNonterminalRuns();
    } catch (error) {
      logger.warn(`[InternalAPI] drain could not list nonterminal runs: ${error instanceof Error ? error.message : String(error)}`);
    }
    let active = 0;
    let quarantined = 0;
    try {
      active = this.admission.snapshot().activeTurns;
      quarantined = this.quarantinedTurns();
    } catch (error) {
      logger.warn(`[InternalAPI] drain could not read admission: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.remaining = {
      activeTurns: Math.max(0, active - quarantined),
      quarantinedTurns: quarantined,
      nonterminalRuns: runs.length,
      runs: runs.map((r) => ({ runId: r.runId, sessionId: r.sessionId, runtime: r.runtime, status: r.status })),
    };
  }

  private evaluate(): void {
    if (this.state !== 'draining' || this.startedAtMs === undefined) return;
    this.measure();
    if (this.remaining.activeTurns === 0 && this.remaining.nonterminalRuns === 0) {
      this.finish('settled');
      return;
    }
    if (this.now() - this.startedAtMs >= (this.timeoutMs ?? 0)) {
      this.cutOffRunIds = this.remaining.runs.map((r) => r.runId);
      this.finish('timed_out');
    }
  }

  private finish(state: 'settled' | 'timed_out'): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.state = state;
    this.finishedAtMs = this.now();
    this.holdUntilMs = this.finishedAtMs + (this.holdMs ?? this.defaultHoldMs);
    this.writeRecord(state);
    logger.info(`[InternalAPI] drain ${state}: waitedMs=${this.finishedAtMs - (this.startedAtMs ?? this.finishedAtMs)} completedDuringDrain=${this.completedCount()} cutOff=${this.cutOffRunIds.length} activeTurns=${this.remaining.activeTurns} nonterminalRuns=${this.remaining.nonterminalRuns}`);
    this.holdTimer = setTimeout(() => { void this.cancel('hold_expired'); }, this.holdUntilMs - this.finishedAtMs);
    this.holdTimer.unref?.();
    this.flushWaiters(this.status());
  }

  private flushWaiters(status: DrainStatus): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(status);
  }

  private clearTimers(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = undefined; }
  }

  private writeRecord(state: 'settled' | 'timed_out'): void {
    if (!this.recordPath) return;
    const record: DrainRecord = {
      version: 1,
      state,
      reason: this.reason ?? '',
      startedAt: new Date(this.startedAtMs ?? this.now()).toISOString(),
      finishedAt: new Date(this.finishedAtMs ?? this.now()).toISOString(),
      cutOffRunIds: [...this.cutOffRunIds],
    };
    try {
      mkdirSync(path.dirname(this.recordPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.recordPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, this.recordPath);
    } catch (error) {
      // The record only refines boot classification; a failed write must not
      // fail the drain. Boot then classifies cut-offs as plain server_restart.
      logger.warn(`[InternalAPI] drain record not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private removeRecord(): void {
    if (!this.recordPath) return;
    try { unlinkSync(this.recordPath); } catch { /* absent is fine */ }
  }
}

/** Read a drain record; undefined when absent or malformed. Unsafe run ids are dropped. */
export function readDrainRecord(recordPath: string): DrainRecord | undefined {
  try {
    if (!existsSync(recordPath)) return undefined;
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Partial<DrainRecord>;
    if (!raw || raw.version !== 1 || (raw.state !== 'settled' && raw.state !== 'timed_out')) return undefined;
    return {
      version: 1,
      state: raw.state,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
      cutOffRunIds: Array.isArray(raw.cutOffRunIds)
        ? raw.cutOffRunIds.filter((id): id is string => typeof id === 'string' && SAFE_RUN_ID.test(id))
        : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Read and retire the record at boot, exactly once. The consumed copy stays
 * beside it (overwritten by the next drain) as forensic evidence.
 */
export function consumeDrainRecord(recordPath: string): DrainRecord | undefined {
  const record = readDrainRecord(recordPath);
  try {
    if (existsSync(recordPath)) renameSync(recordPath, `${recordPath}.consumed`);
  } catch (error) {
    logger.warn(`[InternalAPI] drain record not retired: ${error instanceof Error ? error.message : String(error)}`);
    try { unlinkSync(recordPath); } catch { /* best effort */ }
  }
  return record;
}
