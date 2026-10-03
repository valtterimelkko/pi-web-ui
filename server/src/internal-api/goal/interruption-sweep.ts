/**
 * Wave K (contract 1.60.0; correction 03 FINAL) — interruption sweep (K2).
 *
 * Guiding principle: the goal's recorded intent always wins. When in doubt,
 * do not continue — make the stop visible instead.
 *
 * Correction 03 scope cut: the live provider-abort path is REMOVED (no live
 * observers, no handleLiveStop, no bridge interception). Continueable states
 * are exactly two: an orphan goal (`running` on disk, no live turn) and a
 * restore pause (`restored_on_session_start`). A `wrapping-up` goal is NEVER
 * continued (`/goal pause` writes it while a run is busy — explicit intent).
 * Provider aborts end as before wave K; the K1 classifier keeps
 * `provider_abort` as a documented, non-continued cause.
 *
 * C1 exactly-once delivery: the loopback continue POSTs JSON
 * `{message, mode:'prompt', verbosity:'answers', detach:true, idempotencyKey}`;
 * 200/202 → accepted; 400/404/409 and 429/503-with-Retry-After → refused
 * (claim released, retried inside the R2 window); everything else → unknown →
 * CONSUMED. A count-0 claim or corrupt marker found later is never replayed:
 * consumed, and the stop is made visible.
 *
 * F2 explicit intent: every other pause (explicit pause/pause-now, question,
 * budget/turn limit, governor, environment fault) is never continued and never
 * marked — even when a receipt or drain announced the session.
 *
 * C3: non-Pi candidates read the runtime's real projection; only the BOOT
 * sweep makes a silently active non-Pi goal visible (with the runtime's own
 * supported flag); canonical-terminal or explicitly paused goals get nothing.
 *
 * F6/C4: markers are keyed to the goal fingerprint; other-goal markers are
 * pruned; R5 suppression requires a CONFIRMED continue (this boot, current
 * goal) — the wiring's probe enforces it.
 *
 * C5: verification is tied to the same goal — a pre-dispatch re-read must show
 * the same fingerprint and a still-continueable state (else the claim is
 * released and nothing is written); after acceptance, the same fingerprint
 * reading `running` verifies, the same fingerprint already terminal verifies
 * as a completed continue (no continue_failed, no overlay), and a different
 * fingerprint writes NO overlay and no event.
 *
 * F7/C6: the verified auto-continue event carries top-level
 * `autoContinued: true` (watch dataMatch is a shallow top-level match) plus
 * the nested `interruption` object, and is published only after verification.
 */
import { goalFingerprint, type ContinueMarkerStore } from './continue-marker.js';
import type { InterruptionSource } from './transient-cause.js';
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
  /** C3: another runtime's real goal projection (loopback GET /goal). */
  readRuntimeProjection?(sessionId: string, runtime: string): Promise<SessionGoalProjection | null>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  concurrency?: number;
  windowMs?: number;
  restartBoundMs?: number;
  /** C5: how long a verified-running poll may wait after an accepted dispatch. */
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

const CAUSE_LABELS: Record<string, string> = {
  restart_interruption: 'a server restart cut your run off',
  rehydrate_pause: 'your run was interrupted by a server restart and your goal was restored paused',
};

/** Compose the continue command: a single-line, quote-free note inside `/goal resume "<note>"`. */
export function composeContinueCommand(note: string): string {
  return `/goal resume "${note}"`;
}

interface ClassifiedStop {
  transient: true;
  cause: 'restart_interruption' | 'rehydrate_pause';
  source: 'receipt' | 'drain' | 'boot_orphan' | 'rehydrate_pause';
}

/**
 * Classify one candidate from its announcement and raw disk projection (F2):
 * only an orphan goal or a restore pause may continue. Terminal, explicitly
 * paused, limited and errored goals are never continued here.
 */
