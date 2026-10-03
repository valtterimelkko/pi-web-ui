/**
 * Wave K (contract 1.59.0) — interruption sweep (K2) and live-stop handler (R6).
 *
 * Finds Pi goal children whose goal was cut off by a transient stop and
 * continues each one ONCE, without any parent action, through the normal
 * prompt seam (shared admission). Everything that does not auto-continue is
 * made visible at once as a `goal_state` projection with
 * `status: "paused"`, `pausedReason: "interrupted"` + the additive
 * `interruption` object (R4) — a goal never again sits `running` and idle in
 * silence.
 *
 * Scope (R1, binding): only Internal-API goal children — registry origin
 * `internal-api` (or a `parentSource`, which marks a parent-dispatched child),
 * whose last activity falls inside the previous server lifetime (bounded at
 * 6 h before boot) or that the prior drain/receipts announced, running Pi,
 * and not busy right now. Browser- and CLI-origin sessions keep today's
 * behaviour exactly.
 *
 * Window (R2, binding): no fixed candidate cap — every in-scope candidate is
 * processed at concurrency 2; a 429/503 with Retry-After is honoured and
 * retried inside a 10-minute sweep window; a candidate still not continued
 * gets the visible interruption.
 */
import { classifyGoalStop, type GoalInterruptionCause, type InterruptionSource, type TransientCause } from './transient-cause.js';
import { goalFingerprint, type ContinueMarkerStore } from './continue-marker.js';
import type { InterruptionOverlayRecord, InterruptionOverlayStore, GoalFileIdentity } from './interruption-overlay.js';
import { findInFlightToolCall, buildContinueNote } from './continue-note.js';
import type { SessionGoalProjection } from './types.js';

export interface SweepCandidate {
  sessionId: string;
  sessionPath: string;
  runtime: string;
  origin?: 'browser' | 'internal-api' | 'native-discovered';
  parentSource?: string;
  /** Session last-activity instant (epoch ms); the session file's mtime. */
  lastActivityMs?: number;
  /** Present when the prior drain or recovered receipts announced this session's cut-off. */
  announced?: { source: 'receipt' | 'drain'; interruptionReason: string };
}

export interface SweepDispatchResult {
  ok: boolean;
  retryAfterSeconds?: number;
  reason?: string;
}

export interface SweepReport {
  continued: string[];
  interruptedVisible: string[];
  skipped: string[];
}

