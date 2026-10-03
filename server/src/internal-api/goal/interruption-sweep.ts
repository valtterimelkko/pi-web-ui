/**
 * Wave K (contract 1.59.0; correction 02) — interruption sweep (K2) and live
 * stop handler (R6/F4).
 *
 * Guiding principle (correction 02): the goal's own recorded intent always
 * wins over restart or provider evidence. When in doubt, do not continue —
 * make the stop visible instead.
 *
 * F1 exactly-once: an exclusive claim (per sessionId + goal fingerprint) is
 * taken before any dispatch; an in-process single-flight keeps overlapping
 * sweeps and the live path from racing; the loopback prompt carries an
 * idempotency key derived from the claim; ambiguous delivery (accepted, timed
 * out, unknown) is CONSUMED (committed, never rolled back); a definite refusal
 * releases the claim and retries inside the R2 window; after the window the
 * stop is made visible.
 *
 * F2 explicit intent: only three states may continue — an orphan goal
 * (running/wrapping_up on disk, no live turn), a restore pause
 * (restored_on_session_start), and a typed, fresh provider stop (live path,
 * F4). Every other pause (explicit pause/pause-now, question, budget/turn
 * limit, governor, environment fault) is never continued and never marked —
 * even when a receipt or drain announced the session.
 *
 * F5: non-Pi candidates read the runtime's real projection (via the injected
 * reader); a silently active goal gets the visible interruption with the
 * runtime's own supported flag; terminal or explicitly paused goals get
 * nothing.
 *
 * F6: markers are keyed to the goal fingerprint; other-goal markers are
 * pruned; second-transient detection reads only the current goal's marker.
 *
 * F7: the auto-continue event is published only with a VERIFIED post-dispatch
 * projection (status running). Unverified accepts count as consumed and make
 * the stop visible (cause continue_failed) — never a claimed auto-continue.
 */
import { classifyGoalStop, type InterruptionSource, type TransientCause } from './transient-cause.js';
import { goalFingerprint, type ContinueMarkerStore } from './continue-marker.js';
import type { InterruptionOverlayRecord, InterruptionOverlayStore, GoalFileIdentity } from './interruption-overlay.js';
import { findInFlightToolCall, buildContinueNote, type InFlightToolCall } from './continue-note.js';
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
  /** accepted: the pipeline took the prompt; refused: a definite pre-acceptance refusal; unknown: no verdict. */
  outcome: 'accepted' | 'refused' | 'unknown';
  retryAfterSeconds?: number;
  reason?: string;
}

export interface SweepReport {
  continued: string[];
  interruptedVisible: string[];
  skipped: string[];
  /** Why each skipped candidate was skipped (diagnostics; id -> reason). */
  skipReasons: Record<string, string>;
}

