import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Controllable spawn mock: counts subprocess spawns. An already-aborted turn
 * must not spawn at all (runAgy checks the signal before spawn).
 */
const ctrl = vi.hoisted(() => ({ spawnCount: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      ctrl.spawnCount++;
      const child = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      (child as unknown as { kill: () => void }).kill = vi.fn();
      return child;
    }),
  };
});

import { runAgy } from '../../../src/antigravity/antigravity-service.js';

/**
 * L6: an aborted Antigravity turn must not spawn a subprocess. This is the
 * spawn-level guarantee behind "abort cancels a pending retry / prevents a
 * later subprocess spawn": the retry loop may call runAgy again, but runAgy
 * refuses to spawn once the turn's abort signal is set. (The service's
 * per-turn AbortController + retry-loop abort check are exercised by the
 * existing antigravity-service suite; this pins the runAgy seam directly so
 * the behaviour is deterministic and independent of the conversations-dir
 * preamble.)
 */
describe('L6: runAgy abort prevents subprocess spawn', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agy-runAgy-abort-'));
    ctrl.spawnCount = 0;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns reason "aborted" without spawning when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await runAgy(['-p', 'hi'], tmp, 60_000, undefined, undefined, ac.signal);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('aborted');
    expect(ctrl.spawnCount).toBe(0); // no subprocess spawned for an aborted turn
  });

  it('spawns normally for a non-aborted turn', async () => {
    const ac = new AbortController();
    // Don't await completion (the mock's child never closes); just confirm spawn.
    const pending = runAgy(['-p', 'hi'], tmp, 60_000, undefined, undefined, ac.signal);
    // Yield so the synchronous spawn inside runAgy runs.
    await new Promise((r) => setImmediate(r));
    expect(ctrl.spawnCount).toBe(1);
    ac.abort(); // settle the pending runAgy so the test doesn't hang.
    await pending;
  });
});
