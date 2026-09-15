/**
 * Shutdown escape worker (2026-09-15).
 *
 * The main thread records a received stop signal synchronously (see
 * `shutdown-signal.ts`) and then begins teardown on its own event loop. This
 * worker is the independent backstop: if the process is still alive
 * `escapeAfterMs` later, it writes the reason and ends the process itself.
 *
 * Two production facts make this necessary rather than nice-to-have:
 *
 *  1. On 2026-09-14 18:04:17 and 21:15:56 the teardown ran, five of six steps
 *     finished in under 25 ms, and the `http-server` step never completed at
 *     all — `server.close()` waiting on long-lived WebSocket clients. The only
 *     thing that ended those stops was the coordinator's 25s hard-exit, leaving
 *     a few seconds of margin under systemd's `TimeoutStopSec=30`.
 *  2. systemd's escalation is `KillMode=control-group`: the SIGKILL that
 *     follows takes the whole cgroup, orchestration children included.
 *
 * So the backstop lives on a worker thread for the same reason the watchdog
 * pinger does — a bound scheduled on the loop it must survive is not a bound —
 * and it writes straight to stderr, because routing the reason through
 * `parentPort` would queue it behind the very wedge being reported.
 *
 * The force path is deliberately the smallest thing that can work: one
 * synchronous stderr write, then `SIGKILL` to this process. `process.exit()`
 * from a worker thread ends only that thread, so signalling the process is the
 * only reliable way to end it from here. That is still a strictly better
 * outcome than systemd's SIGKILL, which happens ~18s later, records no reason,
 * and is the escalation that actually loses work — and the reason is on stderr
 * before it happens.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { writeLineSynchronously } from './sync-stderr.js';
import {
  DEFAULT_ESCAPE_AFTER_MS,
  DEFAULT_ESCAPE_POLL_INTERVAL_MS,
  decideShutdownEscapeTick,
  parseEscapeAfterMs,
  type ShutdownEscapeDecision,
} from './shutdown-escape-policy.js';

export interface ShutdownEscapeWorkerData {
  /**
   * Shared with the main thread. Index 0 holds the epoch-ms time at which the
   * stop signal was recorded, or 0 when none has been. A `BigInt64Array` over a
   * `SharedArrayBuffer` keeps this atomically readable across threads without a
   * lock the main thread would have to take.
   */
  signalReceived: BigInt64Array;
  escapeAfterMs: number;
  pollIntervalMs: number;
}

/** Injectable seams so the loop is testable without threads or a real kill. */
export interface ShutdownEscapeWorkerDeps {
  /** Last resort. Default ends this process with SIGKILL. */
  forceExit?: (code: number) => void;
  report?: (line: string) => void;
  now?: () => number;
}

/** Read the signal time the main thread published. 0 means "no stop signal yet". */
function readSignalReceivedAt(signalReceived: BigInt64Array): number {
  try {
    return Number(Atomics.load(signalReceived, 0));
  } catch {
    return 0;
  }
}

/**
 * End this process from a worker thread.
 *
 * `process.exit()` here terminates the worker, not the process, so the last
 * resort signals the process itself. `SIGKILL` is uncatchable, which is the
 * point: the thing being escaped is a main thread that cannot finish its own
 * shutdown.
 */
function defaultForceExit(code: number): void {
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    /* If signalling fails there is nothing else this thread can do. */
    process.exit(code);
  }
}

export function runShutdownEscapeWorker(
  data: ShutdownEscapeWorkerData,
  deps: ShutdownEscapeWorkerDeps = {},
): { stop: () => void; refed: boolean } {
  const { signalReceived, escapeAfterMs, pollIntervalMs } = data;
  const forceExit = deps.forceExit ?? defaultForceExit;
  // `process.stderr.write` is asynchronous on a pipe, and this line is the last
  // thing written before the process is ended — see `sync-stderr.ts`. Live
  // validation against a wedged main thread lost exactly this line.
  const report = deps.report ?? writeLineSynchronously;
  const now = deps.now ?? (() => Date.now());
  let previouslyEscaped = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || previouslyEscaped) return;
    const decision: ShutdownEscapeDecision = decideShutdownEscapeTick({
      nowMs: now(),
      signalReceivedAtMs: readSignalReceivedAt(signalReceived),
      escapeAfterMs,
      previouslyEscaped,
    });

    if (decision.action !== 'escape') return;

    previouslyEscaped = true;
    // Synchronous, and BEFORE the exit: a reason recorded after the process has
    // gone is not a record.
    report(
      `[Shutdown] event=shutdown_escape signal_recorded_ms_ago=${decision.sinceSignalMs} ` +
        `window_ms=${escapeAfterMs} action=force_exit note="main thread did not exit inside the grace window; ending the process before systemd TimeoutStopSec"`,
    );
    forceExit(1);
  }, pollIntervalMs);

  // DO NOT unref this timer.
  //
  // An unref'd timer does not keep a worker's event loop alive, so the worker
  // exits silently immediately after start-up and the backstop stops existing.
  // That exact defect caused a production restart loop on 2026-09-14 in the
  // watchdog pinger; here it would be worse, because a backstop that has
  // silently gone away is indistinguishable from one that is working — right up
  // until the stop it was added for. `worker.unref()` on the MAIN thread is what
  // keeps this thread from holding the process open; keeping this thread alive
  // is the entire point of it. Asserted in shutdown-escape-worker.test.ts.

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    /** Whether the poll timer is keeping this thread's event loop alive. */
    refed: typeof timer.hasRef === 'function' ? timer.hasRef() : true,
  };
}

// Auto-run when loaded as a worker thread (`new Worker(new URL(...))`); the
// export above stays testable without spawning a thread.
const workerSignal = (workerData as Partial<ShutdownEscapeWorkerData> | undefined)?.signalReceived;
if (workerSignal && parentPort) {
  const data = workerData as ShutdownEscapeWorkerData;
  runShutdownEscapeWorker({
    signalReceived: data.signalReceived,
    escapeAfterMs: data.escapeAfterMs ?? parseEscapeAfterMs(process.env.PI_WEB_UI_SHUTDOWN_ESCAPE_MS),
    pollIntervalMs: data.pollIntervalMs ?? DEFAULT_ESCAPE_POLL_INTERVAL_MS,
  });
}

export { DEFAULT_ESCAPE_AFTER_MS, DEFAULT_ESCAPE_POLL_INTERVAL_MS };
