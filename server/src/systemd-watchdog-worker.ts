/**
 * Worker-thread watchdog pinger (see watchdog-policy.ts for the reasoning).
 *
 * This thread owns the `WATCHDOG=1` schedule so the ping no longer depends on
 * the main event loop's timer scheduling. It is deliberately independent of
 * the main thread for **reporting**: stall warnings go straight to stderr, so
 * they reach the journal while the main loop is still blocked. Routing them
 * through `parentPort` would queue them behind the very stall being reported
 * and only surface after the restart had already happened — which is the
 * failure this module exists to fix.
 *
 * Policy (inherited, not decided here): pings stop while the main thread's
 * heartbeat is stale, so systemd can still recover a genuinely hung service.
 * What is new is that the journal now says so first.
 */

import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import {
  decideWatchdogTick,
  type WatchdogDecision,
} from './watchdog-policy.js';

export interface WatchdogWorkerData {
  /** Shared with the main thread; index 0 is the last beat, ms since epoch. */
  beats: BigInt64Array;
  pingIntervalMs: number;
  stallAfterMs: number;
}

/** Injectable seams so the loop itself is testable without threads or systemd. */
export interface WatchdogWorkerDeps {
  ping?: () => Promise<void>;
  report?: (line: string) => void;
  now?: () => number;
}

/** Read the heartbeat the main thread publishes. 0 means "not beaten yet". */
function readLastBeat(beats: BigInt64Array): number {
  try {
    return Number(Atomics.load(beats, 0));
  } catch {
    return 0;
  }
}

/** Same mechanism as the main-thread notifier: the systemd-notify CLI. */
function ping(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/systemd-notify', ['WATCHDOG=1'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`systemd-notify exited ${code}`))));
  });
}

export function runWatchdogWorker(
  data: WatchdogWorkerData,
  deps: WatchdogWorkerDeps = {},
): { stop: () => void; refed: boolean } {
  const { beats, pingIntervalMs, stallAfterMs } = data;
  const pingImpl = deps.ping ?? ping;
  const report = deps.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => Date.now());
  let previouslyStalled = false;
  let stopped = false;
  let inFlight = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const decision: WatchdogDecision = decideWatchdogTick({
      nowMs: now(),
      lastBeatMs: readLastBeat(beats),
      stallAfterMs,
      previouslyStalled,
    });

    if (decision.stallStarted) {
      // Loud, once per stall, and BEFORE the pings stop: the journal should
      // explain the restart rather than merely record it.
      report(
        `[Watchdog] event=event_loop_stall stalled_ms=${decision.stalledMs} ` +
          `threshold_ms=${stallAfterMs} pinging=false note="systemd will restart if pings stay silent past WatchdogSec"`,
      );
    } else if (!decision.stalled && previouslyStalled) {
      report(`[Watchdog] event=event_loop_recovered stalled_ms=${decision.stalledMs} pinging=true`);
    }
    previouslyStalled = decision.stalled;

    if (!decision.ping || inFlight) return;
    inFlight = true;
    void pingImpl()
      .catch((error: unknown) => report(`[Watchdog] event=ping_failed error=${String(error)}`))
      .finally(() => { inFlight = false; });
  }, pingIntervalMs);

  // DO NOT unref this timer.
  //
  // An unref'd timer does not keep a worker's event loop alive, so the worker
  // exits immediately after start-up and the pings stop - silently, because a
  // worker that has exited cannot report anything. systemd then sees no
  // WATCHDOG=1, declares the service hung, and restarts it every
  // WatchdogSec + boot time. That is not hypothetical: it caused a
  // restart-every-68s loop in production on 2026-09-14, caught by the
  // ExecStopPost added the same evening (`Failed with result 'watchdog'`,
  // signal=ABRT). `worker.unref()` on the MAIN thread is what keeps this thread
  // from holding the process open; keeping this thread alive is the entire
  // point of it.

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    /**
     * Whether the ping timer is keeping this thread's event loop alive.
     *
     * Exposed purely so the defect that caused a production restart loop on
     * 2026-09-14 is directly testable: an unref'd timer lets the worker exit
     * silently, so the service stops being certified and systemd restarts it
     * forever. Asserted in systemd-watchdog-worker.test.ts.
     */
    refed: typeof timer.hasRef === 'function' ? timer.hasRef() : true,
  };
}

// Auto-run when loaded as a worker thread (`new Worker(new URL(...))`); the
// export above stays testable without spawning a thread.
const beats = (workerData as Partial<WatchdogWorkerData> | undefined)?.beats;
if (beats && parentPort) {
  runWatchdogWorker(workerData as WatchdogWorkerData);
}