export interface InterruptionSweepDeps {
  isSessionBusy(sessionId: string): boolean | Promise<boolean>;
  /** Disk truth for classification — the RAW projection, without any overlay. */
  readRawProjection(sessionPath: string): Promise<SessionGoalProjection>;
  readTranscriptLines(sessionPath: string): Promise<string[]>;
  dispatchContinue(sessionId: string, message: string, idempotencyKey: string): Promise<SweepDispatchResult>;
  publishGoalState(sessionId: string, projection: SessionGoalProjection): void;
  markerStore: ContinueMarkerStore;
  overlayStore: InterruptionOverlayStore;
  readGoalFileIdentity(sessionPath: string): Promise<GoalFileIdentity | null>;
  /** F5: another runtime's real goal projection (loopback GET /goal). */
  readRuntimeProjection?(sessionId: string, runtime: string): Promise<SessionGoalProjection | null>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  concurrency?: number;
  windowMs?: number;
  restartBoundMs?: number;
  /** F7: how long a verified-running poll may wait after an accepted dispatch. */
  verifyMs?: number;
  verifyIntervalMs?: number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_RESTART_BOUND_MS = 6 * 3_600_000;
const DEFAULT_VERIFY_MS = 90_000;
const DEFAULT_VERIFY_INTERVAL_MS = 2_000;

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
 * Classify one candidate from its announcement and raw disk projection (F2):
 * only an orphan goal, a restore pause, or an announced cut-off of a goal that
 * was live at the cut-off may continue. Terminal, explicitly paused, limited
 * and errored goals are never continued here — the provider abort is the LIVE
 * path's typed evidence (F4), never stale disk text.
 */
async function classifyCandidate(candidate: SweepCandidate, deps: InterruptionSweepDeps): Promise<{ stop: ClassifiedStop | null; projection: SessionGoalProjection }> {
  const projection = await deps.readRawProjection(candidate.sessionPath);
  if (projection.status === 'achieved' || projection.status === 'cleared' || projection.status === 'idle') {
    return { stop: null, projection };
  }
  if (projection.status === 'running' || projection.status === 'wrapping_up') {
    return { stop: { transient: true, cause: 'restart_interruption', source: candidate.announced?.source ?? 'boot_orphan' }, projection };
  }
  if (projection.status === 'paused' && projection.pausedReason === 'restored_on_session_start') {
    return { stop: { transient: true, cause: 'rehydrate_pause', source: 'rehydrate_pause' }, projection };
  }
  return { stop: null, projection };
}

function interruptedProjection(projection: SessionGoalProjection, interruption: NonNullable<SessionGoalProjection['interruption']>): SessionGoalProjection {
  return { ...projection, status: 'paused', pausedReason: 'interrupted', interruption: { ...interruption, autoContinued: false } };
}

export function createInterruptionSweep(deps: InterruptionSweepDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const verifyMs = deps.verifyMs ?? DEFAULT_VERIFY_MS;
  const verifyIntervalMs = deps.verifyIntervalMs ?? DEFAULT_VERIFY_INTERVAL_MS;

  /** F1: one continue decision at a time per session (sweep + live path). */
  const inFlight = new Map<string, Promise<{ dispatched: boolean; verified: boolean }>>();

  function continueOnce(candidate: SweepCandidate, stop: ClassifiedStop, projection: SessionGoalProjection, report: SweepReport): Promise<{ dispatched: boolean; verified: boolean }> {
    const existing = inFlight.get(candidate.sessionId);
    if (existing) return existing;
    const task = continueOnceUncancelled(candidate, stop, projection, report).finally(() => {
      inFlight.delete(candidate.sessionId);
    });
    inFlight.set(candidate.sessionId, task);
    return task;
  }

  async function continueOnceUncancelled(candidate: SweepCandidate, stop: ClassifiedStop, projection: SessionGoalProjection, report: SweepReport): Promise<{ dispatched: boolean; verified: boolean }> {
    const fingerprint = goalFingerprint(projection.objective, projection.startedAt);
    // F6: markers of other goals on this session are stale history — prune.
    await deps.markerStore.pruneOtherFingerprints(candidate.sessionId, fingerprint);
    const current = await deps.markerStore.get(candidate.sessionId, fingerprint);
    if (current && current.count >= 1) {
      // Second transient stop on the SAME goal: fail honestly, visibly (brief K2 / R4).
      const interruption = { cause: 'second_transient' as const, source: stop.source, detectedAt: now(), continueCount: current.count };
      await writeOverlay(candidate, fingerprint, 'second_transient', stop.source, { continueCount: current.count, autoContinued: false });
      deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, interruption));
      report.interruptedVisible.push(candidate.sessionId);
      return { dispatched: false, verified: false };
    }

    // F1: exclusive claim. A fresh held claim = another dispatch in flight.
    const claim = await deps.markerStore.claim(candidate.sessionId, fingerprint, stop.cause, stop.source);
    if (!claim.claimed) {
      report.skipped.push(candidate.sessionId);
      report.skipReasons[candidate.sessionId] = `a ${claim.existing.count >= 1 ? 'committed' : 'fresh'} marker already holds this goal's continue`;
      return { dispatched: false, verified: false };
    }

    const transcriptLines = await deps.readTranscriptLines(candidate.sessionPath);
    const inFlightToolCall = findInFlightToolCall(transcriptLines);
    const note = buildContinueNote({ causeLabel: CAUSE_LABELS[stop.cause], inFlightToolCall });
    const idempotencyKey = `goal-continue:${candidate.sessionId}:${fingerprint.slice(0, 12)}`;

