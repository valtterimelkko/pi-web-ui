import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Wrap real fs.promises but count chmod calls, to prove the store repairs mode
 * at most once per session file (not on every append).
 */
const chmodCalls = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: ((...args: unknown[]) => {
      chmodCalls(...args);
      return (actual.chmod as unknown as (...a: unknown[]) => Promise<void>)(...args);
    }) as unknown as typeof actual.chmod,
  };
});

import { AntigravitySessionStore } from '../../../src/antigravity/antigravity-session-store.js';

describe('P5: AntigravitySessionStore private mode + no repeated chmod', () => {
  let baseDir: string;

  beforeEach(async () => {
    chmodCalls.mockClear();
    baseDir = await fs.mkdtemp(join(tmpdir(), 'agy-p5-'));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('creates the session directory owner-only (0o700) when it does not exist', async () => {
    const dir = join(baseDir, 'fresh-session-dir');
    const store = new AntigravitySessionStore(dir);
    await store.ensureDir();
    const st = await fs.stat(dir);
    expect(st.mode & 0o077).toBe(0); // no group/other bits
  });

  it('creates a new session file owner-only (0o600)', async () => {
    const store = new AntigravitySessionStore(baseDir);
    await store.ensureDir();
    await store.appendTurn('s1', { prompt: 'hi', response: 'ho', model: 'm', conversationId: null, timestamp: 1 });
    const st = await fs.stat(join(baseDir, 's1.jsonl'));
    expect(st.mode & 0o077).toBe(0);
  });

  it('repairs a legacy world-readable file to 0o600 once, not on every append', async () => {
    const store = new AntigravitySessionStore(baseDir);
    await store.ensureDir();
    // Hand-create a legacy 0o644 file (as an older version would have).
    const file = join(baseDir, 'legacy.jsonl');
    await fs.writeFile(file, '', { mode: 0o644 });
    expect((await fs.stat(file)).mode & 0o077).not.toBe(0); // group/other bits set

    // First append repairs the mode.
    await store.appendTurn('legacy', { prompt: 'a', response: 'b', model: 'm', conversationId: null, timestamp: 1 });
    expect((await fs.stat(file)).mode & 0o077).toBe(0); // repaired to 0o600

    // Four more appends: chmod must NOT be called again (already verified).
    chmodCalls.mockClear();
    for (let i = 0; i < 4; i++) {
      await store.appendTurn('legacy', { prompt: `a${i}`, response: `b${i}`, model: 'm', conversationId: null, timestamp: i + 2 });
    }
    expect(chmodCalls).not.toHaveBeenCalled();

    // Append ordering preserved: lines are in append order.
    const history = await store.loadHistory('legacy');
    expect(history.map((t) => t.prompt)).toEqual(['a', 'a0', 'a1', 'a2', 'a3']);
  });
});
