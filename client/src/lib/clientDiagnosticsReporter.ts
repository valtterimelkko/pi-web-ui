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
 * Rules this module lives by:
 *   - Fire-and-forget: reporting must never throw into the surface that
 *     failed (observability observes; it does not alter behaviour).
 *   - Bounded: every field is length-capped, recent-event context is capped
 *     at 12 ring entries, and the module caps itself at
 *     {@link MAX_REPORTS_PER_PAGE} uploads per page load.
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

let uploadsUsed = 0;

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
  installed = false;
}
