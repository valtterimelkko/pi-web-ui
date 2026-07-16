import { afterEach, describe, expect, it } from 'vitest';
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
