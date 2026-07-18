import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SessionWatcher,
  startSessionWatcher,
  stopSessionWatcher,
} from '../../../src/pi/session-watcher.js';

/**
 * L5: app-level session-watcher listeners must be symmetric (start registers,
 * stop removes) so repeated initialisation does not multiply listeners and a
 * stopped watcher never broadcasts.
 */
describe('L5: SessionWatcher listener cleanup + no post-shutdown broadcast', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'sw-l5-'));
    await stopSessionWatcher(); // ensure the module singleton is cleared
  });
  afterEach(async () => {
    await stopSessionWatcher();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stop() removes all listeners (symmetric cleanup)', async () => {
    const w = new SessionWatcher(tempDir);
    w.start();
    w.on('session_update', () => {});
    w.on('error', () => {});
    expect(w.listenerCount('session_update')).toBe(1);
    expect(w.listenerCount('error')).toBe(1);

    await w.stop();

    expect(w.listenerCount('session_update')).toBe(0);
    expect(w.listenerCount('error')).toBe(0);
  });

  it('repeated start/attach/stop cycles do not accumulate listeners', async () => {
    const w = new SessionWatcher(tempDir);
    for (let i = 0; i < 5; i++) {
      w.start();
      w.on('session_update', () => {});
      expect(w.listenerCount('session_update')).toBe(1);
      await w.stop();
      expect(w.listenerCount('session_update')).toBe(0);
    }
  });

  it('does not broadcast after stop (handleChange is a no-op on a stopped watcher)', async () => {
    const w = new SessionWatcher(tempDir);
    w.start();
    const events: Array<{ type: string }> = [];
    w.on('session_update', (e) => events.push(e));
    await w.stop();
    // Re-attach to prove the watcher itself does not emit post-stop (if it did,
    // a fresh listener would still receive nothing because emit is suppressed).
    w.on('session_update', (e) => events.push(e));

    const invoke = w as unknown as { handleChange(type: 'add', filePath: string): void };
    invoke.handleChange('add', path.join(tempDir, 'x.jsonl'));
    await new Promise((r) => setTimeout(r, 30));

    expect(events).toHaveLength(0);
  });

  it('an in-flight metadata read cannot repopulate maps after stop', async () => {
    const file = path.join(tempDir, 'x.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session', id: 'x', cwd: tempDir }) + '\n');
    const w = new SessionWatcher(tempDir);
    w.start();
    let resolveRead!: (value: Awaited<ReturnType<SessionWatcher['readSessionInfo']>>) => void;
    const pending = new Promise<Awaited<ReturnType<SessionWatcher['readSessionInfo']>>>((resolve) => {
      resolveRead = resolve;
    });
    w.readSessionInfo = () => pending;

    const invoke = w as unknown as { handleChange(type: 'add', filePath: string): void };
    invoke.handleChange('add', file);
    await w.stop();
    resolveRead({
      id: 'x', path: file, cwd: tempDir, firstMessage: '', messageCount: 0,
      createdAt: new Date(0), lastActivity: new Date(0),
    });
    await pending;
    await Promise.resolve();

    const maps = w as unknown as {
      sessionIdsByPath: Map<string, string>;
      pendingInfoByPath: Map<string, Promise<unknown>>;
    };
    expect(maps.sessionIdsByPath.size).toBe(0);
    expect(maps.pendingInfoByPath.size).toBe(0);
  });

  it('stopSessionWatcher nulls the singleton so a re-start is a fresh instance', async () => {
    const w1 = startSessionWatcher(tempDir);
    w1.on('session_update', () => {});
    await stopSessionWatcher();
    expect(w1.listenerCount('session_update')).toBe(0);

    const w2 = startSessionWatcher(tempDir);
    expect(w2).not.toBe(w1); // fresh instance, no carried-over listeners
    expect(w2.listenerCount('session_update')).toBe(0);
    await stopSessionWatcher();
  });
});
