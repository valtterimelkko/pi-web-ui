/**
 * Completed-run teardown (B0.1 defect 3).
 *
 * After a `complete` run the disposable server unit used to stay up until
 * `cli.ts stop` was run by hand. A finished run should tear itself down; the
 * only reason to keep the server up is an explicit operator request, and when
 * that happens the completion Telegram notice must say so.
 *
 * Pure: the supervisor supplies the terminal state and the keep flag, and
 * performs the actual `systemctl stop`/`waitForUnitGone` I/O.
 */
import type { RunTerminalState } from './run-state.js';

/** Env flag read by the supervisor: keep the server unit up after a completed run. */
export const TEARDOWN_KEEP_SERVER_ENV_KEY = 'HEAP_SOAK_KEEP_SERVER';

/** Truthy only for an explicit `1`/`true` (so an inherited `HEAP_SOAK_KEEP_SERVER=0` keeps the default). */
export function parseKeepServerFlag(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export interface RunTeardownInput {
  keepServer: boolean;
  terminalState: RunTerminalState;
}

export interface RunTeardownDecision {
  stopServer: boolean;
  reason: string;
}

export function decideRunTeardown(input: RunTeardownInput): RunTeardownDecision {
  if (input.terminalState === 'server_died') {
    return { stopServer: false, reason: 'the disposable server already died — nothing to stop' };
  }
  if (input.keepServer) {
    return { stopServer: false, reason: `server kept up after completion (${TEARDOWN_KEEP_SERVER_ENV_KEY} set)` };
  }
  return { stopServer: true, reason: 'run complete: stopping the disposable server after the end snapshot' };
}

export interface CompletionNoticeInput {
  verdict: string;
  trailingSlopeMBPerHour: number;
  peakHeapMB: number;
  keepServer: boolean;
  serverUnit?: string;
  /** Set when the disposable server unit could not be confirmed gone (correction 03 item 8). */
  teardownAnomaly?: string;
}

/**
 * The completion Telegram body. When the server is kept up the message must
 * say so explicitly (B0.1 defect 3), and a failed teardown must be surfaced
 * rather than hidden behind a successful-looking completion (correction 03
 * item 8).
 */
export function completionNoticeBody(input: CompletionNoticeInput): string {
  let body = `verdict=${input.verdict} trailingSlope=${input.trailingSlopeMBPerHour.toFixed(2)}MB/h peakHeap=${input.peakHeapMB.toFixed(0)}MB`;
  if (input.keepServer) {
    const unit = input.serverUnit ?? 'the disposable server unit';
    body += `; SERVER LEFT RUNNING (${TEARDOWN_KEEP_SERVER_ENV_KEY}=1): ${unit} — stop it with \`cli.ts stop\` when the inspection is done`;
  }
  if (input.teardownAnomaly) {
    body += `; TEARDOWN ANOMALY: ${input.teardownAnomaly}`;
  }
  return body;
}

/** The teardown outcome recorded in run-state.json and rendered in report.md. */
export interface TeardownReport {
  serverUnit: string;
  /** ISO time the supervisor finished its stop attempts. */
  stoppedAt?: string;
  /** true only when the unit was confirmed gone (`systemctl` LoadState=not-found). */
  verifiedGone?: boolean;
  /** How many `stopUnit` attempts were made. */
  attempts?: number;
  /** Set when the unit was still present after the bound. */
  anomaly?: string;
}

/** The report.md teardown section (correction 03 item 8). */
export function renderTeardownMarkdown(teardown: TeardownReport): string[] {
  const lines = ['## Teardown', ''];
  if (teardown.anomaly || teardown.verifiedGone === false) {
    lines.push(`**TEARDOWN ANOMALY**: ${teardown.anomaly ?? `server unit \`${teardown.serverUnit}\` was not verified gone`}.`);
    lines.push('');
    lines.push('The run is complete, but the disposable server unit may still be running; stop it with `cli.ts stop` before starting another run.');
    return lines;
  }
  lines.push(`- Server unit: \`${teardown.serverUnit}\``);
  if (teardown.stoppedAt) lines.push(`- Stopped at: ${teardown.stoppedAt}`);
  if (teardown.attempts !== undefined) lines.push(`- Stop attempts: ${teardown.attempts}`);
  lines.push(`- Verified gone: ${teardown.verifiedGone ?? 'unknown'}`);
  return lines;
}
