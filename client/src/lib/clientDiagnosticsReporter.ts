/**
 * clientDiagnosticsReporter — P13 Phase 2: the upload half of "make client
 * voice errors visible".
 *
 * The browser diagnostic ring (browserDiagnostics.ts) is manual-only by
 * design, and a crash is not survivable: once the operator reloads the tab,
 * the evidence is gone and no server-side query can ever see it. This module
 * is the minimal additive path the P13 brief authorises: it POSTs a strictly
 * bounded, client-side-scrubbed report to `/api/client-diagnostics`, whose
 * handler re-emits it as an ordinary `ClientVoice` central-logger record —
 * landing in the server's EXISTING diagnostics ring, retrievable through the
 * SAME documented query as every server-side record:
 *
 *   GET /api/v1/diagnostics?component=ClientVoice
 *
 * P13 gap fill: the same path also carries PLAYBACK HEALTH. A crash is only
 * half of "why didn't I hear it?"; the other half is a lane that accepted
 * audio and never played it, which used to live only in the surface's memory.
 * {@link reportPlaybackHealth} uploads a bounded playback fault (corrupt
 * chunk, sequence gap, backlog overflow) and a bounded lane-end summary, so
 * "did the lane play everything it accepted?" is answerable from server
 * evidence alone.
 *
 * Rules this module lives by:
 *   - Fire-and-forget: reporting must never throw into the surface that
 *     failed (observability observes; it does not alter behaviour).
 *   - Bounded: every field is length-capped, recent-event context is capped
 *     at 12 ring entries, and the module caps itself at
 *     {@link MAX_REPORTS_PER_PAGE} error uploads and
 *     {@link MAX_PLAYBACK_HEALTH_REPORTS_PER_PAGE} health uploads per page load.
 *   - Scrubbed client-side: no tokens, no utterance text, no transcript
 *     bodies, no cookies; the server ring scrubs again on entry.
 */

import {
  getRecentBrowserEvents,
  recordBrowserDiagnostic,
  scrubClientText,
} from './browserDiagnostics.js';

const API_URL = import.meta.env.VITE_API_URL || '';

/** Uploads allowed per page load. After this, reporting stays local-only
 *  (the browser ring still records) so a failure loop cannot flood the
 *  server's ring. */
export const MAX_REPORTS_PER_PAGE = 10;
const MAX_MESSAGE = 300;
const MAX_STACK = 1500;
const MAX_NAME = 80;
const MAX_CONTEXT_EVENTS = 12;

export interface ClientErrorReport {
  /** Surface operation: uncaught_error, unhandled_rejection, react_render,
   *  playback_failed, dictation_error, talker_listener. */
  operation: string;
  message: string;
  errorName?: string;
  stack?: string;
  /** Voice-surface correlation when the surface knows it (the same
   *  worker-session key the server's VoiceMode records carry). */
  runtime?: string;
  workerSessionId?: string;
  /** Attach the bounded ring tail as context (default true). */
  withContext?: boolean;
}

/** What a playback-health record is reporting. */
export type PlaybackHealthReason =
  | 'playback_chunk_corrupt'
  | 'playback_seq_gap'
  | 'playback_overflow'
  | 'lane_end';

/**
 * The bounded numeric shape of the playback pipeline at the moment of the
 * report. At `lane_end`, a non-zero `pendingMs` is audio the lane ACCEPTED and
 * never played — the stranding the operator hears as a sentence that stops.
 */
export interface PlaybackHealthStats {
  chunksScheduled: number;
  chunksDropped: number;
  pendingChunks: number;
  pendingMs: number;
  queuedMs: number;
  ducked: boolean;
}

export interface PlaybackHealthReport {
  reason: PlaybackHealthReason;
  /** Bounded, scrubbed fault detail (never utterance or transcript text). */
  detail?: string;
  runtime?: string;
  workerSessionId?: string;
  stats: PlaybackHealthStats;
  /** Attach the bounded ring tail as context (default true). */
  withContext?: boolean;
}

/**
 * Health uploads allowed per page load. Separate from the error budget so a
 * long lane with faults cannot starve crash reporting, and so a fault storm
 * cannot flood the server's ring: after this, the browser ring still records.
 */
export const MAX_PLAYBACK_HEALTH_REPORTS_PER_PAGE = 20;

let uploadsUsed = 0;
let healthUploadsUsed = 0;

/** Server schema mirrors this ceiling; the client clamps so it never 400s. */
const MAX_STAT = 1_000_000;
const MAX_DETAIL = 300;

function statNumber(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), MAX_STAT);
}