    const deadline = now() + windowMs;
    let result = await deps.dispatchContinue(candidate.sessionId, composeContinueCommand(note), idempotencyKey);
    while (result.outcome === 'refused') {
      const remaining = deadline - now();
      if (result.retryAfterSeconds === undefined || result.retryAfterSeconds <= 0 || remaining <= 0) break;
      await sleep(Math.min(result.retryAfterSeconds * 1000, remaining));
      result = await deps.dispatchContinue(candidate.sessionId, composeContinueCommand(note), idempotencyKey);
    }

    if (result.outcome === 'refused') {
      // Definite pre-acceptance refusal: the once is NOT consumed; release the
      // claim and make the stop visible (R2). A later sweep may try again.
      await deps.markerStore.release(candidate.sessionId, fingerprint);
      await writeOverlay(candidate, fingerprint, 'continue_failed', stop.source, { continueCount: 0, autoContinued: false });
      deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, {
        cause: 'continue_failed', source: stop.source, detectedAt: now(), continueCount: 0,
      }));
      report.interruptedVisible.push(candidate.sessionId);
      return { dispatched: false, verified: false };
    }

    // Accepted or ambiguous: the once is CONSUMED — never rolled back (F1).
    await deps.markerStore.commit(candidate.sessionId, fingerprint);

    if (result.outcome === 'unknown') {
      // No verdict: do not claim an auto-continue. Make the stop visible; if
      // the resume did land, the engine's own write clears the overlay.
      await writeOverlay(candidate, fingerprint, 'continue_failed', stop.source, { continueCount: 1, autoContinued: false, continueNote: note, inFlightToolCall });
      deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, {
        cause: 'continue_failed', source: stop.source, detectedAt: now(), continueCount: 1, continueNote: note,
      }));
      report.interruptedVisible.push(candidate.sessionId);
      return { dispatched: false, verified: false };
    }

    // F7: publish the truthful event only when the resume verified (status
    // running). The restore path flips the file to paused and the resume back
    // to running, so the poll reads the post-dispatch truth.
    const verifyDeadline = now() + verifyMs;
    let verified = false;
    let verifiedProjection = projection;
    while (now() < verifyDeadline) {
      await sleep(verifyIntervalMs);
      const latest = await deps.readRawProjection(candidate.sessionPath);
      if (latest.status === 'running') {
        verified = true;
        verifiedProjection = latest;
        break;
      }
    }
    if (!verified) {
      await writeOverlay(candidate, fingerprint, 'continue_failed', stop.source, { continueCount: 1, autoContinued: false, continueNote: note, inFlightToolCall });
      deps.publishGoalState(candidate.sessionId, interruptedProjection(verifiedProjection, {
        cause: 'continue_failed', source: stop.source, detectedAt: now(), continueCount: 1, continueNote: note,
      }));
      report.interruptedVisible.push(candidate.sessionId);
      return { dispatched: true, verified: false };
    }

    const identity = await deps.readGoalFileIdentity(candidate.sessionPath);
    if (identity) {
      await deps.overlayStore.set({
        sessionId: candidate.sessionPath,
        fingerprint,
        cause: stop.cause,
        source: stop.source,
        detectedAt: now(),
        continueCount: 1,
        autoContinued: true,
        continueNote: note,
        inFlightToolCall,
        goalFile: identity,
      });
    }
    deps.publishGoalState(candidate.sessionId, {
      ...verifiedProjection,
      interruption: {
        cause: stop.cause,
        source: stop.source,
        detectedAt: now(),
        continueCount: 1,
        autoContinued: true,
        continueNote: note,
        inFlightToolCall: inFlightToolCall ?? null,
      },
    });
    report.continued.push(candidate.sessionId);
    return { dispatched: true, verified: true };
  }

  async function writeOverlay(candidate: SweepCandidate, fingerprint: string, cause: InterruptionOverlayRecord['cause'], source: InterruptionSource, fields: { continueCount: number; autoContinued: boolean; continueNote?: string; inFlightToolCall?: InFlightToolCall | null }): Promise<void> {
    const identity = await deps.readGoalFileIdentity(candidate.sessionPath);
    if (!identity) return; // without a stable identity the overlay cannot survive safely
    const record: InterruptionOverlayRecord = {
      sessionId: candidate.sessionPath,
      fingerprint,
      cause,
      source,
      detectedAt: now(),
      ...fields,
      goalFile: identity,
    };
    await deps.overlayStore.set(record);
  }

  async function handleCandidate(candidate: SweepCandidate, bootTimeMs: number, report: SweepReport): Promise<void> {
    const skip = (reason: string): void => {
      report.skipped.push(candidate.sessionId);
      report.skipReasons[candidate.sessionId] = reason;
    };
    if (!isApiOriginChild(candidate)) { skip(`origin '${candidate.origin ?? 'none'}' is not an API child`); return; }
    if (!candidate.announced && !withinPreviousLifetime(candidate, bootTimeMs, deps.restartBoundMs ?? DEFAULT_RESTART_BOUND_MS)) {
      skip(`last activity ${candidate.lastActivityMs ?? 'unknown'} outside the previous lifetime bound`);
      return;
    }
    if (await deps.isSessionBusy(candidate.sessionId)) { skip('session is live (busy)'); return; }

    if (candidate.runtime !== 'pi') {
      // F5: read the runtime's real projection; only a silently ACTIVE goal is
      // made visible (with its own supported flag). Terminal or explicitly
      // paused goals get nothing (no change).
      const projection = await deps.readRuntimeProjection?.(candidate.sessionId, candidate.runtime);
      if (!projection || projection.status === 'achieved' || projection.status === 'cleared' || projection.status === 'idle' || projection.status === 'unknown' || projection.status === 'paused') {
        skip(`non-Pi goal state '${projection?.status ?? 'unknown'}' is not a silent active stop`);
        return;
      }
      deps.publishGoalState(candidate.sessionId, {
        ...projection,
        status: 'paused',
        pausedReason: 'interrupted',
        interruption: { cause: 'restart_interruption', source: candidate.announced?.source ?? 'boot_orphan', detectedAt: now(), continueCount: 0, autoContinued: false },
      });
      report.interruptedVisible.push(candidate.sessionId);
      return;
    }

    const { stop, projection } = await classifyCandidate(candidate, deps);
    if (!stop) {
      skip(`goal state '${projection.status}' is not a continueable stop (explicit intent or terminal — nothing silent)`);
      return;
    }
    await continueOnce(candidate, stop, projection, report);
  }

  return {
    /** Boot / drain-timeout sweep. `candidates` come from the server wiring. */
    async run(candidates: SweepCandidate[], bootTimeMs: number): Promise<SweepReport> {
      const report: SweepReport = { continued: [], interruptedVisible: [], skipped: [], skipReasons: {} };
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
          } catch (error) {
            report.skipped.push(candidate.sessionId);
            report.skipReasons[candidate.sessionId] = `error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      return report;
    },

    /**
     * R6/F4: the live path. A Pi paused/failed goal_state event is classified
     * here BEFORE the bridge emits terminal events; a positively
     * auto-continuable provider stop is continued once and the caller suppresses
     * the goal_end. Scope-gated like the boot sweep (F3): only API children,
     * only Pi.
     */
    async handleLiveStop(sessionId: string, sessionPath: string, projection: SessionGoalProjection, scope: { apiChild: boolean; runtime: string }): Promise<{ intercepted: boolean }> {
      if (!scope.apiChild || scope.runtime !== 'pi') return { intercepted: false };
      if (projection.status !== 'failed' && projection.status !== 'paused') return { intercepted: false };
      // The evidence is the stop itself: the projection read at the event
      // moment, with positive provider text. Anything else (explicit pause
      // reasons, bare aborts) is intent and never intercepted.
      const verdict = classifyGoalStop({ source: 'provider_abort', status: projection.status === 'failed' ? 'failed' : 'paused', lastErrorMessage: extractLastErrorMessage(projection) });
      if (!verdict.transient) return { intercepted: false };
      const stop: ClassifiedStop = { transient: true, cause: 'provider_abort', source: 'provider_abort' };
      const report: SweepReport = { continued: [], interruptedVisible: [], skipped: [], skipReasons: {} };
      const outcome = await continueOnce({ sessionId, sessionPath, runtime: 'pi' }, stop, projection, report);
      return { intercepted: outcome.dispatched && outcome.verified };
    },
  };
}
