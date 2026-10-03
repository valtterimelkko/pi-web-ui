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

/**
 * B4.1 (contract 1.52.0): payload-free reference to one RESIDENT BUSY session
 * whose in-flight turn holds no admission slot and no run receipt — a Pi
 * goal-engine continuation, another extension-driven turn (watch-wake,
 * subagent) or a browser (P0) turn. A restart would kill it silently.
 *
 * Correction 01: `runIds` carries the session's NONTERMINAL receipt ids at the
 * measurement (usually empty — these turns are receipt-less), so the boot
 * composition can tell a genuinely cut-off extension turn from one whose
 * receipt-backed run finished normally inside the window.
 */
export interface DrainBusySession {
  sessionId: string;
  runtime: string;
  /** Payload-free reason the runtime reports the session busy (e.g. `sdk_streaming`). */
  busyReason: string;
  /** Nonterminal receipt ids of this session at the measurement (usually []). */
  runIds?: string[];
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
  initial?: { activeTurns: number; nonterminalRuns: number; busySessions: number };
  remaining: { activeTurns: number; quarantinedTurns: number; nonterminalRuns: number; runs: DrainRunRef[]; busySessions: number; sessions: DrainBusySession[] };
  /** Runs nonterminal at drain start that reached a terminal state during the drain. */
  completedDuringDrain: number;
  /** Runs still in flight when the drain timed out: the restart will cut these off. */
  cutOffRunIds: string[];
  /** B4.1: busy sessions still in flight when the drain timed out (no receipt exists for them). */
  cutOffSessionIds: string[];
  /** Correction 01: caller sessions excluded from the busy-session wait (self-drain). */
  excludedSessionIds: string[];
  retryAfterSeconds: number;
  /** The most recent drain verdict after it ended (hold expiry or cancel). */
  lastOutcome?: { state: 'settled' | 'timed_out' | 'draining'; endedBy: string; endedAt: string; cutOffRunIds: string[]; cutOffSessionIds: string[] };
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
  /**
   * B4.1: resident busy sessions with no admission turn and no receipt
   * (extension-driven Pi turns, browser turns; other runtimes' busy flags).
   * Must be payload-free and read-only. Absent = none reported.
   */
  listBusySessions?: () => DrainBusySession[];
  /**
   * Correction 02: awaited (bounded) before every OUTCOME decision — the
   * sync `listBusySessions` may lag the cross-runtime snapshot, so a decision
   * taken on it alone could miss a busy session that turned busy during the
   * pending refresh. When the refresh cannot complete inside the bound, the
   * snapshot is UNKNOWN: the drain does not settle, and a timeout record says
   * `busyRefresh: "unavailable"`.
   */
  refreshBusySessions?: () => Promise<void>;
  /** Bounded wait for one busy refresh before a decision (default 2000 ms). */
  busyRefreshTimeoutMs?: number;
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
  /**
   * Wave K (contract 1.59.0): fired once when a drain times out, with the
   * cut-off context, so the server can run the interruption sweep for goal
   * children the timeout cut off (in-process; the next boot re-runs it).
   * Best-effort: errors are swallowed.
   */
  onTimedOut?: (cutOff: { runIds: string[]; sessionIds: string[] }) => void;
}

