import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { SessionWatcher } from '../../../src/pi/session-watcher.js';

/**
 * B1.1 retention regressions.
 *
 * The confirmation soak (full-1790523945117-ea387201) showed `Timeout`, `Date`,
 * `Stats` and `FSWatcher` counts growing with child churn. Two retention paths
 * were named:
 *  1. `SessionWatcher.handleChange('unlink')` cleared a pending debounce timer
 *     but never removed its `debounceTimers` entry, so every file added and
 *     unlinked inside the debounce window left a dead timer behind for good.
 *  2. chokidar's `awaitWriteFinish` retained per-file watch state (an entry in
 *     `_watched`, a closer in `_closers`, and the live per-file `fs.watch`)
 *     plus the `Stats`/`Date` objects its listener closure holds, for any file
 *     unlinked before it was declared stable.
 *
 * These tests fail on the pre-fix code and pass afterwards.
 */

interface WatcherInternals {
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionIdsByPath: Map<string, string>;
  readStateByPath: Map<string, unknown>;
  pendingInfoByPath: Map<string, unknown>;
}

function sessionLine(id: string): string {
  return JSON.stringify({ type: 'session', id, cwd: '/tmp/retention-workspace', timestamp: 1 }) + '\n';
}

function internals(watcher: SessionWatcher): WatcherInternals {
  return watcher as unknown as WatcherInternals;
}

function chokidarInternals(watcher: SessionWatcher): {
  _watched: Map<string, Set<string>>;
  _closers: Map<string, unknown[]>;
} {
  const inner = (watcher as unknown as { watcher: FSWatcher | null }).watcher;
  if (!inner) throw new Error('watcher not started');
  return inner as unknown as {
    _watched: Map<string, Set<string>>;
    _closers: Map<string, unknown[]>;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('B1.1 SessionWatcher retention for deleted files', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('unlink retires the debounce slot and every per-path map (add then unlink inside the window)', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'sw-retain-debounce-'));
    const filePath = path.join(tempDir, 'timestamp_dead.jsonl');
    await writeFile(filePath, sessionLine('dead-session'));

    const watcher = new SessionWatcher(tempDir, undefined, { debounceDelay: 40 });
    const maps = internals(watcher);
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'unlink', filePath: string): void;
    };

    invoke.handleChange('add', filePath);
    expect(maps.debounceTimers.size).toBe(1);
    await rm(filePath);
    invoke.handleChange('unlink', filePath);

    // Wait past the debounce window: a dead entry survives here for ever on the
    // pre-fix code because the unlink branch never deletes it.
    await sleep(120);

    expect(maps.debounceTimers.size).toBe(0);
    expect(maps.readStateByPath.size).toBe(0);
    expect(maps.sessionIdsByPath.size).toBe(0);
    expect(maps.pendingInfoByPath.size).toBe(0);
    await watcher.stop();
  });

  it('repeated add/unlink cycles leave the debounce map at its pre-churn size', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'sw-retain-cycles-'));
    const watcher = new SessionWatcher(tempDir, undefined, { debounceDelay: 30 });
    const maps = internals(watcher);
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'unlink', filePath: string): void;
    };

    const before = maps.debounceTimers.size;
    for (let i = 0; i < 25; i += 1) {
      const filePath = path.join(tempDir, `timestamp_cycle_${i}.jsonl`);
      await writeFile(filePath, sessionLine(`cycle-${i}`));
      invoke.handleChange('add', filePath);
      await rm(filePath);
      invoke.handleChange('unlink', filePath);
    }
    await sleep(150);

    expect(maps.debounceTimers.size).toBe(before);
    expect(maps.readStateByPath.size).toBe(0);
    expect(maps.sessionIdsByPath.size).toBe(0);
    await watcher.stop();
  });

  it('a live chokidar watcher retains no per-file watch state for files unlinked before they stabilise', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'sw-retain-chokidar-'));
    const sessionsDir = path.join(tempDir, 'sessions');
    const childDir = path.join(sessionsDir, '--path--', 'tmp', 'retention-workspace');
    await mkdir(childDir, { recursive: true });

    const watcher = new SessionWatcher(sessionsDir, undefined, { debounceDelay: 120 });
    const maps = internals(watcher);
    const events: Array<{ type: string; path: string }> = [];
    watcher.on('session_update', (event) => events.push({ type: event.type, path: event.path }));
    watcher.start();

    // Let chokidar finish its initial (ignoreInitial) index before churn.
    await sleep(250);
    const ck = chokidarInternals(watcher);
    const watchedFileKeys = () => [...ck._watched.keys()].filter((key) => key.endsWith('.jsonl') && !key.includes('*'));
    const closersBefore = ck._closers.size;
    const fileKeysBefore = watchedFileKeys().length;

    const churned: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const filePath = path.join(childDir, `timestamp_churn_${i}.jsonl`);
      await writeFile(filePath, sessionLine(`churn-${i}`));
      // Delete well inside chokidar's former 300 ms stability threshold, so on
      // the pre-fix build the add was never declared stable.
      await sleep(5);
      await rm(filePath);
      churned.push(filePath);
    }

    // Allow the directory readdir diff and any deferred timers to settle.
    await sleep(1500);

    const fileKeysAfter = watchedFileKeys();
    expect(fileKeysAfter).toEqual([]);
    expect(ck._closers.size).toBe(closersBefore);
    expect(fileKeysBefore).toBe(0);

    // Watcher-owned per-path state must also be empty.
    expect(maps.debounceTimers.size).toBe(0);
    expect(maps.readStateByPath.size).toBe(0);
    expect(maps.sessionIdsByPath.size).toBe(0);
    expect(maps.pendingInfoByPath.size).toBe(0);

    // Behaviour: the churn must still reach consumers. Every churned file is
    // unlinked, so each must produce an unlink (and never a phantom add).
    const unlinked = new Set(events.filter((event) => event.type === 'unlink').map((event) => event.path));
    expect([...churned].every((filePath) => unlinked.has(filePath))).toBe(true);

    await watcher.stop();
  });
});
