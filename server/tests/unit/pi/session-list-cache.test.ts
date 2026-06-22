import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parsePiSessionInfo,
  PiSessionListCache,
} from '../../../src/pi/session-list-cache.js';

/**
 * PiSessionListCache replaces the `SessionManager.listAll()` scan in
 * handleGetSessions (connection.ts:1894). That scan JSON-parses every on-disk
 * session (~4s for ~826 files) on every page load / reconnect. The cache keeps
 * lightweight per-file metadata keyed on mtime and re-parses ONLY changed files.
 *
 * parsePiSessionInfo mirrors the SDK's buildSessionInfo field semantics so the
 * sidebar data (messageCount / firstMessage / ordering) is unchanged.
 */

const hdr = (id: string, cwd: string, ts = '2026-01-01T00:00:00.000Z', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd, ...extra }) + '\n';
const infoLine = (name: string) => JSON.stringify({ type: 'session_info', name }) + '\n';
const msg = (role: string, content: unknown, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role, content, ...extra } }) + '\n';

const withTempTree = async <T>(fn: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), 'pi-list-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// sessions live under <root>/<encoded-cwd>/<file>.jsonl, matching the SDK layout
const sessionFile = (root: string, cwdKey: string, id: string) => {
  const dir = join(root, cwdKey);
  return { dir, file: join(dir, `${id}.jsonl`) };
};
const writeSession = async (root: string, cwdKey: string, id: string, content: string, mtime: Date = new Date()) => {
  const { dir, file } = sessionFile(root, cwdKey, id);
  await mkdir(dir, { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtime, mtime);
  return file;
};

describe('parsePiSessionInfo', () => {
  it('extracts id, cwd and createdAt from the header', async () => {
    await withTempTree(async (root) => {
      const file = await writeSession(root, '--root-proj--', 's1', hdr('s1', '/root/proj', '2026-01-01T00:00:00.000Z'));
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info).not.toBeNull();
      expect(info!.id).toBe('s1');
      expect(info!.cwd).toBe('/root/proj');
      expect(info!.createdMs).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
    });
  });

  it('counts every message entry, including ones without content', async () => {
    await withTempTree(async (root) => {
      const content =
        hdr('s2', '/x') +
        msg('user', 'hi', '2026-01-01T00:00:01.000Z') +
        JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'tool' } }) + '\n' +
        msg('assistant', 'hello', '2026-01-01T00:00:03.000Z');
      const file = await writeSession(root, '--x--', 's2', content, new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.messageCount).toBe(3);
    });
  });

  it('firstMessage = text of the first user message with text content', async () => {
    await withTempTree(async (root) => {
      const content =
        hdr('s3', '/x') +
        // assistant first (not a user message) — ignored for firstMessage
        msg('assistant', 'greeting', '2026-01-01T00:00:01.000Z') +
        // first user message with text content
        msg('user', 'build a thing', '2026-01-01T00:00:02.000Z') +
        msg('user', 'later', '2026-01-01T00:00:03.000Z');
      const file = await writeSession(root, '--x--', 's3', content, new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.firstMessage).toBe('build a thing');
    });
  });

  it('extracts text from array content blocks (matching SDK extractTextContent)', async () => {
    await withTempTree(async (root) => {
      const content =
        hdr('s4', '/x') +
        msg('user', [{ type: 'text', text: 'part-a' }, { type: 'tool_use', id: 't' }, { type: 'text', text: 'part-b' }], '2026-01-01T00:00:01.000Z');
      const file = await writeSession(root, '--x--', 's4', content, new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.firstMessage).toBe('part-a part-b');
    });
  });

  it('lastActivity = max message activity time, falling back to header then mtime', async () => {
    await withTempTree(async (root) => {
      const content =
        hdr('s5', '/x', '2026-01-01T00:00:00.000Z') +
        msg('user', 'a', '2026-01-01T00:00:10.000Z') +
        msg('assistant', 'b', '2026-01-01T00:00:05.000Z'); // out of order; max wins
      const file = await writeSession(root, '--x--', 's5', content, new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.lastActivityMs).toBe(new Date('2026-01-01T00:00:10.000Z').getTime());
    });

    // fallback to header timestamp when there are no messages
    await withTempTree(async (root) => {
      const file = await writeSession(root, '--x--', 's5b', hdr('s5b', '/x', '2026-02-01T00:00:00.000Z'), new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.lastActivityMs).toBe(new Date('2026-02-01T00:00:00.000Z').getTime());
    });
  });

  it('name = latest session_info entry (trimmed; empty clears)', async () => {
    await withTempTree(async (root) => {
      const content =
        hdr('s6', '/x') +
        infoLine('First Name') +
        infoLine('   Second Name   ') +
        msg('user', 'hi', '2026-01-01T00:00:01.000Z');
      const file = await writeSession(root, '--x--', 's6', content, new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.name).toBe('Second Name');
    });
  });

  it('firstMessage defaults to "(no messages)" when there is no user text', async () => {
    await withTempTree(async (root) => {
      const file = await writeSession(root, '--x--', 's7', hdr('s7', '/x'), new Date());
      const info = await parsePiSessionInfo(file, Date.now());
      expect(info!.firstMessage).toBe('(no messages)');
      expect(info!.messageCount).toBe(0);
    });
  });

  it('returns null when the first entry is not a session header', async () => {
    await withTempTree(async (root) => {
      const file = await writeSession(root, '--x--', 's8', msg('user', 'hi', '2026-01-01T00:00:00.000Z'), new Date());
      expect(await parsePiSessionInfo(file, Date.now())).toBeNull();
    });
  });

  it('returns null for a missing file without throwing', async () => {
    expect(await parsePiSessionInfo(join(tmpdir(), `missing-${process.pid}.jsonl`), Date.now())).toBeNull();
  });
});

