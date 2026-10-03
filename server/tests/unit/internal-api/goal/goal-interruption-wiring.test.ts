/**
 * Wave K correction 02 — wiring-level tests (F3 gating, F6 probe semantics).
 *
 * F3: live observers attach only to Internal API children (and only Pi).
 * F6: the R5 suppression probe matches the CURRENT goal fingerprint and a
 * continue CONFIRMED in this boot; a historical marker for an older goal, a
 * reserved (count-0) marker, and a pre-boot continue suppress nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  let observersAttached: string[];
  let dispatches: number;
  let goalProjection: SessionGoalProjection | Record<string, unknown>;
  let wiring: GoalInterruptionWiring;

  const entry: WiringRegistryEntry = {
    id: 'pi-child-1',
    path: '/tmp/sessions/pi-child-1.jsonl',
    sdkType: 'pi',
    origin: 'internal-api',
  };

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
      addExtensionUiObserver: (sessionPath) => { observersAttached.push(sessionPath); },
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
    observersAttached = [];
    dispatches = 0;
    // The Pi read path resolves the goal file under PI_WEB_UI_GOAL_HOME; point
    // it at the temp dir and materialise the goal file for the session key.
    process.env.PI_WEB_UI_GOAL_HOME = path.join(dir, 'goal-home');
    await fsp.mkdir(path.dirname(piGoalStatePath(entry.path)), { recursive: true });
    await fsp.writeFile(piGoalStatePath(entry.path), JSON.stringify({
      objective: 'goal A', status: 'running', startedAt: 1000, turnCount: 2, completedAt: null,
    }), 'utf8');
    // The session file itself (its mtime is the R1 last-activity signal).
    await fsp.mkdir(path.dirname(entry.path), { recursive: true });
    await fsp.writeFile(entry.path, '', 'utf8');
  });
  afterEach(async () => {
    delete process.env.PI_WEB_UI_GOAL_HOME;
  });
  afterEach(() => {
    wiring?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('F3: observers attach only to Internal API children', async () => {
    build([
      entry,
      { id: 'pi-browser-1', path: '/tmp/sessions/pi-browser-1.jsonl', sdkType: 'pi', origin: 'browser' },
      { id: 'cl-1', path: '/tmp/sessions/cl-1.jsonl', sdkType: 'claude', origin: 'internal-api' },
    ]);
    await wiring.attachLiveObservers();
    expect(observersAttached).toEqual(['/tmp/sessions/pi-child-1.jsonl']);
  });

  it('F6: a continue confirmed this boot for the CURRENT goal suppresses; an older goal and a reservation do not', async () => {
    build([entry], orphanRunning);
    // Goal A interrupted and auto-continued in this boot.
    await wiring.runSweep(new Map());
    expect(dispatches).toBe(1);
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(true);

    // A NEW goal B on the same session (the engine rewrites the goal file):
    // the old marker must not suppress.
    await fsp.writeFile(piGoalStatePath(entry.path), JSON.stringify({
      objective: 'goal B', status: 'running', startedAt: 5000, turnCount: 0, completedAt: null,
    }), 'utf8');
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(false);

    // A reserved (count-0) marker is not a confirmed continue.
    const fpB = (await import('node:crypto')).createHash('sha256').update('goal B\n5000').digest('hex');
    await wiring.markerStore.claim('pi-child-1', fpB, 'restart_interruption', 'boot_orphan');
    expect(await wiring.hasGoalContinueMarker('pi-child-1')).toBe(false);
  });

  it('F6: a continue confirmed before this boot does not suppress', async () => {
    build([entry], orphanRunning);
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
});
