/**
 * Wave K (contract 1.59.0) — R4 interruption overlay tests.
 *
 * A non-continued (and, until the engine writes again, a continuing) stop
 * surfaces as `status: "paused"`, `pausedReason: "interrupted"` plus the
 * additive `interruption` object — never a new top-level canonical status.
 * The overlay is durable, survives restarts, and clears when the goal file
 * changes (resume, clear, a new start, or the goal engine's own write), so a
 * parent's ordinary `POST /goal {"action":"resume"}` keeps working.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterruptionOverlayStore, applyInterruptionOverlay } from '../../../../src/internal-api/goal/interruption-overlay.js';
import { readProjectPiGoalState, piGoalStatePath } from '../../../../src/internal-api/goal/pi-goal.js';
import { configureInterruptionOverlayForTests, resetInterruptionOverlayForTests } from '../../../../src/internal-api/goal/interruption-overlay.js';
import { evaluatePiGoalActionTransition } from '../../../../src/internal-api/goal/goal-actions.js';
import { goalFingerprint } from '../../../../src/internal-api/goal/continue-marker.js';
import type { SessionGoalProjection } from '../../../../src/internal-api/goal/types.js';

const SESSION = '/tmp/fake-pi-sessions/s1.jsonl';

async function writeGoalState(state: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(path.dirname(piGoalStatePath(SESSION)), { recursive: true });
  await fsp.writeFile(piGoalStatePath(SESSION), JSON.stringify(state), 'utf8');
}

const RUNNING_STATE = {
  objective: 'finish the lane',
  status: 'running',
  turnCount: 3,
  startedAt: 1000,
  completedAt: null,
};

describe('interruption overlay store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-overlay-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('persists across a new store instance over the same directory (restart survival)', async () => {
    const first = createInterruptionOverlayStore(dir);
    await first.set({ sessionId: 'pi-a', fingerprint: 'fp1', cause: 'restart_interruption', source: 'boot_orphan', detectedAt: 5, goalFile: { mtimeMs: 10, size: 20 } });
    const second = createInterruptionOverlayStore(dir);
    const record = await second.get('pi-a');
    expect(record?.cause).toBe('restart_interruption');
    expect(record?.goalFile).toEqual({ mtimeMs: 10, size: 20 });
  });

  it('clear removes the record', async () => {
    const store = createInterruptionOverlayStore(dir);
    await store.set({ sessionId: 'pi-a', fingerprint: 'fp1', cause: 'provider_abort', source: 'provider_abort', detectedAt: 5, goalFile: { mtimeMs: 1, size: 2 } });
    await store.clear('pi-a');
    expect(await store.get('pi-a')).toBeNull();
  });
});

describe('applyInterruptionOverlay (pure)', () => {
  const running: SessionGoalProjection = { supported: true, status: 'running', objective: 'x' };
  const overlay = {
    sessionId: 'pi-a', fingerprint: 'fp', cause: 'restart_interruption' as const, source: 'boot_orphan' as const,
    detectedAt: 42, continueCount: 0, goalFile: { mtimeMs: 10, size: 20 },
  };

  it('projects a running goal as paused/interrupted with the interruption object', () => {
    const out = applyInterruptionOverlay(running, overlay, { mtimeMs: 10, size: 20 });
    expect(out.status).toBe('paused');
    expect(out.pausedReason).toBe('interrupted');
    expect(out.interruption).toMatchObject({ cause: 'restart_interruption', source: 'boot_orphan', detectedAt: 42, continueCount: 0 });
  });

  it('leaves the projection alone when the goal file changed since detection (engine write)', () => {
    const out = applyInterruptionOverlay(running, overlay, { mtimeMs: 99, size: 20 });
    expect(out.status).toBe('running');
    expect(out.interruption).toBeUndefined();
  });

  it('passes a genuinely paused goal through untouched apart from the interruption annotation', () => {
    const paused: SessionGoalProjection = { supported: true, status: 'paused', pausedReason: 'restored_on_session_start' };
    const out = applyInterruptionOverlay(paused, overlay, { mtimeMs: 10, size: 20 });
    expect(out.status).toBe('paused');
    expect(out.pausedReason).toBe('interrupted');
    expect(out.interruption?.cause).toBe('restart_interruption');
  });

  it('a second-transient overlay (past continue, not continued now) reads paused/interrupted on re-application', () => {
    const second = { ...overlay, continueCount: 1, autoContinued: false, cause: 'second_transient' as const };
    const out = applyInterruptionOverlay(running, second, { mtimeMs: 10, size: 20 }, { currentFingerprint: 'fp' });
    expect(out.status).toBe('paused');
    expect(out.pausedReason).toBe('interrupted');
    expect(out.interruption).toMatchObject({ cause: 'second_transient', autoContinued: false, continueCount: 1 });
  });

  it('annotates an auto-continued projection without changing its running status', () => {
    const continued = { ...overlay, continueCount: 1, autoContinued: true, continueNote: '[auto-continue] restarted' };
    const out = applyInterruptionOverlay(running, continued, { mtimeMs: 10, size: 20 }, { autoContinued: true, currentFingerprint: 'fp' });
    expect(out.status).toBe('running');
    expect(out.interruption).toMatchObject({ autoContinued: true, continueCount: 1, cause: 'restart_interruption' });
  });
});

describe('applyInterruptionOverlay — correction 03 C5 fingerprint binding', () => {
  const running: SessionGoalProjection = { supported: true, status: 'running', objective: 'goal A', startedAt: 1000 };
  const overlay = {
    sessionId: 'pi-a', fingerprint: 'fp-A', cause: 'restart_interruption' as const, source: 'boot_orphan' as const,
    detectedAt: 42, continueCount: 1, autoContinued: true, goalFile: { mtimeMs: 10, size: 20 },
  };

  it('never anchors to a goal whose fingerprint differs from the marker (goal B running)', () => {
    const out = applyInterruptionOverlay(running, overlay, { mtimeMs: 10, size: 20 }, { currentFingerprint: 'fp-B' });
    expect(out.status).toBe('running');
    expect(out.interruption).toBeUndefined();
  });

  it('applies when the current fingerprint matches, regardless of mtime-only equality', () => {
    const out = applyInterruptionOverlay(running, overlay, { mtimeMs: 10, size: 20 }, { currentFingerprint: 'fp-A' });
    expect(out.interruption?.autoContinued).toBe(true);
  });

  it('a missing current fingerprint (unreadable goal) is treated as a mismatch', () => {
    const out = applyInterruptionOverlay(running, overlay, { mtimeMs: 10, size: 20 }, { currentFingerprint: undefined });
    expect(out.interruption).toBeUndefined();
  });
});

describe('readProjectPiGoalState integration', () => {
  let home: string;
  let overlayDir: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'k-home-'));
    overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-overlay-root-'));
    process.env.HOME = home;
    configureInterruptionOverlayForTests(overlayDir);
  });
  afterEach(() => {
    resetInterruptionOverlayForTests();
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(overlayDir, { recursive: true, force: true });
  });

  it('overlays a running goal as paused/interrupted until the engine writes again', async () => {
    await writeGoalState(RUNNING_STATE);
    const plain = await readProjectPiGoalState(SESSION);
    expect(plain.status).toBe('running');

    const store = createInterruptionOverlayStore(path.join(overlayDir, 'overlay'));
    const stat = await fsp.stat(piGoalStatePath(SESSION));
    const fp = goalFingerprint(RUNNING_STATE.objective, RUNNING_STATE.startedAt);
    await store.set({ sessionId: SESSION, fingerprint: fp, cause: 'restart_interruption', source: 'boot_orphan', detectedAt: 7, goalFile: { mtimeMs: stat.mtimeMs, size: stat.size } });

    const overlaid = await readProjectPiGoalState(SESSION);
    expect(overlaid.status).toBe('paused');
    expect(overlaid.pausedReason).toBe('interrupted');
    expect(overlaid.interruption?.cause).toBe('restart_interruption');

    // The goal engine writes (e.g. the restore pause on rehydration): the
    // overlay must vanish and the projection must read the disk truth again.
    await writeGoalState({ ...RUNNING_STATE, status: 'paused', pauseReason: 'restored_on_session_start' });
    const afterWrite = await readProjectPiGoalState(SESSION);
    expect(afterWrite.status).toBe('paused');
    expect(afterWrite.pausedReason).toBe('restored_on_session_start');
    expect(afterWrite.interruption).toBeUndefined();
    expect(await store.get(SESSION)).toBeNull();
  });

  it('a parent resume transition evaluates as applied across the overlay', async () => {
    await writeGoalState(RUNNING_STATE);
    const store = createInterruptionOverlayStore(path.join(overlayDir, 'overlay'));
    const stat = await fsp.stat(piGoalStatePath(SESSION));
    const fpResume = goalFingerprint(RUNNING_STATE.objective, RUNNING_STATE.startedAt);
    await store.set({ sessionId: SESSION, fingerprint: fpResume, cause: 'restart_interruption', source: 'boot_orphan', detectedAt: 7, goalFile: { mtimeMs: stat.mtimeMs, size: stat.size } });

    const before = await readProjectPiGoalState(SESSION);
    expect(before.status).toBe('paused'); // overlay view

    // Parent resumes: engine writes running (file changes → overlay clears).
    // turnCount must change the file SIZE (3 → 44), not just a same-width
    // digit: the overlay treats |Δmtime| < 1ms && equal size as "no engine
    // write", and on a fast CI runner back-to-back same-size writes can share
    // an mtime millisecond, which surfaced as the 2026-10-04 CI flake
    // (applied:false, reason:'stayed_paused'). A size change clears the
    // overlay deterministically regardless of mtime granularity.
    await writeGoalState({ ...RUNNING_STATE, status: 'running', turnCount: 44 });
    const after = await readProjectPiGoalState(SESSION);
    const outcome = evaluatePiGoalActionTransition({ action: 'resume', before, after });
    expect(outcome).toEqual({ applied: true, failure: false });
  });
});
