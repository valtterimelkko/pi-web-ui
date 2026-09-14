import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_BEAT_INTERVAL_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_STALL_AFTER_MS,
  parseStallAfterMs,
} from './watchdog-policy.js';

type Notify = (args: string[]) => Promise<void> | void;
type Environment = Pick<NodeJS.ProcessEnv, 'NOTIFY_SOCKET' | 'WATCHDOG_USEC' | 'PI_WEB_UI_WATCHDOG_STALL_MS'>;

interface SystemdNotifierOptions {
  environment?: Environment;
  notify?: Notify;
  logger?: { warn: (message: string) => void };
  /** Injectable for tests; default spawns the real worker thread. */
  startWorker?: (data: { beats: BigInt64Array; pingIntervalMs: number; stallAfterMs: number }) => { terminate: () => void };
  beatIntervalMs?: number;
  pingIntervalMs?: number;
  /** Heartbeat staleness treated as a stall; overrides the env var. */
  stallAfterMs?: number;
  now?: () => number;
}

function runSystemdNotify(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/systemd-notify', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`systemd-notify exited ${code}`)));
  });
}

function spawnWatchdogWorker(data: { beats: BigInt64Array; pingIntervalMs: number; stallAfterMs: number }): { terminate: () => void } {
  const worker = new Worker(new URL('./systemd-watchdog-worker.js', import.meta.url), { workerData: data });
  // A watchdog that keeps the process alive is self-defeating.
  worker.unref();
  worker.on('error', () => { /* a dead pinger must not take the server down */ });
  return { terminate: () => { void worker.terminate(); } };
}

/**
 * systemd readiness + watchdog notifications.
 *
 * The `WATCHDOG=1` schedule was previously a `setInterval` on the main event
 * loop — a ping living on the very loop it exists to watch. A stall then made
 * the ping go silent while giving the operator no reason for the subsequent
 * restart. The ping now runs in a worker thread, gated on a heartbeat the main
 * thread publishes (see `watchdog-policy.ts` for the full reasoning and for
 * why a stalled main thread deliberately still stops the pings).
 *
 * Everything here stays injectable so the behaviour is testable without
 * spawning threads or talking to systemd.
 */
export function startSystemdNotifier(options: SystemdNotifierOptions = {}): () => void {
  const environment = options.environment ?? process.env;
  if (!environment.NOTIFY_SOCKET) return () => {};

  const notify = options.notify ?? runSystemdNotify;
  const now = options.now ?? (() => Date.now());
  let stopped = false;
  let inFlight = false;
  const send = (args: string[]): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void Promise.resolve(notify(args))
      .catch((error: unknown) => options.logger?.warn(`systemd notification failed: ${String(error)}`))
      .finally(() => { inFlight = false; });
  };

  send(['--ready', '--status=Pi Web UI ready']);
  if (!environment.WATCHDOG_USEC) return () => { stopped = true; };

  const beatIntervalMs = options.beatIntervalMs ?? DEFAULT_BEAT_INTERVAL_MS;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const stallAfterMs = options.stallAfterMs
    ?? parseStallAfterMs(environment.PI_WEB_UI_WATCHDOG_STALL_MS, DEFAULT_STALL_AFTER_MS);

  // Shared with the worker: index 0 holds the last beat as an epoch-ms BigInt.
  // A BigInt64Array keeps this atomically readable across threads.
  const beats = new BigInt64Array(new SharedArrayBuffer(8));

  const beat = (): void => {
    if (stopped) return;
    try {
      Atomics.store(beats, 0, BigInt(now()));
    } catch {
      /* a heartbeat failure must never be fatal */
    }
  };
  beat();
  const beatTimer = setInterval(beat, beatIntervalMs);
  beatTimer.unref();

  const startWorker = options.startWorker ?? spawnWatchdogWorker;
  const worker = startWorker({ beats, pingIntervalMs, stallAfterMs });

  return () => {
    stopped = true;
    clearInterval(beatTimer);
    try {
      worker.terminate();
    } catch {
      /* terminating an already-dead worker is not an error */
    }
  };
}