describe('PiSessionListCache', () => {
  it('cold list parses files under <dir>/<cwdKey>/*.jsonl and sorts by lastActivity desc', async () => {
    await withTempTree(async (root) => {
      await writeSession(root, '--a--', 'old', hdr('old', '/a', '2026-01-01T00:00:00.000Z') + msg('user', 'x', '2026-01-01T00:00:01.000Z'), new Date('2026-01-01'));
      await writeSession(root, '--b--', 'new', hdr('new', '/b', '2026-06-01T00:00:00.000Z') + msg('user', 'y', '2026-06-01T00:00:01.000Z'), new Date('2026-06-01'));
      const cache = new PiSessionListCache(root);
      const list = await cache.list();
      expect(list.map((s) => s.id)).toEqual(['new', 'old']);
      expect(list[0].sdkType).toBe('pi');
    });
  });

  it('warm list (no file changes) returns cached WITHOUT re-parsing', async () => {
    await withTempTree(async (root) => {
      await writeSession(root, '--a--', 's', hdr('s', '/a') + msg('user', 'hi', '2026-01-01T00:00:01.000Z'), new Date());
      const parseSpy = vi.fn(async (p: string, m: number) => parsePiSessionInfo(p, m));
      const cache = new PiSessionListCache(root, parseSpy);
      await cache.list();
      const callsAfterCold = parseSpy.mock.calls.length;
      expect(callsAfterCold).toBeGreaterThan(0);
      await cache.list(); // nothing changed
      expect(parseSpy.mock.calls.length).toBe(callsAfterCold); // no re-parse
    });
  });

  it('a changed file (new mtime) is re-parsed and reflects new metadata', async () => {
    await withTempTree(async (root) => {
      const { file } = sessionFile(root, '--a--', 's');
      await writeSession(root, '--a--', 's', hdr('s', '/a') + msg('user', 'first', '2026-01-01T00:00:01.000Z'), new Date('2026-01-01'));
      const parseSpy = vi.fn(async (p: string, m: number) => parsePiSessionInfo(p, m));
      const cache = new PiSessionListCache(root, parseSpy);
      let list = await cache.list();
      expect(list[0].messageCount).toBe(1);
      const callsBefore = parseSpy.mock.calls.length;

      // append a message and bump mtime
      await appendFile(file, msg('user', 'second', '2026-02-01T00:00:02.000Z'));
      await utimes(file, new Date('2026-02-01'), new Date('2026-02-01'));

      list = await cache.list();
      expect(list[0].messageCount).toBe(2); // reflects the appended message
      expect(parseSpy.mock.calls.length).toBe(callsBefore + 1); // only this file re-parsed
    });
  });

  it('a deleted file is removed from the result', async () => {
    await withTempTree(async (root) => {
      const { file } = sessionFile(root, '--a--', 'gone');
      await writeSession(root, '--a--', 'gone', hdr('gone', '/a') + msg('user', 'x', '2026-01-01T00:00:01.000Z'), new Date('2026-01-01'));
      await writeSession(root, '--b--', 'keep', hdr('keep', '/b') + msg('user', 'y', '2026-01-01T00:00:01.000Z'), new Date('2026-01-01'));
      const cache = new PiSessionListCache(root);
      expect((await cache.list()).map((s) => s.id).sort()).toEqual(['gone', 'keep']);
      await rm(file);
      expect((await cache.list()).map((s) => s.id)).toEqual(['keep']);
    });
  });

  it('a new file is added on the next list', async () => {
    await withTempTree(async (root) => {
      const cache = new PiSessionListCache(root);
      expect((await cache.list()).length).toBe(0);
      await writeSession(root, '--a--', 'fresh', hdr('fresh', '/a') + msg('user', 'hi', '2026-01-01T00:00:01.000Z'), new Date('2026-01-01'));
      expect((await cache.list()).map((s) => s.id)).toEqual(['fresh']);
    });
  });

  it('concurrent list() calls share a single reconcile (single-flight)', async () => {
    await withTempTree(async (root) => {
      await writeSession(root, '--a--', 's', hdr('s', '/a') + msg('user', 'hi', '2026-01-01T00:00:01.000Z'), new Date());
      const parseSpy = vi.fn(async (p: string, m: number) => parsePiSessionInfo(p, m));
      const cache = new PiSessionListCache(root, parseSpy);
      const [a, b] = await Promise.all([cache.list(), cache.list()]);
      expect(a).toEqual(b);
      expect(parseSpy.mock.calls.length).toBe(1); // parsed once, not twice
    });
  });
});
