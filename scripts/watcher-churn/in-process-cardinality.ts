#!/usr/bin/env npx tsx
/**
 * B1.1 correction 03 (review minor 5) — DIRECT watcher-map cardinality.
 *
 * The heap-snapshot summary assigns each object one shortest retainer path and
 * reports only the dominant groups, so a reported zero is not proof that no
 * watcher-held object remains. This harness instead runs the real
 * `SessionWatcher` (real chokidar) against a temp sessions dir, churns the same
 * 3,000 session files as `cli.ts`, and reports the map cardinalities directly:
 *
 *   SessionWatcher: debounceTimers, readStateByPath, sessionIdsByPath,
 *                   pendingInfoByPath sizes
 *   chokidar:       `_watched` file keys and `_closers` file keys under the
 *                   sessions dir, plus the live fs.watch count
 *
 * It exits non-zero if any cardinality grows across the churn.
 *
 *   npx tsx scripts/watcher-churn/in-process-cardinality.ts \
 *     --watcher server/src/pi/session-watcher.ts --label final-build
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareChurnDirectories, runChurn } from './churn.js';

interface Args {
  watcher: string;
  label: string;
  filesPerCase: number;
  directories: number;
  settleMs: number;
}

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseArgs(argv: string[]): Args {
  return {
    watcher: getFlag(argv, '--watcher') ?? 'server/src/pi/session-watcher.ts',
    label: getFlag(argv, '--label') ?? 'in-process',
    filesPerCase: Number(getFlag(argv, '--files-per-case') ?? '1000'),
    directories: Number(getFlag(argv, '--directories') ?? '12'),
    settleMs: Number(getFlag(argv, '--settle-ms') ?? '6000'),
  };
}

interface WatcherLike {
  start(): void;
  stop(): Promise<void>;
  on(event: string, listener: (...a: unknown[]) => void): void;
  debugFullReadCount: number;
  debugBoundedHeaderReadCount: number;
  debounceTimers: Map<string, unknown>;
  readStateByPath: Map<string, unknown>;
  sessionIdsByPath: Map<string, unknown>;
  pendingInfoByPath: Map<string, unknown>;
  watcher: {
    _watched: Map<string, Set<string>>;
    _closers: Map<string, unknown[]>;
  } | null;
}

function cardinality(watcher: WatcherLike): Record<string, number> {
  const chokidar = watcher.watcher;
  const fileKey = (key: string) => key.endsWith('.jsonl') && !key.includes('*');
  const watchedFileKeys = chokidar ? [...chokidar._watched.keys()].filter(fileKey).length : -1;
  const closerFileKeys = chokidar ? [...chokidar._closers.keys()].filter(fileKey).length : -1;
  return {
    debounceTimers: watcher.debounceTimers.size,
    readStateByPath: watcher.readStateByPath.size,
    sessionIdsByPath: watcher.sessionIdsByPath.size,
    pendingInfoByPath: watcher.pendingInfoByPath.size,
    chokidarWatchedFileKeys: watchedFileKeys,
    chokidarCloserFileKeys: closerFileKeys,
    chokidarWatchedKeys: chokidar ? chokidar._watched.size : -1,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'watcher-cardinality-'));
  const { SessionWatcher } = await import(pathToFileURL(path.resolve(args.watcher)).href) as {
    SessionWatcher: new (dir: string, registry?: unknown, options?: { debounceDelay?: number }) => WatcherLike;
  };

  await prepareChurnDirectories(sessionsDir, args.directories);
  const watcher = new SessionWatcher(sessionsDir);
  watcher.on('session_update', () => {});
  watcher.start();
  // Let chokidar finish its initial (ignoreInitial) index of the empty dirs.
  await sleep(700);

  const before = cardinality(watcher);
  const churn = await runChurn(sessionsDir, {
    filesPerCase: args.filesPerCase,
    directories: args.directories,
    onProgress: () => {},
  });
  await sleep(args.settleMs);
  const after = cardinality(watcher);

  const delta: Record<string, number> = {};
  for (const key of Object.keys(before)) delta[key] = after[key] - before[key];

  const result = {
    label: args.label,
    watcherPath: args.watcher,
    filesPerCase: args.filesPerCase,
    totalFiles: churn.totalWritten,
    before,
    after,
    delta,
    debugFullReadCount: watcher.debugFullReadCount,
    debugBoundedHeaderReadCount: watcher.debugBoundedHeaderReadCount,
  };
  console.log(JSON.stringify(result, null, 2));

  await watcher.stop();
  await rm(sessionsDir, { recursive: true, force: true });

  const growth = Object.values(delta).filter((value) => value > 0);
  if (growth.length > 0) {
    console.error(`watcher cardinality grew: ${JSON.stringify(delta)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