export interface InterruptionSweepDeps {
  isSessionBusy(sessionId: string): boolean | Promise<boolean>;
  /** Disk truth for classification — the RAW projection, without any overlay. */
  readRawProjection(sessionPath: string): Promise<SessionGoalProjection>;
  readTranscriptLines(sessionPath: string): Promise<string[]>;
  dispatchContinue(sessionId: string, message: string): Promise<SweepDispatchResult>;
  publishGoalState(sessionId: string, projection: SessionGoalProjection): void;
  markerStore: ContinueMarkerStore;
  overlayStore: InterruptionOverlayStore;
  readGoalFileIdentity(sessionPath: string): Promise<GoalFileIdentity | null>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  concurrency?: number;
  windowMs?: number;
  restartBoundMs?: number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_RESTART_BOUND_MS = 6 * 3_600_000;

/** R1(a): sessions created through the Internal API — registry origin or a parent-dispatch source. */
export function isApiOriginChild(candidate: Pick<SweepCandidate, 'origin' | 'parentSource'>): boolean {
  return candidate.origin === 'internal-api' || candidate.parentSource !== undefined;
}

/** R1(b): last activity inside the previous server lifetime, bounded at 6 h before the restart. */
export function withinPreviousLifetime(candidate: Pick<SweepCandidate, 'lastActivityMs'>, bootTimeMs: number, boundMs = DEFAULT_RESTART_BOUND_MS): boolean {
  if (candidate.lastActivityMs === undefined || !Number.isFinite(candidate.lastActivityMs)) return false;
  return candidate.lastActivityMs <= bootTimeMs && (bootTimeMs - candidate.lastActivityMs) <= boundMs;
}

const CAUSE_LABELS: Record<TransientCause, string> = {
  restart_interruption: 'a server restart cut your run off',
  rehydrate_pause: 'your run was interrupted by a server restart and your goal was restored paused',
  provider_abort: 'the model provider aborted your run (overloaded or unreachable)',
};

/** Compose the continue command: a single-line, quote-free note inside `/goal resume "<note>"`. */
export function composeContinueCommand(note: string): string {
  return `/goal resume "${note}"`;
}

function extractLastErrorMessage(projection: SessionGoalProjection): string | null {
  const state = projection.runtimeState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const message = (state as Record<string, unknown>).lastErrorMessage;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}

interface ClassifiedStop {
  transient: true;
  cause: TransientCause;
  source: InterruptionSource;
}

/**
 * Classify one candidate from its announcement and raw disk projection.
 * Returns null when there is nothing to act on (terminal goals, deliberate
 * pauses, real errors without provider evidence).
 */
async function classifyCandidate(candidate: SweepCandidate, deps: InterruptionSweepDeps): Promise<{ stop: ClassifiedStop | null; projection: SessionGoalProjection }> {
  const projection = await deps.readRawProjection(candidate.sessionPath);
  if (candidate.announced) {
    const verdict = classifyGoalStop({ source: candidate.announced.source, interruptionReason: candidate.announced.interruptionReason });
    if (verdict.transient) return { stop: { transient: true, cause: verdict.cause, source: candidate.announced.source }, projection };
    return { stop: null, projection };
  }
  if (projection.status === 'running' || projection.status === 'wrapping_up') {
    return { stop: { transient: true, cause: 'restart_interruption', source: 'boot_orphan' }, projection };
  }
  if (projection.status === 'paused' && projection.pausedReason === 'restored_on_session_start') {
    const verdict = classifyGoalStop({ source: 'rehydrate_pause', pauseReason: 'restored_on_session_start', inRestartScope: true });
    if (verdict.transient) return { stop: { transient: true, cause: 'rehydrate_pause', source: 'rehydrate_pause' }, projection };
    return { stop: null, projection };
  }
  if (projection.status === 'failed' || projection.status === 'paused') {
    const verdict = classifyGoalStop({ source: 'provider_abort', status: projection.status === 'failed' ? 'failed' : 'paused', lastErrorMessage: extractLastErrorMessage(projection) });
    if (verdict.transient) return { stop: { transient: true, cause: 'provider_abort', source: 'provider_abort' }, projection };
  }
  return { stop: null, projection };
}

function interruptedProjection(projection: SessionGoalProjection, interruption: SessionGoalProjection['interruption'] & object): SessionGoalProjection {
  return { ...projection, status: 'paused', pausedReason: 'interrupted', interruption };
}

function autoContinuedProjection(projection: SessionGoalProjection, interruption: NonNullable<SessionGoalProjection['interruption']>): SessionGoalProjection {
  return { ...projection, interruption: { ...interruption, autoContinued: true } };
}

export function createInterruptionSweep(deps: InterruptionSweepDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;

  /** Continue once, with marker reserve/commit/rollback and the R2 retry window. */
  async function continueOnce(candidate: SweepCandidate, stop: ClassifiedStop, projection: SessionGoalProjection, report: SweepReport): Promise<void> {
    const fingerprint = goalFingerprint(projection.objective, projection.startedAt);
    const existing = await deps.markerStore.get(candidate.sessionId, fingerprint);
    if (existing && existing.count >= 1) {
      // Second transient stop: fail honestly, visibly (brief K2 / R4).
      const interruption = { cause: 'second_transient' as GoalInterruptionCause, source: stop.source, detectedAt: now(), continueCount: existing.count };
      const overlayRecord: InterruptionOverlayRecord = {
        sessionId: candidate.sessionPath,
        fingerprint,
        cause: 'second_transient',
        source: stop.source,
        detectedAt: interruption.detectedAt,
        continueCount: existing.count,
        goalFile: (await deps.readGoalFileIdentity(candidate.sessionPath)) ?? { mtimeMs: 0, size: 0 },
      };
      await deps.overlayStore.set(overlayRecord);
      deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, interruption));
      report.interruptedVisible.push(candidate.sessionId);
      return;
    }

    const transcriptLines = await deps.readTranscriptLines(candidate.sessionPath);
    const inFlightToolCall = findInFlightToolCall(transcriptLines);
    const note = buildContinueNote({ causeLabel: CAUSE_LABELS[stop.cause], inFlightToolCall });
    await deps.markerStore.reserve(candidate.sessionId, fingerprint, stop.cause, stop.source);

