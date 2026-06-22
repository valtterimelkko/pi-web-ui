import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSessionCwd } from '../../../src/pi/session-cwd.js';

/**
 * readSessionCwd reads the cwd for a single Pi session from its file header
 * (the first JSONL line, type:"session") WITHOUT scanning all on-disk sessions.
 *
 * It replaces a `SessionManager.listAll()` scan that parsed every session file
 * (~4s for ~800 sessions) just to look up one cwd, at:
 *   - server/src/websocket/connection.ts:1553  (handleSwitchSession, browser switch)
 *   - server/src/pi/session-pool.ts:93          (switchClientSession, extension switch)
 *
 * The cwd is authoritative in the file header, so this is correct AND O(1-file).
 */
describe('readSessionCwd', () => {
  const headerWith = (cwd: string) =>
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'abc',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd,
    });

  const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-cwd-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('reads the cwd from the session header line', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, '2026_s.jsonl');
      await writeFile(file, headerWith('/root/pi-web-ui') + '\n{"type":"message"}\n');
      expect(await readSessionCwd(file)).toBe('/root/pi-web-ui');
    });
  });

  it('preserves literal dashes in cwd (a lossy path-decode would corrupt this)', async () => {
    // Regression guard: the SDK encodes cwd into the dir name by replacing
    // / \ : with "-", which is LOSSY. cwd /root/pi-web-ui must NOT decode to
    // /root/pi/web/ui. Reading the authoritative header avoids this entirely.
    await withTempDir(async (dir) => {
      const file = join(dir, 's.jsonl');
      await writeFile(file, headerWith('/root/pi-web-ui') + '\n');
      const cwd = await readSessionCwd(file);
      expect(cwd).toBe('/root/pi-web-ui');
      expect(cwd).not.toBe('/root/pi/web/ui');
    });
  });

  it('returns undefined when the header has no cwd field', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 's.jsonl');
      await writeFile(file, JSON.stringify({ type: 'session', version: 3 }) + '\n');
      expect(await readSessionCwd(file)).toBeUndefined();
    });
  });

  it('returns undefined when the first entry is not a session header', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 's.jsonl');
      await writeFile(file, JSON.stringify({ type: 'message', role: 'user' }) + '\n');
      expect(await readSessionCwd(file)).toBeUndefined();
    });
  });

  it('returns undefined for a missing file without throwing', async () => {
    const missing = join(tmpdir(), `definitely-missing-${process.pid}.jsonl`);
    expect(await readSessionCwd(missing)).toBeUndefined();
  });

  it('resolves from the header of a large file without reading every line', async () => {
    // A multi-MB session must resolve cwd from its header only; this guards
    // against any future change that reads the whole file.
    await withTempDir(async (dir) => {
      const file = join(dir, 'big.jsonl');
      const padding = JSON.stringify({ type: 'message', content: 'x'.repeat(2000) }) + '\n';
      let content = headerWith('/root/tasks') + '\n';
      for (let i = 0; i < 3000; i++) content += padding;
      await writeFile(file, content);
      expect(await readSessionCwd(file)).toBe('/root/tasks');
    });
  });
});