async function classifyCandidate(candidate: SweepCandidate, deps: InterruptionSweepDeps): Promise<{ stop: ClassifiedStop | null; projection: SessionGoalProjection }> {
  const projection = await deps.readRawProjection(candidate.sessionPath);
  if (projection.status === 'achieved' || projection.status === 'cleared' || projection.status === 'idle') {
    return { stop: null, projection };
  }
  // C2: `wrapping_up` is NEVER continueable — `/goal pause` writes it while a
  // run is busy, so it is explicit intent, not an orphan signal.
  if (projection.status === 'running') {
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

const NON_PI_TERMINAL = new Set(['achieved', 'cleared', 'failed', 'idle', 'unknown']);

export function createInterruptionSweep(deps: InterruptionSweepDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const verifyMs = deps.verifyMs ?? DEFAULT_VERIFY_MS;
  const verifyIntervalMs = deps.verifyIntervalMs ?? DEFAULT_VERIFY_INTERVAL_MS;

  /** C1: one continue decision at a time per session (overlapping sweeps). */
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

    // C1: exclusive claim. A found claim (count 0, any age) or a corrupt file
    // is CONSUMED, never replayed: make the stop visible instead.
    const claim = await deps.markerStore.claim(candidate.sessionId, fingerprint, stop.cause, stop.source);
    if (!claim.claimed) {
      await writeOverlay(candidate, fingerprint, 'continue_failed', stop.source, { continueCount: 1, autoContinued: false });
      deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, {
        cause: 'continue_failed', source: stop.source, detectedAt: now(), continueCount: 1,
      }));
      report.interruptedVisible.push(candidate.sessionId);
      report.skipReasons[candidate.sessionId] = 'a prior claim/marker for this goal exists: consumed, stop visible, no replay';
      return { dispatched: false, verified: false };
    }

    // C5: re-read immediately before dispatch — same fingerprint, still
    // continueable. Anything else: release the claim (nothing was dispatched)
    // and write nothing.
    const preDispatch = await deps.readRawProjection(candidate.sessionPath);
    const preFingerprint = goalFingerprint(preDispatch.objective, preDispatch.startedAt);
    const stillContinueable = preFingerprint === fingerprint
      && (preDispatch.status === 'running' || (preDispatch.status === 'paused' && preDispatch.pausedReason === 'restored_on_session_start'));
    if (!stillContinueable) {
      await deps.markerStore.release(candidate.sessionId, fingerprint);
      report.skipped.push(candidate.sessionId);
      report.skipReasons[candidate.sessionId] = `goal changed before dispatch (fingerprint ${preFingerprint === fingerprint ? 'same' : 'differs'}, status '${preDispatch.status}') — nothing written`;
      return { dispatched: false, verified: false };
    }

    const transcriptLines = await deps.readTranscriptLines(candidate.sessionPath);
    const inFlightToolCall = findInFlightToolCall(transcriptLines);
    const note = buildContinueNote({ causeLabel: CAUSE_LABELS[stop.cause] ?? 'your run was interrupted', inFlightToolCall });
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

    // C1: accepted or ambiguous — the once is CONSUMED, never rolled back.
    await deps.markerStore.commit(candidate.sessionId, fingerprint);

    if (result.outcome === 'unknown') {
      // No verdict: never claim an auto-continue. Make the stop visible; if
      // the resume did land, the engine's own write clears the overlay.
      await writeOverlay(candidate, fingerprint, 'continue_failed', stop.source, { continueCount: 1, autoContinued: false, continueNote: note, inFlightToolCall });
      deps.publishGoalState(candidate.sessionId, interruptedProjection(projection, {
        cause: 'continue_failed', source: stop.source, detectedAt: now(), continueCount: 1, continueNote: note,
      }));
      report.interruptedVisible.push(candidate.sessionId);
      return { dispatched: true, verified: false };
    }

    // C5: poll for the SAME fingerprint. `running` verifies; the same
    // fingerprint already terminal verifies as a completed continue (no
    // continue_failed, no overlay); a different fingerprint stops the poll —
    // no overlay, no event on the replacement goal.
    const verifyDeadline = now() + verifyMs;
    let verified = false;
    let completedContinue = false;
    let fingerprintChanged = false;
    let verifiedProjection = projection;
    while (now() < verifyDeadline) {
      await sleep(verifyIntervalMs);
      const latest = await deps.readRawProjection(candidate.sessionPath);
      const latestFingerprint = goalFingerprint(latest.objective, latest.startedAt);
      if (latestFingerprint !== fingerprint) {
        fingerprintChanged = true;
        break;
      }
      if (latest.status === 'running') {
        verified = true;
        verifiedProjection = latest;
        break;
      }
      if (latest.status === 'achieved' || latest.status === 'cleared' || latest.status === 'failed') {
        completedContinue = true;
        verified = true;
        verifiedProjection = latest;
        break;
      }
    }
    if (!verified) {
      if (!fingerprintChanged) {
        await writeOverlay(candidate, fingerprint, 'continue_failed', stop.source, { continueCount: 1, autoContinued: false, continueNote: note, inFlightToolCall });
        deps.publishGoalState(candidate.sessionId, interruptedProjection(verifiedProjection, {
          cause: 'continue_failed', source: stop.source, detectedAt: now(), continueCount: 1, continueNote: note,
        }));
        report.interruptedVisible.push(candidate.sessionId);
      }
      return { dispatched: true, verified: false };
    }

    // C4: only a verified continue is confirmed.
    await deps.markerStore.confirm(candidate.sessionId, fingerprint);

    if (completedContinue) {
      // A completed continue: no overlay (nothing to expose), but the
      // auto-continue is still published truthfully (achieved + autoContinued);
      // the bridge reports the real end.
      deps.publishGoalState(candidate.sessionId, {
        ...verifiedProjection,
        autoContinued: true,
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
    // C6: top-level `autoContinued: true` — watch dataMatch is a shallow,
    // top-level match; the nested interruption object rides along.
    deps.publishGoalState(candidate.sessionId, {
      ...verifiedProjection,
      autoContinued: true,
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

  async function handleCandidate(candidate: SweepCandidate, bootTimeMs: number, report: SweepReport, boot: boolean): Promise<void> {
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
      // C3: read the runtime's real projection; only the BOOT sweep makes a
      // silently active non-Pi goal visible (a fresh process has nothing
      // busy). Every canonical terminal status and an explicit pause get
      // nothing (no change).
      if (!boot) {
        skip('non-Pi visibility runs only in the boot sweep');
        return;
      }
      const projection = await deps.readRuntimeProjection?.(candidate.sessionId, candidate.runtime);
      if (!projection || NON_PI_TERMINAL.has(projection.status) || projection.status === 'paused') {
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
    /** Boot / drain-timeout sweep. `candidates` come from the server wiring. `opts.boot` gates non-Pi visibility (C3). */
    async run(candidates: SweepCandidate[], bootTimeMs: number, opts?: { boot?: boolean }): Promise<SweepReport> {
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
            await handleCandidate(candidate, bootTimeMs, report, opts?.boot ?? false);
          } catch (error) {
            report.skipped.push(candidate.sessionId);
            report.skipReasons[candidate.sessionId] = `error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      return report;
    },
  };
}