    const deadline = now() + windowMs;
    let result = await deps.dispatchContinue(candidate.sessionId, composeContinueCommand(note));
    while (!result.ok && result.retryAfterSeconds !== undefined && result.retryAfterSeconds > 0) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(result.retryAfterSeconds * 1000, remaining));
      result = await deps.dispatchContinue(candidate.sessionId, composeContinueCommand(note));
    }

    if (result.ok) {
      await deps.markerStore.commit(candidate.sessionId, fingerprint);
      const identity = await deps.readGoalFileIdentity(candidate.sessionPath);
      if (identity) {
        const overlayRecord: InterruptionOverlayRecord = {
          sessionId: candidate.sessionPath,
          fingerprint,
          cause: stop.cause,
          source: stop.source,
          detectedAt: now(),
          continueCount: 1,
          continueNote: note,
          inFlightToolCall,
          goalFile: identity,
        };
        await deps.overlayStore.set(overlayRecord);
      }
      deps.publishGoalState(candidate.sessionId, autoContinuedProjection(projection, {
        cause: stop.cause,
        source: stop.source,
        detectedAt: now(),
        continueCount: 1,
        continueNote: note,
        inFlightToolCall: inFlightToolCall ?? null,
      }));
      report.continued.push(candidate.sessionId);
      return;
    }

    // Refused beyond the window: the once is NOT consumed; the stop is visible.
    await deps.markerStore.rollback(candidate.sessionId, fingerprint);
    const interruption = { cause: 'continue_failed' as GoalInterruptionCause, source: stop.source, detectedAt: now(), continueCount: 0 };
    const overlayRecord: InterruptionOverlayRecord = {
      sessionId: candidate.sessionPath,
      fingerprint,
      cause: 'continue_failed',
      source: stop.source,
      detectedAt: interruption.detectedAt,
      continueCount: 0,
      goalFile: (await deps.readGoalFileIdentity(candidate.sessionPath)) ?? { mtimeMs: 0, size: 0 },
    };
    await deps.overlayStore.set(overlayRecord);
    deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, interruption));
    report.interruptedVisible.push(candidate.sessionId);
  }

  async function handleCandidate(candidate: SweepCandidate, bootTimeMs: number, report: SweepReport): Promise<void> {
    if (!isApiOriginChild(candidate)) { report.skipped.push(candidate.sessionId); return; }
    if (!candidate.announced && !withinPreviousLifetime(candidate, bootTimeMs, deps.restartBoundMs ?? DEFAULT_RESTART_BOUND_MS)) {
      report.skipped.push(candidate.sessionId);
      return;
    }
    if (await deps.isSessionBusy(candidate.sessionId)) { report.skipped.push(candidate.sessionId); return; }

    if (candidate.runtime !== 'pi') {
      // Runtimes without a resume path this wave: visible interruption only.
      if (candidate.announced) {
        const verdict = classifyGoalStop({ source: candidate.announced.source, interruptionReason: candidate.announced.interruptionReason });
        if (verdict.transient) {
          deps.publishGoalState(candidate.sessionId, interruptedProjection(
            { supported: false, status: 'unknown' },
            { cause: 'unsupported_runtime', source: candidate.announced.source, detectedAt: now(), continueCount: 0 },
          ));
          report.interruptedVisible.push(candidate.sessionId);
          return;
        }
      }
      report.skipped.push(candidate.sessionId);
      return;
    }

    const { stop, projection } = await classifyCandidate(candidate, deps);
    if (!stop) { report.skipped.push(candidate.sessionId); return; }
    await continueOnce(candidate, stop, projection, report);
  }

  return {
    /** Boot / drain-timeout sweep. `candidates` come from the server wiring. */
    async run(candidates: SweepCandidate[], bootTimeMs: number): Promise<SweepReport> {
      const report: SweepReport = { continued: [], interruptedVisible: [], skipped: [] };
      // Dedupe by sessionId (a session can appear in both receipt and drain sets).
      const unique = new Map<string, SweepCandidate>();
      for (const candidate of candidates) {
        const existing = unique.get(candidate.sessionId);
        unique.set(candidate.sessionId, existing?.announced ? candidate : (existing ?? candidate));
      }
      let index = 0;
      const list = [...unique.values()];
      const worker = async (): Promise<void> => {
        while (index < list.length) {
          const candidate = list[index++];
          try {
            await handleCandidate(candidate, bootTimeMs, report);
          } catch {
            report.skipped.push(candidate.sessionId);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      return report;
    },

    /**
     * R6: the live path. A Pi goal_state paused/failed event classified as a
     * provider abort continues once through the same marker/overlay/event
     * flow. Deliberate pauses and ambiguous aborts never continue here.
     */
    async handleLiveStop(sessionId: string, sessionPath: string, projection: SessionGoalProjection): Promise<void> {
      if (projection.status !== 'failed' && projection.status !== 'paused') return;
      const verdict = classifyGoalStop({ source: 'provider_abort', status: projection.status === 'failed' ? 'failed' : 'paused', lastErrorMessage: extractLastErrorMessage(projection) });
      if (!verdict.transient) return;
      const stop: ClassifiedStop = { transient: true, cause: 'provider_abort', source: 'provider_abort' };
      const report: SweepReport = { continued: [], interruptedVisible: [], skipped: [] };
      await continueOnce({ sessionId, sessionPath, runtime: 'pi' }, stop, projection, report);
    },
  };
}
