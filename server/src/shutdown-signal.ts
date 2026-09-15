/**
 * The synchronous half of the shutdown instrument (2026-09-15).
 *
 * Every stop of `pi-web-ui.service` between 2026-09-14 and 2026-09-15 that ran
 * to systemd's `TimeoutStopSec` shared one property: the journal could not say
 * whether SIGTERM had ever reached the process. The only app-side record was
 * inside `shutdown()`, which reports through an async logger and a coordinator
 * that awaits each step — so a stop that never entered `shutdown()` left
 * nothing, and a stop that entered it and then wedged left only the steps it had
 * already completed.
 *
 * This module makes the receipt of the signal itself the record:
 *
 *  1. write to stderr **synchronously**, before any `await` — so even a stop on
 *     a process whose event loop is about to stall leaves a line;
 *  2. publish the signal time into a `SharedArrayBuffer` the backstop worker can
 *     read without the main thread having to run again (see
 *     `shutdown-escape-worker.ts`);
 *  3. arm a hard-exit deadline **synchronously in the same handler**, so the
 *     process cannot outlive systemd's window even if the teardown never
 *     returns;
 *  4. only then start the asynchronous teardown.
 *
 * Steps 1–3 deliberately do not use the central logger: it buffers, it may be
 * silenced, and it performs async I/O. The one thing this record must survive is
 * a process that is about to die.
 *
 * Everything is injectable so the ordering and the arming are unit-testable
 * without signalling the test runner.
 */

import { Worker } from 'node:worker_threads';
import { writeLineSynchronously } from './sync-stderr.js';
import {
  DEFAULT_ESCAPE_AFTER_MS,
  DEFAULT_ESCAPE_POLL_INTERVAL_MS,
  parseEscapeAfterMs,
} from './shutdown-escape-policy.js';
import { runShutdownEscapeWorker } from './shutdown-escape-worker.js';

/** The signals a stop can arrive as. */
export const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

/**
 * Default hard-exit deadline, armed synchronously on signal receipt.
 *
 * Kept below both systemd's `TimeoutStopSec=30` and the coordinator's own
 * `DEFAULT_FORCE_EXIT_AFTER_MS=20000`, so a teardown that never returns still
 * cannot reach systemd's escalation. 20s leaves 10s of headroom.
 */
export const DEFAULT_HARD_EXIT_AFTER_MS = 20_000;

export interface StopSignalDeps {
  /**
   * Synchronous record. Default writes a single line to fd 2.
   *
   * `process.stderr.write` on a TTY/pipe is synchronous, which is exactly the
   * property needed here; it is the one sink that does not wait for the event
   * loop.
   */
  write?: (line: string) => void;
  now?: () => number;
  /** Shared with the backstop worker; omit to run without a backstop. */
  signalReceived?: BigInt64Array;
  /** The asynchronous teardown. */
  onShutdown: () => void;
  /** Injectable; default Node `setTimeout`. Not unref'd: it must fire. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  exit?: (code: number) => void;
  /** Overrides `DEFAULT_HARD_EXIT_AFTER_MS`. */
  hardExitAfterMs?: number;
}

function defaultWrite(line: string): void {
  // Synchronous on purpose, and by syscall rather than by stream semantics:
  // `process.stderr.write` is asynchronous when fd 2 is a pipe, which is the
  // case under journald capture and under `systemd-run`. A record that is still
  // buffered when the process ends is not a record. See `sync-stderr.ts`.
  writeLineSynchronously(line);
}

/**
 * Record a received stop signal and begin shutdown. Synchronous by design up to
 * the point where the teardown is handed off.
 *
 * Never throws: a throwing teardown must not erase the record that it was
 * attempted, and a signal handler that throws is its own incident.
 */
export function handleStopSignal(signal: string, deps: StopSignalDeps): void {
  const write = deps.write ?? defaultWrite;
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const hardExitAfterMs = deps.hardExitAfterMs ?? DEFAULT_HARD_EXIT_AFTER_MS;

  // 1. The record, before anything can await.
  const receivedAt = now();
  write(
    `[Shutdown] event=stop_signal signal=${signal} received_at=${new Date(receivedAt).toISOString()} ` +
      `pid=${process.pid} ppid=${process.ppid} uptime_s=${Math.round(process.uptime())} note="recorded synchronously before any await"`,
  );

  // 2. Publish for the backstop worker. Best-effort: a missing or read-only
  //    buffer must not stop the shutdown.
  if (deps.signalReceived) {
    try {
      Atomics.store(deps.signalReceived, 0, BigInt(receivedAt));
    } catch {
      /* no shared buffer available; the worker will stay idle */
    }
  }

  // 3. Arm the deadline synchronously, in the same handler.
  try {
    setTimeoutFn(() => {
      write(
        `[Shutdown] event=hard_exit_deadline window_ms=${hardExitAfterMs} ` +
          `note="teardown did not complete inside the deadline; exiting before systemd TimeoutStopSec"`,
      );
      exit(1);
    }, hardExitAfterMs);
  } catch {
    /* A deadline that cannot be armed must not stop the shutdown either. */
  }

  // 4. Hand off to the real teardown.
  try {
    deps.onShutdown();
  } catch (error) {
    write(`[Shutdown] event=teardown_threw error=${String(error)}`);
  }
}

export interface InstallStopSignalOptions extends StopSignalDeps {
  /** Injectable process for tests; default the real one. */
  processLike?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/**
 * Register the stop-signal handlers. Returns an uninstall function.
 *
 * Registration is idempotent per signal name: repeated installs would otherwise
 * stack teardowns, which is the class of problem `ShutdownCoordinator`'s
 * single-flight guard exists to absorb.
 */
export function installStopSignalHandlers(options: InstallStopSignalOptions): () => void {
  const target = options.processLike ?? process;
  const registered: StopSignal[] = [];

  for (const signal of STOP_SIGNALS) {
    const handler = (): void => handleStopSignal(signal, options);
    target.on(signal, handler);
    registered.push(signal);
  }

  return () => {
    for (const signal of registered) target.off(signal, () => {});
  };
}

/** Shared-buffer factory used by the entry point and by tests. */
export function createSignalReceivedBuffer(): BigInt64Array {
  return new BigInt64Array(new SharedArrayBuffer(8));
}

/**
 * Spawn the backstop worker thread.
 *
 * Callers that must not spawn a thread (unit tests) inject their own seam rather
 * than this being conditionally compiled. Mirrors `spawnWatchdogWorker` in
 * `systemd-notifier.ts`.
 */
export function spawnShutdownEscapeWorker(data: {
  signalReceived: BigInt64Array;
  escapeAfterMs: number;
  pollIntervalMs: number;
}): { terminate: () => void } {
  const worker = new Worker(new URL('./shutdown-escape-worker.js', import.meta.url), {
    workerData: data,
  });
  // A backstop that keeps the process alive is self-defeating.
  worker.unref();
  worker.on('error', () => {
    /* a dead backstop must not take the server down */
  });
  return { terminate: () => { void worker.terminate(); } };
}

/** Resolve the escape window from the environment. */
export function resolveEscapeAfterMs(raw: string | undefined = process.env.PI_WEB_UI_SHUTDOWN_ESCAPE_MS): number {
  return parseEscapeAfterMs(raw, DEFAULT_ESCAPE_AFTER_MS);
}

export { runShutdownEscapeWorker, DEFAULT_ESCAPE_POLL_INTERVAL_MS };
