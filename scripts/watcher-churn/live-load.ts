#!/usr/bin/env npx tsx
/**
 * B1.1 correction — live-session load profile.
 *
 * Chokidar applies `awaitWriteFinish` to `change` events too. Removing it (to
 * fix the deleted-file retention) means a session file being appended to can
 * notify on every write, and the watcher's complete-file read is
 * `fs.readFile` of the whole file plus a synchronous `JSON.parse` per line —
 * tens of MB for a real session. This harness measures that load directly,
 * with no server and no model tokens:
 *
 *  1. build one large realistic JSONL session file (generated, never copied);
 *  2. append one realistic entry at a streaming cadence for `--duration-ms`;
 *  3. let it go quiet;
 *  4. report the watcher's complete-file read count, the aggregate wall-clock
 *     read latency (not event-loop blocking time) and a real
 *     event-loop-delay histogram (`perf_hooks.monitorEventLoopDelay`), which is
 *     what lag claims must be based on.
 *
 * Run it once per build:
 *   npx tsx scripts/watcher-churn/live-load.ts \
 *     --watcher server/src/pi/session-watcher.ts --label old
 */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Args {
  watcher: string;
  label: string;
  fileMb: number;
  appendMs: number;
  durationMs: number;
  quietMs: number;
  debounceDelay: number;
}

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseArgs(argv: string[]): Args {
  return {
    watcher: getFlag(argv, '--watcher') ?? 'server/src/pi/session-watcher.ts',
    label: getFlag(argv, '--label') ?? 'run',
    fileMb: Number(getFlag(argv, '--file-mb') ?? '20'),
    appendMs: Number(getFlag(argv, '--append-ms') ?? '100'),
    durationMs: Number(getFlag(argv, '--duration-ms') ?? '60000'),
    quietMs: Number(getFlag(argv, '--quiet-ms') ?? '3000'),
    debounceDelay: Number(getFlag(argv, '--debounce-ms') ?? '500'),
  };
}

function messageEntry(seq: number, payloadBytes: number): string {
  const text = 'x'.repeat(payloadBytes);
  return JSON.stringify({
    type: 'message',
    id: `m-${seq}`,
    timestamp: Date.now(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';
}

function ms(n: number): number {
  return +(n / 1e6).toFixed(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'watcher-live-load-'));
  const filePath = path.join(sessionsDir, `live-load-${args.label}.jsonl`);
  const payloadBytes = 8_000; // ~8 KB per realistic assistant entry
  const targetBytes = args.fileMb * 1024 * 1024;

  // 1. Large realistic session file.
  const chunks: string[] = [JSON.stringify({ type: 'session', id: `live-load-${args.label}`, cwd: '/tmp/watcher-live-load', timestamp: Date.now() }) + '\n'];
  let bytes = chunks[0].length;
  let seq = 0;
  while (bytes < targetBytes) {
    const entry = messageEntry(seq++, payloadBytes);
    chunks.push(entry);
    bytes += entry.length;
  }
  await writeFile(filePath, chunks.join(''));

  const { SessionWatcher } = await import(pathToFileURL(path.resolve(args.watcher)).href) as {
    SessionWatcher: new (dir: string, registry?: unknown, options?: { debounceDelay?: number }) => {
      start(): void;
      stop(): Promise<void>;
      on(event: string, listener: (...a: unknown[]) => void): void;
      debugFullReadCount: number;
      debugBoundedHeaderReadCount: number;
      readSessionInfo(p: string): Promise<unknown>;
    };
  };

  const watcher = new SessionWatcher(sessionsDir, undefined, { debounceDelay: args.debounceDelay });
  let events = 0;
  watcher.on('session_update', () => { events += 1; });

  // Time the complete-file reads. This is *aggregate wall-clock read latency*
  // (it includes asynchronous filesystem waiting), NOT event-loop blocking time;
  // lag claims must come from the `monitorEventLoopDelay` histogram below.
  const originalRead = watcher.readSessionInfo.bind(watcher);
  let readCalls = 0;
  let aggregateReadNs = 0;
  let maxReadNs = 0;
  watcher.readSessionInfo = async (p: string) => {
    readCalls += 1;
    const start = process.hrtime.bigint();
    try {
      return await originalRead(p);
    } finally {
      const elapsed = Number(process.hrtime.bigint() - start);
      aggregateReadNs += elapsed;
      if (elapsed > maxReadNs) maxReadNs = elapsed;
    }
  };

  watcher.start();
  // Give chokidar its initial index (ignoreInitial) a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const appendStart = Date.now();
  let appends = 0;
  while (Date.now() - appendStart < args.durationMs) {
    await appendFile(filePath, messageEntry(seq++, payloadBytes));
    appends += 1;
    await new Promise((resolve) => setTimeout(resolve, args.appendMs));
  }
  const appendEnd = Date.now();
  await new Promise((resolve) => setTimeout(resolve, args.quietMs));
  histogram.disable();

  const result = {
    label: args.label,
    watcherPath: args.watcher,
    fileMB: +(bytes / 1e6).toFixed(1),
    appends,
    appendSeconds: +((appendEnd - appendStart) / 1000).toFixed(1),
    completeFileReads: readCalls,
    debugFullReadCount: watcher.debugFullReadCount,
    debugBoundedHeaderReadCount: watcher.debugBoundedHeaderReadCount,
    /** Aggregate wall-clock latency of all complete-file reads (includes async fs wait). */
    aggregateReadLatencyMs: +(aggregateReadNs / 1e6).toFixed(0),
    maxReadLatencyMs: +(maxReadNs / 1e6).toFixed(0),
    events,
    eventLoopDelay: {
      meanMs: ms(histogram.mean),
      p50Ms: ms(histogram.percentile(50)),
      p99Ms: ms(histogram.percentile(99)),
      maxMs: ms(histogram.max),
    },
  };
  console.log(JSON.stringify(result, null, 2));

  await watcher.stop();
  await rm(sessionsDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