export interface DrainStartInput {
  reason: string;
  timeoutMs?: number;
  holdMs?: number;
  /**
   * Correction 01 (self-drain): sessions to EXCLUDE from the busy-session
   * settle wait — a caller that runs the deploy from its own agent session is
   * itself busy and would otherwise wait the full timeout for itself and then
   * be killed anyway. Validated and bounded by the route (safe ids, max 8);
   * the controller clamps defensively. Receipts and admission turns are NOT
   * excluded: the exclusion only lifts the busy-session wait.
   */
  excludeSessionIds?: string[];
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 600_000;
export const MAX_DRAIN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_DRAIN_HOLD_MS = 300_000;
export const DEFAULT_DRAIN_RETRY_AFTER_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Durable drain verdict, read once by the next process at boot. */
export interface DrainRecord {
  /** 2 since B4.1 (contract 1.52.0): `cutOffSessions` added. Readers accept 1 and 2. */
  version: 2;
  state: 'settled' | 'timed_out';
  reason: string;
  startedAt: string;
  finishedAt: string;
  cutOffRunIds: string[];
  /** B4.1: busy sessions still in flight at the timeout (payload-free). Correction 01: `runIds` associates the session with its nonterminal receipts. */
  cutOffSessions: Array<DrainBusySession & { runIds: string[] }>;
  /** Correction 02: whether the final decision's busy snapshot was fresh or the refresh was unavailable (absent on pre-correction records). */
  busyRefresh: 'fresh' | 'unavailable';
}

const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export class DrainController {
  private readonly admission: DrainAdmission;
  private readonly listNonterminalRuns: () => DrainRunRef[];
  private readonly listBusySessions: () => DrainBusySession[];
  private readonly refreshBusySessions?: () => Promise<void>;
  private readonly busyRefreshTimeoutMs: number;
  private readonly quarantinedTurns: () => number;
  private readonly recordPath?: string;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly defaultHoldMs: number;
  readonly retryAfterSeconds: number;
  private readonly onTimedOut?: DrainControllerDeps['onTimedOut'];

  private state: DrainState = 'idle';
  private reason?: string;
  private startedAtMs?: number;
  private finishedAtMs?: number;
  private timeoutMs?: number;
  private holdMs?: number;
  private holdUntilMs?: number;
  private initial?: { activeTurns: number; nonterminalRuns: number; busySessions: number };
  private initialRunIds = new Set<string>();
  private remaining: DrainStatus['remaining'] = { activeTurns: 0, quarantinedTurns: 0, nonterminalRuns: 0, runs: [], busySessions: 0, sessions: [] };
  private cutOffRunIds: string[] = [];
  private cutOffSessionIds: string[] = [];
  private excludedSessionIds: ReadonlySet<string> = new Set();
  private lastBusyRefreshFresh = true;
  private evaluating = false;
  private lastOutcome?: DrainStatus['lastOutcome'];
  private pollTimer?: NodeJS.Timeout;
  private holdTimer?: NodeJS.Timeout;
  private waiters: Array<(status: DrainStatus) => void> = [];

  constructor(deps: DrainControllerDeps) {
    this.admission = deps.admission;
    this.listNonterminalRuns = deps.listNonterminalRuns;
    this.listBusySessions = deps.listBusySessions ?? (() => []);
    this.refreshBusySessions = deps.refreshBusySessions;
    this.busyRefreshTimeoutMs = clampInt(deps.busyRefreshTimeoutMs, 2_000, 1, 60_000);
    this.quarantinedTurns = deps.quarantinedTurns ?? (() => 0);
    this.recordPath = deps.recordPath;
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = clampInt(deps.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1, 60_000);
    this.maxTimeoutMs = clampInt(deps.maxTimeoutMs, MAX_DRAIN_TIMEOUT_MS, 0, MAX_DRAIN_TIMEOUT_MS);
    this.defaultTimeoutMs = clampInt(deps.defaultTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 0, this.maxTimeoutMs);
    this.defaultHoldMs = clampInt(deps.holdMs, DEFAULT_DRAIN_HOLD_MS, 1, MAX_DRAIN_TIMEOUT_MS);
    this.retryAfterSeconds = clampInt(deps.retryAfterSeconds, DEFAULT_DRAIN_RETRY_AFTER_SECONDS, 1, 3600);
    this.onTimedOut = deps.onTimedOut;
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
    this.cutOffSessionIds = [];
    this.excludedSessionIds = new Set((input.excludeSessionIds ?? []).slice(0, 8));
    this.lastBusyRefreshFresh = true;
    this.admission.setDraining({ since: this.startedAtMs, reason: input.reason });
    // Provisional synchronous measurement: it fills `initial` and the visible
    // `remaining` immediately (the drain route has usually just awaited a
    // refresh via its pre-start hook). The OUTCOME DECISION is never taken on
    // it — evaluate() awaits the busy refresh first (correction 02).
    this.measure();
    this.initial = { activeTurns: this.remaining.activeTurns, nonterminalRuns: this.remaining.nonterminalRuns, busySessions: this.remaining.busySessions };
    this.initialRunIds = new Set(this.remaining.runs.map((r) => r.runId));
    logger.info(`[InternalAPI] drain started: reason=${JSON.stringify(input.reason)} timeoutMs=${this.timeoutMs} activeTurns=${this.initial.activeTurns} nonterminalRuns=${this.initial.nonterminalRuns} busySessions=${this.initial.busySessions}`);
    this.pollTimer = setInterval(() => { void this.evaluate(); }, this.pollIntervalMs);
    this.pollTimer.unref?.();
    void this.evaluate();
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
      cutOffSessionIds: [...this.cutOffSessionIds],
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
        ? { activeTurns: 0, quarantinedTurns: 0, nonterminalRuns: 0, runs: [], busySessions: 0, sessions: [] }
        : { ...this.remaining, runs: this.remaining.runs.map((r) => ({ ...r })), sessions: this.remaining.sessions.map((s) => ({ ...s, runIds: [...(s.runIds ?? [])] })) },
      completedDuringDrain: this.state === 'idle' ? 0 : this.completedCount(),
      cutOffRunIds: this.state === 'idle' ? [] : [...this.cutOffRunIds],
      cutOffSessionIds: this.state === 'idle' ? [] : [...this.cutOffSessionIds],
      excludedSessionIds: this.state === 'idle' ? [] : [...this.excludedSessionIds],
      retryAfterSeconds: this.retryAfterSeconds,
      ...(this.lastOutcome ? { lastOutcome: { ...this.lastOutcome, cutOffRunIds: [...this.lastOutcome.cutOffRunIds], cutOffSessionIds: [...this.lastOutcome.cutOffSessionIds] } } : {}),
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
    let busy: DrainBusySession[] = [];
    try {
      busy = this.listBusySessions();
    } catch (error) {
      // Fail open like the receipt source: a broken accessor must not stall
      // deploys forever. The warning keeps the blind spot visible.
      logger.warn(`[InternalAPI] drain could not list busy sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Self-drain exclusion (correction 01) lifts only the busy-session wait.
    busy = busy.filter((s) => !this.excludedSessionIds.has(s.sessionId));
    // Correction 01: associate each busy session with its nonterminal receipts
    // so the record can tell a cut-off turn from one that finished in-window.
    const runIdsBySession = new Map<string, string[]>();
    for (const r of runs) {
      const list = runIdsBySession.get(r.sessionId) ?? [];
      list.push(r.runId);
      runIdsBySession.set(r.sessionId, list);
    }
    this.remaining = {
      activeTurns: Math.max(0, active - quarantined),
      quarantinedTurns: quarantined,
      nonterminalRuns: runs.length,
      runs: runs.map((r) => ({ runId: r.runId, sessionId: r.sessionId, runtime: r.runtime, status: r.status })),
      busySessions: busy.length,
      sessions: busy.map((s) => ({ sessionId: s.sessionId, runtime: s.runtime, busyReason: s.busyReason, runIds: runIdsBySession.get(s.sessionId) ?? [] })),
    };
  }

  /**
   * Correction 02: the outcome decision ALWAYS awaits the busy refresh first
   * (bounded): a decision on a snapshot that lags a pending refresh could
   * settle (or cut off) without a busy session that is only discoverable
   * after the refresh. Re-entrancy is guarded; state is re-checked after the
   * await so a cancel during a slow refresh cannot settle late.
   */
  private async evaluate(): Promise<void> {
    if (this.state !== 'draining' || this.startedAtMs === undefined || this.evaluating) return;
    this.evaluating = true;
    try {
      await this.refreshBusyBeforeDecision();
      if (this.state !== 'draining' || this.startedAtMs === undefined) return;
      this.measure();
      if (this.remaining.activeTurns === 0 && this.remaining.nonterminalRuns === 0 && this.remaining.busySessions === 0 && this.lastBusyRefreshFresh) {
        this.finish('settled');
        return;
      }
      if (this.now() - this.startedAtMs >= (this.timeoutMs ?? 0)) {
        this.cutOffRunIds = this.remaining.runs.map((r) => r.runId);
        this.cutOffSessionIds = this.remaining.sessions.map((s) => s.sessionId);
        this.finish('timed_out');
      }
    } finally {
      this.evaluating = false;
    }
  }

  /** Await the busy refresh, bounded; an unavailable refresh marks the snapshot unknown. */
  private async refreshBusyBeforeDecision(): Promise<void> {
    const refresh = this.refreshBusySessions;
    if (!refresh) {
      this.lastBusyRefreshFresh = true;
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`busy refresh exceeded ${this.busyRefreshTimeoutMs}ms`)), this.busyRefreshTimeoutMs);
        timer.unref?.();
        refresh().then(
          () => { clearTimeout(timer); resolve(); },
          (error: unknown) => { clearTimeout(timer); reject(error); },
        );
      });
      this.lastBusyRefreshFresh = true;
    } catch (error) {
      // UNKNOWN ≠ empty: never settle on an unavailable snapshot; a timeout
      // still finishes (bounded) and the record says the snapshot was not fresh.
      this.lastBusyRefreshFresh = false;
      logger.warn(`[InternalAPI] drain busy refresh unavailable before decision: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private finish(state: 'settled' | 'timed_out'): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.state = state;
    this.finishedAtMs = this.now();
    this.holdUntilMs = this.finishedAtMs + (this.holdMs ?? this.defaultHoldMs);
    this.writeRecord(state);
    logger.info(`[InternalAPI] drain ${state}: waitedMs=${this.finishedAtMs - (this.startedAtMs ?? this.finishedAtMs)} completedDuringDrain=${this.completedCount()} cutOff=${this.cutOffRunIds.length} cutOffSessions=${this.cutOffSessionIds.length} activeTurns=${this.remaining.activeTurns} nonterminalRuns=${this.remaining.nonterminalRuns} busySessions=${this.remaining.busySessions} busyRefresh=${state === 'settled' ? 'fresh' : (this.lastBusyRefreshFresh ? 'fresh' : 'unavailable')}`);
    this.holdTimer = setTimeout(() => { void this.cancel('hold_expired'); }, this.holdUntilMs - this.finishedAtMs);
    this.holdTimer.unref?.();
    this.flushWaiters(this.status());
    if (state === 'timed_out' && this.onTimedOut) {
      try {
        this.onTimedOut({ runIds: [...this.cutOffRunIds], sessionIds: [...this.cutOffSessionIds] });
      } catch { /* best-effort: the sweep re-runs at boot */ }
    }
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
      version: 2,
      state,
      reason: this.reason ?? '',
      startedAt: new Date(this.startedAtMs ?? this.now()).toISOString(),
      finishedAt: new Date(this.finishedAtMs ?? this.now()).toISOString(),
      cutOffRunIds: [...this.cutOffRunIds],
      cutOffSessions: this.remaining.sessions.map((s) => ({ sessionId: s.sessionId, runtime: s.runtime, busyReason: s.busyReason, runIds: [...(s.runIds ?? [])] })),
      busyRefresh: state === 'settled' ? 'fresh' : (this.lastBusyRefreshFresh ? 'fresh' : 'unavailable'),
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

/** Read a drain record; undefined when absent or malformed. Unsafe run ids are dropped. Accepts v1 (pre-1.52.0) and v2. */
export function readDrainRecord(recordPath: string): DrainRecord | undefined {
  try {
    if (!existsSync(recordPath)) return undefined;
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as { version?: number; state?: unknown; reason?: unknown; startedAt?: unknown; finishedAt?: unknown; cutOffRunIds?: unknown; cutOffSessions?: unknown; busyRefresh?: unknown };
    if (!raw || (raw.version !== 1 && raw.version !== 2) || (raw.state !== 'settled' && raw.state !== 'timed_out')) return undefined;
    const state = raw.state as 'settled' | 'timed_out';
    return {
      version: 2,
      state,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
      cutOffRunIds: Array.isArray(raw.cutOffRunIds)
        ? raw.cutOffRunIds.filter((id): id is string => typeof id === 'string' && SAFE_RUN_ID.test(id))
        : [],
      cutOffSessions: Array.isArray(raw.cutOffSessions)
        ? raw.cutOffSessions
          .filter((s): s is DrainBusySession => Boolean(s) && typeof s === 'object' && !Array.isArray(s)
            && typeof (s as DrainBusySession).sessionId === 'string' && SAFE_RUN_ID.test((s as DrainBusySession).sessionId)
            && typeof (s as DrainBusySession).runtime === 'string'
            && typeof (s as DrainBusySession).busyReason === 'string')
          .map((s) => ({
            sessionId: s.sessionId,
            runtime: s.runtime.slice(0, 32),
            busyReason: s.busyReason.slice(0, 64),
            // Correction 01: the session↔run association survives the record
            // (safe ids only) so boot can suppress false interruptions.
            runIds: Array.isArray((s as { runIds?: unknown }).runIds)
              ? ((s as { runIds: unknown[] }).runIds.filter((id): id is string => typeof id === 'string' && SAFE_RUN_ID.test(id)))
              : [],
          }))
        : [],
      // Correction 02: absent on pre-correction v2 records — informational only.
      busyRefresh: raw.busyRefresh === 'unavailable' ? 'unavailable' : 'fresh',
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

/** What boot hands the WatchManager for one receipt-less cut-off busy session. */
export interface InterruptedBusySessionRef {
  sessionId: string;
  runtime: string;
  /** Synthetic interruption reference (`busy-<sessionId>`); no receipt exists. */
  runId: string;
  errorCode: string;
  interruptionReason: string;
}

const NONTERMINAL_RECEIPT_STATUSES = new Set(['accepted', 'queued', 'started']);

/**
 * Correction 01 (finding 3): compose the boot busy-session reconciliation list
 * from the previous process's drain record, WITHOUT false interruptions for
 * work that finished normally inside the hold window.
 *
 * A cut-off session is skipped when
 *  - its runs were receipt-backed and recovered as interrupted (the receipt
 *    path fires — never double-fire), or
 *  - EVERY receipt associated with it at the timeout reached a terminal state
 *    (completed/failed/cancelled): the work finished before the kill, and its
 *    real completion already fired watches. Only when some associated run has
 *    no known terminal outcome (typically a receipt-less extension turn) does
 *    the synthetic `busy-<sessionId>` reference fire.
 */
export function composeInterruptedBusySessions(
  record: DrainRecord | undefined,
  recoveredRunSessionIds: ReadonlySet<string>,
  receiptStatus?: (runId: string) => string | undefined,
): InterruptedBusySessionRef[] {
  if (!record || record.state !== 'timed_out') return [];
  const out: InterruptedBusySessionRef[] = [];
  for (const session of record.cutOffSessions) {
    if (recoveredRunSessionIds.has(session.sessionId)) continue;
    // An UNKNOWN receipt outcome (recorded runId, status unreadable) is not
    // finished work: the conservative reading is that it was cut off.
    const allFinished = (session.runIds ?? []).length > 0
      && (session.runIds ?? []).every((runId) => {
        const status = receiptStatus?.(runId);
        return typeof status === 'string' && !NONTERMINAL_RECEIPT_STATUSES.has(status);
      });
    if (allFinished) continue;
    out.push({
      sessionId: session.sessionId,
      runtime: session.runtime,
      runId: `busy-${session.sessionId}`,
      errorCode: 'SERVER_RESTART',
      interruptionReason: 'drain_timeout',
    });
  }
  return out;
}

/** Sources the shared busy-session snapshot reads from (see `createBusySessionSource`). */
export interface BusySessionSources {
  /** The cross-runtime registry's full entry list (async source of truth for non-Pi runtimes). */
  listRegistryEntries: () => Promise<Array<{ id: string; sdkType: string }>>;
  /** A runtime's EXISTING busy flag, read-only. A throw is not busy evidence. */
  isRuntimeRunning: (sdkType: string, sessionId: string) => boolean;
  /** Pi resident busy accessor (sync, always live — never snapshotted). */
  listPiBusySessions: () => DrainBusySession[];
  /** Warning sink; defaults to the Internal API drain logger. */
  onWarn?: (message: string) => void;
}

export interface BusySessionSource {
  /** Sync, payload-free busy list: Pi live + non-Pi from the last snapshot. */
  listBusySessions: () => DrainBusySession[];
  /**
   * Shared in-flight registry refresh. Concurrent callers await ONE promise
   * (no early return against a stale snapshot); a caller after it settled
   * starts a fresh fetch. A failed refresh keeps the previous snapshot.
   */
  refresh: () => Promise<void>;
}

/**
 * Correction 01 (finding 2): the non-Pi busy list must stay current. The
 * pre-correction wiring snapshotted the registry at boot and before a drain
 * start and returned early while a refresh was in flight, so a concurrent
 * caller could measure against a stale or empty snapshot. This source makes
 * `refresh()` share one in-flight promise; callers kick it on every drain
 * measurement and await it before a drain starts.
 */
export function createBusySessionSource(sources: BusySessionSources): BusySessionSource {
  let snapshot: Array<{ id: string; sdkType: string }> = [];
  let inFlight: Promise<void> | undefined;
  const warn = sources.onWarn ?? ((message: string) => logger.warn(`[InternalAPI] ${message}`));
  const refresh = (): Promise<void> => {
    if (!inFlight) {
      inFlight = sources.listRegistryEntries()
        .then((entries) => { snapshot = entries; })
        .catch((error) => {
          warn(`drain busy-session registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => { inFlight = undefined; });
    }
    return inFlight;
  };
  return {
    refresh,
    listBusySessions: () => {
      const busy: DrainBusySession[] = [];
      try {
        for (const session of sources.listPiBusySessions()) {
          busy.push({ sessionId: session.sessionId, runtime: session.runtime, busyReason: session.busyReason });
        }
      } catch (error) {
        warn(`drain Pi busy accessor failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const entry of snapshot) {
        try {
          if (sources.isRuntimeRunning(entry.sdkType, entry.id)) {
            busy.push({ sessionId: entry.id, runtime: entry.sdkType, busyReason: 'runtime-running' });
          }
        } catch {
          /* a lookup failure is not busy evidence */
        }
      }
      return busy;
    },
  };
}
