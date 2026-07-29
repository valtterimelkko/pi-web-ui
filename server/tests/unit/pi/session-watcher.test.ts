import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionWatcher } from '../../../src/pi/session-watcher.js';

describe('SessionWatcher canonical metadata', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('preserves the canonical id when add is immediately followed by unlink', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-race-'));
    const sessionPath = path.join(tempDir, 'timestamp_filename.jsonl');
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'canonical-race-id', cwd: '/tmp/race' }));
    const watcher = new SessionWatcher(tempDir);
    const events: Array<{ type: string; sessionId?: string }> = [];
    watcher.on('session_update', (event) => events.push(event));
    const invoke = watcher as unknown as { handleChange(type: 'add' | 'unlink', filePath: string): void };

    invoke.handleChange('add', sessionPath);
    await rm(sessionPath);
    invoke.handleChange('unlink', sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events.find((event) => event.type === 'unlink')?.sessionId).toBe('canonical-race-id');
    await watcher.stop();
  });

  it('upserts an exact registry entry on add without triggering a directory-wide scan', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-registry-'));
    const sessionPath = path.join(tempDir, '2026-07-29T00-00-00_canonical-add-id.jsonl');
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'canonical-add-id', cwd: '/tmp/add', timestamp: 1 }));
    const registry = {
      upsert: vi.fn().mockResolvedValue(undefined),
      rebuildFromPiSessions: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = new SessionWatcher(tempDir, registry);
    const invoke = watcher as unknown as { emitChange(type: 'add', filePath: string): Promise<void> };

    await invoke.emitChange('add', sessionPath);

    expect(registry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'canonical-add-id',
      sdkType: 'pi',
      path: sessionPath,
      cwd: '/tmp/add',
    }));
    expect(registry.rebuildFromPiSessions).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('uses the JSONL session header id and cwd rather than the filename fallback', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-'));
    const sessionPath = path.join(tempDir, 'timestamp_filename.jsonl');
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session', id: 'canonical-session-id', cwd: '/tmp/canonical-workspace', timestamp: 1 }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: 2, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n'));

    const info = await new SessionWatcher(tempDir).readSessionInfo(sessionPath);

    expect(info.id).toBe('canonical-session-id');
    expect(info.cwd).toBe('/tmp/canonical-workspace');
    expect(info.firstMessage).toBe('hello');
  });
});
