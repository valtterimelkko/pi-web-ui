import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Wrap real fs.promises but count chmod calls, to prove the store repairs mode
 * at most once per session file (not on every append).
 */
const { chmodCalls, writeCalls, failNextAppend, atomicGate } = vi.hoisted(() => ({
  chmodCalls: vi.fn(),
  writeCalls: vi.fn(),
  failNextAppend: { value: false },
  atomicGate: {
    pause: false,
    started: null as Promise<void> | null,
    signalStarted: null as (() => void) | null,
    release: null as (() => void) | null,
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: ((...args: unknown[]) => {
      chmodCalls(...args);
      return (actual.chmod as unknown as (...a: unknown[]) => Promise<void>)(...args);
    }) as unknown as typeof actual.chmod,
    writeFile: (async (...args: unknown[]) => {
      writeCalls(...args);
      const options = args[2] as { flag?: string } | undefined;
      if (options?.flag === 'a' && failNextAppend.value) {
        failNextAppend.value = false;
        throw Object.assign(new Error('simulated append failure'), { code: 'EIO' });
      }
      const file = String(args[0]);
      if (atomicGate.pause && file.endsWith('.tmp')) {
        atomicGate.pause = false;
        atomicGate.signalStarted?.();
        await new Promise<void>((resolve) => { atomicGate.release = resolve; });
      }
      return (actual.writeFile as unknown as (...a: unknown[]) => Promise<void>)(...args);
    }) as unknown as typeof actual.writeFile,
  };
});

import { AntigravitySessionStore } from '../../../src/antigravity/antigravity-session-store.js';

describe('P5: AntigravitySessionStore private mode + no repeated chmod', () => {
  let baseDir: string;

  beforeEach(async () => {
    chmodCalls.mockClear();
    writeCalls.mockClear();
    failNextAppend.value = false;
    atomicGate.pause = false;
    atomicGate.started = null;
    atomicGate.signalStarted = null;
    atomicGate.release = null;
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

  it('repairs an existing session directory that is not owner-only', async () => {
    const dir = join(baseDir, 'legacy-dir');
    await fs.mkdir(dir, { mode: 0o755 });
    expect((await fs.stat(dir)).mode & 0o077).not.toBe(0);

    const store = new AntigravitySessionStore(dir);
    await store.ensureDir();

    expect((await fs.stat(dir)).mode & 0o077).toBe(0);
  });

  it('creates a new session file owner-only (0o600)', async () => {
    const store = new AntigravitySessionStore(baseDir);
    await store.ensureDir();
    await store.appendTurn('s1', { prompt: 'hi', response: 'ho', model: 'm', conversationId: null, timestamp: 1 });
    const st = await fs.stat(join(baseDir, 's1.jsonl'));
    expect(st.mode & 0o077).toBe(0);
  });

  it('does not truncate an existing history file when append fails', async () => {
    const store = new AntigravitySessionStore(baseDir);
    const file = join(baseDir, 'existing.jsonl');
    const original = JSON.stringify({ turnId: 'old', prompt: 'old', response: 'ok', model: 'm', conversationId: null, timestamp: 1 }) + '\n';
    await fs.writeFile(file, original, { mode: 0o600 });
    writeCalls.mockClear();
    failNextAppend.value = true;

    await expect(store.appendTurn('existing', {
      prompt: 'new', response: 'no', model: 'm', conversationId: null, timestamp: 2,
    })).rejects.toThrow('simulated append failure');

    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(writeCalls.mock.calls.some((call) => (call[2] as { flag?: string } | undefined)?.flag === 'w')).toBe(false);
  });

  it('does not overwrite malformed existing history during finalization', async () => {
    const store = new AntigravitySessionStore(baseDir);
    const file = join(baseDir, 'malformed.jsonl');
    const original = '{"turnId":"old"}\nnot-json\n';
    await fs.writeFile(file, original, { mode: 0o600 });

    await expect(store.finalizeTurn('malformed', 'old', {
      status: 'done', response: 'replacement',
    })).rejects.toThrow();

    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('keeps the session file owner-only after atomic turn finalization', async () => {
    const store = new AntigravitySessionStore(baseDir);
    const turn = await store.appendTurn('finalize', {
      prompt: 'a', response: '', model: 'm', conversationId: null, timestamp: 1, status: 'running',
    });

    await store.finalizeTurn('finalize', turn.turnId, { status: 'done', response: 'b' });

    expect((await fs.stat(join(baseDir, 'finalize.jsonl'))).mode & 0o077).toBe(0);
  });

  it('serializes finalization with a concurrent append so neither turn is lost', async () => {
    const store = new AntigravitySessionStore(baseDir);
    const first = await store.appendTurn('serial', {
      prompt: 'first', response: '', model: 'm', conversationId: null, timestamp: 1, status: 'running',
    });
    atomicGate.started = new Promise<void>((resolve) => { atomicGate.signalStarted = resolve; });
    atomicGate.pause = true;

    const finalize = store.finalizeTurn('serial', first.turnId, { status: 'done', response: 'done' });
    await atomicGate.started;
    const append = store.appendTurn('serial', {
      prompt: 'second', response: 'next', model: 'm', conversationId: null, timestamp: 2,
    });
    await Promise.resolve();
    atomicGate.release?.();
    await Promise.all([finalize, append]);

    const history = await store.loadHistory('serial');
    expect(history.map((turn) => turn.prompt)).toEqual(['first', 'second']);
    expect(history[0].response).toBe('done');
  });

  it('bounds the verified-mode cache across many unique session files', async () => {
    const store = new AntigravitySessionStore(baseDir);
    for (let i = 0; i < 1100; i++) {
      await store.appendTurn(`cache-${i}`, {
        prompt: `${i}`, response: 'ok', model: 'm', conversationId: null, timestamp: i,
      });
    }

    const cache = (store as unknown as { modeVerified: Set<string> }).modeVerified;
    expect(cache.size).toBeLessThanOrEqual(1024);
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
