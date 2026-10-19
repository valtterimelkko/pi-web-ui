/**
 * Wave K correction 02 — wiring-level tests (F3 gating, F6 probe semantics).
 *
 * F3: live observers attach only to Internal API children (and only Pi).
 * F6: the R5 suppression probe matches the CURRENT goal fingerprint and a
 * continue CONFIRMED in this boot; a historical marker for an older goal, a
 * reserved (count-0) marker, and a pre-boot continue suppress nothing.
 *
 * D18 determinism: the session fixture lives in the test's own temp dir and
 * stamps its R1 last-activity instant from the process clock, so the sweep's
 * previous-lifetime gate can never be decided by filesystem-clock luck.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireGoalInterruptions, type GoalInterruptionWiring, type WiringRegistryEntry } from '../../../../src/internal-api/goal/interruption-wiring.js';
import { piGoalStatePath } from '../../../../src/internal-api/goal/pi-goal.js';
import fsp from 'node:fs/promises';
import type { SweepDispatchResult } from '../../../../src/internal-api/goal/interruption-sweep.js';
import type { SessionGoalProjection } from '../../../../src/internal-api/goal/types.js';

describe('goal interruption wiring (correction 02)', () => {
  let dir: string;
  let dispatches: number;
  let goalProjection: SessionGoalProjection | Record<string, unknown>;
  let wiring: GoalInterruptionWiring;

  const SESSION_ID = 'pi-child-1';

  /**
   * The session fixture lives inside the test's own temp dir, never at a shared
   * host path: a fixed `/tmp/sessions/…` file is written by every concurrent
   * run of this suite on the host (and by the sweep unit tests' candidate id),
   * so its R1 last-activity signal is not ours to control.
   */
  function sessionPath(): string {
    return path.join(dir, 'sessions', `${SESSION_ID}.jsonl`);
  }

  function registryEntry(): WiringRegistryEntry {
    return { id: SESSION_ID, path: sessionPath(), sdkType: 'pi', origin: 'internal-api' };
  }

  /**
   * Materialise the session transcript fixture and PIN its R1 last-activity
   * signal. The sweep's previous-lifetime gate compares this file's mtime with
   * the process clock (`Date.now()`), so the fixture derives the stamp from the
   * SAME clock instead of letting the filesystem decide: with a fresh write the
   * gate depends on filesystem-clock/process-clock agreement, and any worker
   * whose clock is mocked, frozen or stepped backwards silently dropped the
   * boot orphan as "last activity … outside the previous lifetime bound"
   * (D18 — one deploy failure at `expected +0 to be 1`).
   */
  const ACTIVITY_AGE_MS = 60_000;
  async function writeSessionFixture(): Promise<void> {
    await fsp.mkdir(path.dirname(sessionPath()), { recursive: true });
    await fsp.writeFile(sessionPath(), '', 'utf8');
    const activeAt = new Date(Date.now() - ACTIVITY_AGE_MS);
    await fsp.utimes(sessionPath(), activeAt, activeAt);
  }

  function build(entries: WiringRegistryEntry[], projection: SessionGoalProjection): void {
    goalProjection = projection;
    let markerDirCounter = 0;
    const runReceiptsRoot = path.join(dir, `run-${markerDirCounter++}`);
    wiring = wireGoalInterruptions({
      listRegistryEntries: async () => entries,
      isSessionBusy: () => false,
      dispatchPrompt: async (): Promise<SweepDispatchResult> => {
        dispatches += 1;
        return { outcome: 'accepted' };
      },
      brokerPublish: () => undefined,
      addExtensionUiObserver: () => undefined,
      removeExtensionUiObserver: () => undefined,
      markerDir: path.join(runReceiptsRoot, 'goal-continue', 'markers'),
      overlayDir: path.join(runReceiptsRoot, 'goal-continue', 'overlay'),
      logger: { info: () => undefined, warn: () => undefined },
      readGoalProjectionViaApi: async () => goalProjection,
      observeIntervalMs: 3_600_000,
    });
  }

  const orphanRunning: SessionGoalProjection = {
    supported: true, status: 'running', objective: 'goal A', startedAt: 1000,
    runtimeState: { objective: 'goal A', status: 'running', startedAt: 1000 },
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-wiring-'));
    dispatches = 0;
    // The Pi read path resolves the goal file under PI_WEB_UI_GOAL_HOME; point
    // it at the temp dir and materialise the goal file for the session key.
    process.env.PI_WEB_UI_GOAL_HOME = path.join(dir, 'goal-home');
    await fsp.mkdir(path.dirname(piGoalStatePath(sessionPath())), { recursive: true });
    await fsp.writeFile(piGoalStatePath(sessionPath()), JSON.stringify({
      objective: 'goal A', status: 'running', startedAt: 1000, turnCount: 2, completedAt: null,
    }), 'utf8');
    await writeSessionFixture();
  });
  afterEach(async () => {
    delete process.env.PI_WEB_UI_GOAL_HOME;
  });
  afterEach(() => {
    // A test that mocks the clock must not leak it into the next one.
    vi.useRealTimers();
  });
  afterEach(() => {
    wiring?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('C4: a delivered-but-unconfirmed continue does not suppress', async () => {
    build([registryEntry()], orphanRunning);
    const fpA = (await import('node:crypto')).createHash('sha256').update('goal A\n1000').digest('hex');
    await wiring.markerStore.claim('pi-child-1', fpA, 'restart_interruption', 'boot_orphan');
    await wiring.markerStore.commit('pi-child-1', fpA); // delivered this boot, NOT confirmed
    await wiring.runSweep(new Map());
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(false);
  });

  it('F6: a continue confirmed this boot for the CURRENT goal suppresses; an older goal and a reservation do not', async () => {
    build([registryEntry()], orphanRunning);
    // Goal A interrupted and auto-continued in this boot.
    const report = await wiring.runSweep(new Map());
    // D18: a silent skip used to surface only as `expected +0 to be 1`; name it.
    expect(dispatches, `sweep report: ${JSON.stringify(report)}`).toBe(1);
    expect(report.skipReasons, `sweep skipped the boot orphan: ${JSON.stringify(report.skipReasons)}`).toEqual({});
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(true);

    // A NEW goal B on the same session (the engine rewrites the goal file):
    // the old marker must not suppress.
    await fsp.writeFile(piGoalStatePath(sessionPath()), JSON.stringify({
      objective: 'goal B', status: 'running', startedAt: 5000, turnCount: 0, completedAt: null,
    }), 'utf8');
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(false);

    // A reserved (count-0) marker is not a confirmed continue.
    const fpB = (await import('node:crypto')).createHash('sha256').update('goal B\n5000').digest('hex');
    await wiring.markerStore.claim('pi-child-1', fpB, 'restart_interruption', 'boot_orphan');
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(false);
  });

  it('F6: a continue confirmed before this boot does not suppress', async () => {
    build([registryEntry()], orphanRunning);
    // Pre-seed a committed marker whose continuedAt is in a previous lifetime.
    const fpA = (await import('node:crypto')).createHash('sha256').update('goal A\n1000').digest('hex');
    await wiring.markerStore.claim('pi-child-1', fpA, 'restart_interruption', 'boot_orphan');
    await wiring.markerStore.commit('pi-child-1', fpA);
    const markerFile = path.join(dir, 'run-0', 'goal-continue', 'markers', `pi-child-1.${fpA.slice(0, 16)}.json`);
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as { continuedAt: number };
    marker.continuedAt = Date.now() - 6 * 3_600_000;
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    // The sweep resolves classificationSettled; the pre-boot continue means
    // this boot does NOT continue again (second transient, visible).
    await wiring.runSweep(new Map());
    expect(dispatches).toBe(0);
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(false);
  });

  it('D18: a process clock that disagrees with the filesystem stamp does not silently skip the boot orphan', async () => {
    // Deploy 2026-10-19: this file failed once in the full server suite with
    // `AssertionError: expected +0 to be 1` on the F6 case below, while passing
    // alone (3/3) and in CI. The sweep's R1 previous-lifetime gate compares the
    // session file's MTIME with the process clock (`Date.now()`); a freshly
    // written file leaves that comparison to filesystem-clock/process-clock
    // agreement. A worker whose clock is mocked, frozen or stepped backwards
    // therefore drops the boot orphan with "last activity … outside the
    // previous lifetime bound" and the F6 positives below see 0 dispatches for
    // no reason. The fixture must express its activity instant through the
    // clock the code actually reads.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    // Re-materialised with the mocked clock in place: the filesystem stamps
    // real time, which is months AHEAD of the clock the sweep reads.
    await writeSessionFixture();
    build([registryEntry()], orphanRunning);
    const report = await wiring.runSweep(new Map());
    expect(dispatches, `sweep report: ${JSON.stringify(report)}`).toBe(1);
    expect(report.skipReasons, `sweep skipped the boot orphan: ${JSON.stringify(report.skipReasons)}`).toEqual({});
    expect(report.continued).toEqual([SESSION_ID]);
    expect(await wiring.hasGoalContinueMarker(SESSION_ID)).toBe(true);
  });
});