function boundedStats(stats: PlaybackHealthStats): PlaybackHealthStats {
  return {
    chunksScheduled: statNumber(stats.chunksScheduled),
    chunksDropped: statNumber(stats.chunksDropped),
    pendingChunks: statNumber(stats.pendingChunks),
    pendingMs: statNumber(stats.pendingMs),
    queuedMs: statNumber(stats.queuedMs),
    ducked: stats.ducked === true,
  };
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, max);
}

/** Report one client-side failure. Never throws; resolves when dispatched. */
export async function reportClientError(report: ClientErrorReport): Promise<void> {
  try {
    // Context is the story BEFORE this failure — snapshot the ring before the
    // report records its own event, and never include this report in itself.
    const context = report.withContext === false ? undefined : getRecentBrowserEvents(MAX_CONTEXT_EVENTS);

    recordBrowserDiagnostic({
      kind: 'ui_error',
      operation: report.operation,
      errorName: bounded(report.errorName, MAX_NAME),
      state: bounded(scrubClientText(report.message), 160),
    });

    if (uploadsUsed >= MAX_REPORTS_PER_PAGE) return;
    uploadsUsed += 1;

    const payload: Record<string, unknown> = {
      operation: bounded(report.operation, 40) ?? 'unknown',
      message: bounded(scrubClientText(report.message), MAX_MESSAGE) ?? 'unspecified client error',
      ...(bounded(report.errorName, MAX_NAME) ? { errorName: bounded(report.errorName, MAX_NAME) } : {}),
      ...(bounded(report.stack, MAX_STACK) ? { stack: bounded(report.stack, MAX_STACK) } : {}),
      ...(bounded(report.runtime, 20) ? { runtime: bounded(report.runtime, 20) } : {}),
      ...(bounded(report.workerSessionId, 80) ? { workerSessionId: bounded(report.workerSessionId, 80) } : {}),
      ...(context ? { recentEvents: context } : {}),
    };

    await fetch(`${API_URL}/api/client-diagnostics`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Reporting must never alter the failing surface's behaviour.
  }
}

/**
 * Report one playback-health observation (a fault, or the lane-end summary).
 * Never throws; resolves when dispatched. Bounded and scrubbed exactly like an
 * error report, but at `warn` rather than `error` on the server, and with no
 * crash text to invent.
 */
export async function reportPlaybackHealth(report: PlaybackHealthReport): Promise<void> {
  try {
    const context = report.withContext === false ? undefined : getRecentBrowserEvents(MAX_CONTEXT_EVENTS);

    // The manual bundle must carry it too — the ring is the offline story.
    recordBrowserDiagnostic({ kind: 'speech', operation: 'playback_health', state: report.reason });

    if (healthUploadsUsed >= MAX_PLAYBACK_HEALTH_REPORTS_PER_PAGE) return;
    healthUploadsUsed += 1;

    const detail = bounded(report.detail, MAX_DETAIL);
    const payload: Record<string, unknown> = {
      kind: 'playback_health',
      reason: report.reason,
      stats: boundedStats(report.stats),
      ...(detail ? { detail: bounded(scrubClientText(detail), MAX_DETAIL) } : {}),
      ...(bounded(report.runtime, 20) ? { runtime: bounded(report.runtime, 20) } : {}),
      ...(bounded(report.workerSessionId, 80) ? { workerSessionId: bounded(report.workerSessionId, 80) } : {}),
      ...(context ? { recentEvents: context } : {}),
    };

    await fetch(`${API_URL}/api/client-diagnostics`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Reporting must never alter the failing surface's behaviour.
  }
}

let installed = false;

/** Window-level guard: jsdom/tests and SPA remounts keep the same window, so
 *  the installed flag must live on the window, not in module state. */
const INSTALL_FLAG = '__piWebUiClientErrorReportingInstalled';

/**
 * Install the global uncaught-error / unhandled-rejection handlers ONCE.
 * Every failure lands in the browser ring AND uploads to the server ring,
 * so "it errored" becomes answerable from records even after a reload.
 */
export function installGlobalErrorReporting(): void {
  const w = window as unknown as Record<string, unknown>;
  if (installed || w[INSTALL_FLAG] === true) return;
  installed = true;
  w[INSTALL_FLAG] = true;

  window.addEventListener('error', (event) => {
    const error = event.error;
    void reportClientError({
      operation: 'uncaught_error',
      message: error instanceof Error ? error.message : String(event.message ?? 'uncaught error'),
      errorName: error instanceof Error ? error.name : 'Error',
      stack: error instanceof Error ? error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    void reportClientError({
      operation: 'unhandled_rejection',
      message: reason instanceof Error ? reason.message : String(reason ?? 'unhandled rejection'),
      errorName: reason instanceof Error ? reason.name : typeof reason,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

/** Test-only reset of the per-page upload budget. */
export function resetClientErrorReporter(): void {
  uploadsUsed = 0;
  healthUploadsUsed = 0;
  installed = false;
}
