/**
 * Wave K correction 03 — interruption sweep tests.
 *
 * Scope cut: the live provider-abort path is gone; provider failures end as
 * before wave K. Continueable states are exactly: an orphan `running` goal and
 * a `restored_on_session_start` pause. C1: the loopback body carries
 * detach + idempotencyKey; a found claim (any age) is consumed-visible; corrupt
 * markers are consumed-visible; 500-class responses are unknown (consumed).
 * C2: `wrapping_up` is never continued. C3: non-Pi visibility is boot-only and
 * excludes every terminal status. C5: verification is fingerprint-tied.
 * C6: the verified event carries top-level `autoContinued: true`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterruptionSweep, isApiOriginChild, withinPreviousLifetime, type SweepCandidate, type InterruptionSweepDeps, type SweepDispatchResult } from '../../../../src/internal-api/goal/interruption-sweep.js';
import { createContinueMarkerStore, goalFingerprint } from '../../../../src/internal-api/goal/continue-marker.js';
import { createInterruptionOverlayStore } from '../../../../src/internal-api/goal/interruption-overlay.js';
import type { SessionGoalProjection } from '../../../../src/internal-api/goal/types.js';

const BOOT = 1_000_000;

function runningProjection(objective = 'finish the lane'): SessionGoalProjection {
  return {
    supported: true,
    status: 'running',
    objective,
    startedAt: BOOT - 3_600_000,
    runtimeState: { objective, status: 'running', startedAt: BOOT - 3_600_000, turnCount: 2 },
  };
}

function apiChild(overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    sessionId: 'pi-child-1',
    sessionPath: '/tmp/sessions/pi-child-1.jsonl',
    runtime: 'pi',
    origin: 'internal-api',
    lastActivityMs: BOOT - 60_000,
    ...overrides,
  };
}

interface Harness {
  deps: InterruptionSweepDeps;
  dispatches: Array<{ sessionId: string; message: string; idempotencyKey: string; body?: unknown }>;
  events: Array<{ sessionId: string; projection: SessionGoalProjection }>;
  dispatchBehavior: (attempt: number, sessionId: string) => SweepDispatchResult | 'accept';
  markerDir: string;
  overlayDir: string;
  projection: SessionGoalProjection;
}

function harness(overrides: Partial<InterruptionSweepDeps> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-sweep3-'));
  const markerDir = path.join(dir, 'markers');
  const overlayDir = path.join(dir, 'overlay');
  const clock = { now: BOOT + 1000 };
  const state: Harness = {
    dispatches: [],
    events: [],
    dispatchBehavior: () => 'accept',
    markerDir,
    overlayDir,
    projection: runningProjection(),
  };
  const attempts = new Map<string, number>();
  const deps: InterruptionSweepDeps = {
    isSessionBusy: () => false,
    readRawProjection: async () => state.projection,
    readTranscriptLines: async () => [],
    dispatchContinue: async (sessionId, message, idempotencyKey) => {
      const attempt = (attempts.get(`${sessionId}:${idempotencyKey}`) ?? 0) + 1;
      attempts.set(`${sessionId}:${idempotencyKey}`, attempt);
      state.dispatches.push({ sessionId, message, idempotencyKey });
      const behaviour = state.dispatchBehavior(attempt, sessionId);
      return behaviour === 'accept' ? { outcome: 'accepted' } : behaviour;
    },
    publishGoalState: (sessionId, projection) => { state.events.push({ sessionId, projection }); },
    markerStore: createContinueMarkerStore(markerDir, { now: () => clock.now }),
    overlayStore: createInterruptionOverlayStore(overlayDir),
    readGoalFileIdentity: async () => ({ mtimeMs: 42, size: 7 }),
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    verifyMs: 30_000,
    verifyIntervalMs: 10_000,
    ...overrides,
  };
  state.deps = deps;
  return state;
}

async function runSweep(h: Harness, candidates: SweepCandidate[], opts?: { boot?: boolean }): Promise<ReturnType<ReturnType<typeof createInterruptionSweep>['run']>> {
  const sweep = createInterruptionSweep(h.deps);
  return sweep.run(candidates, BOOT, opts);
}

describe('R1 scope (unchanged)', () => {
  it('an interactive-origin running goal is neither continued nor marked', async () => {
    const h = harness();
    const report = await runSweep(h, [apiChild({ sessionId: 'pi-browser-1', origin: 'browser' })], { boot: true });
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(await h.deps.markerStore.hasActiveContinue('pi-browser-1')).toBe(false);
    expect(report.skipped).toContain('pi-browser-1');
  });

  it('last activity older than the 6 h restart bound is skipped; announced candidates skip the bound', async () => {
    const h = harness();
    await runSweep(h, [apiChild({ sessionId: 'pi-stale', lastActivityMs: BOOT - 7 * 3_600_000 })]);
    expect(h.dispatches).toHaveLength(0);
    await runSweep(h, [apiChild({ sessionId: 'pi-drained', lastActivityMs: BOOT - 9 * 3_600_000, announced: { source: 'drain', interruptionReason: 'drain_timeout' } })]);
    expect(h.dispatches).toHaveLength(1);
  });

  it('a live (busy) session is skipped', async () => {
    const h = harness({ isSessionBusy: (id) => id === 'pi-child-1' });
    await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(0);
  });
});

describe('C1 — exactly-once delivery', () => {
  it('the dispatch carries an idempotency key derived from the session and goal', async () => {
    const h = harness();
    await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(1);
    const key = h.dispatches[0].idempotencyKey;
    expect(key).toContain('pi-child-1');
    expect(key).toContain(goalFingerprint('finish the lane', BOOT - 3_600_000).slice(0, 12));
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it('two overlapping sweeps dispatch once (single-flight + exclusive claim)', async () => {
    const h = harness();
    const sweep = createInterruptionSweep(h.deps);
    const candidates = [apiChild()];
    const [a, b] = await Promise.all([sweep.run(candidates, BOOT, { boot: true }), sweep.run(candidates, BOOT, { boot: true })]);
    expect(h.dispatches).toHaveLength(1);
    expect(a.continued.length + b.continued.length).toBe(1);
  });

  it('a found claim (fresh or stale, never committed) is consumed: no dispatch, visible stop', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    for (const claimedAt of [BOOT, BOOT - 60 * 60_000]) {
      const h = harness();
      const past = createContinueMarkerStore(h.markerDir, { now: () => claimedAt });
      await past.claim('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
      const report = await runSweep(h, [apiChild()], { boot: true });
      expect(h.dispatches).toHaveLength(0);
      const event = h.events.find((e) => e.sessionId === 'pi-child-1');
      expect(event?.projection.status).toBe('paused');
      expect(event?.projection.interruption).toMatchObject({ cause: 'continue_failed', continueCount: 1 });
      expect(report.interruptedVisible).toEqual(['pi-child-1']);
    }
  });

  it('a corrupt marker file is consumed: visible, not silent', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    fs.mkdirSync(h.markerDir, { recursive: true });
    fs.writeFileSync(path.join(h.markerDir, `pi-child-1.${fp.slice(0, 16)}.json`), '{corrupt', 'utf8');
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.interruption).toMatchObject({ cause: 'continue_failed', continueCount: 1 });
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });

  it('a 500 after dispatch counts as unknown: consumed, visible, no claimed auto-continue', async () => {
    const h = harness({ windowMs: 10_000 });
    h.dispatchBehavior = () => ({ outcome: 'unknown', reason: 'prompt endpoint answered 500' });
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(1);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.interruption).toMatchObject({ cause: 'continue_failed', autoContinued: false });
    expect(report.continued).toHaveLength(0);
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });

  it('a second transient on the SAME goal is visible and not continued', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    await h.deps.markerStore.claim('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
    await h.deps.markerStore.commit('pi-child-1', fp);
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.interruption).toMatchObject({ cause: 'second_transient', continueCount: 1 });
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });
});

describe('C2 — intent', () => {
  it('an announced wrapping-up goal is NEVER continued and left as it is on disk', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'wrapping_up', objective: 'finish the lane', startedAt: BOOT - 3_600_000 }) });
    const report = await runSweep(h, [apiChild({ announced: { source: 'receipt', interruptionReason: 'server_restart' } })]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(await h.deps.markerStore.hasMarker('pi-child-1')).toBe(false);
    expect(report.skipped).toContain('pi-child-1');
  });

  it('an announced, explicitly paused child gets no continue and no change', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'owner-approved tmux restart' }) });
    await runSweep(h, [apiChild({ announced: { source: 'receipt', interruptionReason: 'server_restart' } })]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(await h.deps.markerStore.hasMarker('pi-child-1')).toBe(false);
  });

  it('question/governor/budget/turn-limit pauses are never continued', async () => {
    for (const projection of [
      { supported: true, status: 'paused' as const, pausedReason: 'question' },
      { supported: true, status: 'paused' as const, pausedReason: 'paused by the continuation governor' },
      { supported: true, status: 'paused' as const, pausedReason: 'spend budget reached' },
      { supported: true, status: 'paused' as const, pausedReason: 'turn limit reached' },
    ]) {
      const h = harness({ readRawProjection: async () => projection });
      await runSweep(h, [apiChild()]);
      expect(h.dispatches).toHaveLength(0);
      expect(h.events).toHaveLength(0);
    }
  });

  it('a paused goal with a stale provider error string is not continued by the sweep', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'pause-now', runtimeState: { lastErrorMessage: 'Provider overloaded (HTTP 429)' } }) });
    await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
});

describe('F7/C6 — verified, watchable auto-continue events', () => {
  it('publishes goal_state running + top-level autoContinued only after verification', async () => {
    const h = harness();
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(1);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('running');
    expect(event?.projection.autoContinued).toBe(true);
    expect(event?.projection.interruption).toMatchObject({ autoContinued: true, continueCount: 1 });
    expect(report.continued).toEqual(['pi-child-1']);
  });

  it('an accepted dispatch that never verifies is consumed and visible (continue_failed)', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'restored_on_session_start', objective: 'finish the lane', startedAt: BOOT - 3_600_000 }) });
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(1);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.interruption).toMatchObject({ autoContinued: false, cause: 'continue_failed' });
    expect(report.interruptedVisible).toContain('pi-child-1');
  });
});

describe('C5 — verification tied to the same goal', () => {
  it('a goal replaced before dispatch: no dispatch, nothing written', async () => {
    const h = harness();
    let reads = 0;
    h.deps.readRawProjection = async () => {
      reads += 1;
      // The sweep's classification read (first) sees the orphan; the
      // pre-dispatch re-read (second) sees a replaced goal.
      return reads <= 1 ? runningProjection() : { supported: true, status: 'running', objective: 'goal B', startedAt: 9000 };
    };
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(0);
    expect(await h.deps.markerStore.hasMarker('pi-child-1')).toBe(false);
    expect(h.events).toHaveLength(0);
    expect(report.skipped).toContain('pi-child-1');
  });

  it('a goal replaced after acceptance: consumed, no overlay, no event on goal B', async () => {
    const h = harness();
    let polls = 0;
    h.deps.readRawProjection = async () => {
      polls += 1;
      if (polls <= 2) return runningProjection(); // classification + pre-dispatch
      return { supported: true, status: 'running', objective: 'goal B', startedAt: 9000 }; // replaced during the verify poll
    };
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(1);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
    expect(h.events).toHaveLength(0);
    expect(report.continued).toHaveLength(0);
  });

  it('the same goal achieved before the first poll verifies as a completed continue (no continue_failed)', async () => {
    const h = harness();
    let polls = 0;
    h.deps.readRawProjection = async () => {
      polls += 1;
      if (polls <= 2) return runningProjection();
      return { supported: true, status: 'achieved', objective: 'finish the lane', startedAt: BOOT - 3_600_000, completedAt: 123 };
    };
    const report = await runSweep(h, [apiChild()], { boot: true });
    expect(h.dispatches).toHaveLength(1);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('achieved');
    expect(event?.projection.autoContinued).toBe(true);
    expect(await h.deps.markerStore.get('pi-child-1', goalFingerprint('finish the lane', BOOT - 3_600_000))?.then?.(undefined) ?? undefined);
    const marker = await h.deps.markerStore.get('pi-child-1', goalFingerprint('finish the lane', BOOT - 3_600_000));
    expect(marker?.state).toBe('confirmed');
    expect(report.continued).toEqual(['pi-child-1']);
  });
});

describe('C3 — non-Pi visibility is boot-only and terminal-excluded', () => {
  it('a failed non-Pi goal gets nothing', async () => {
    const h = harness({ readRuntimeProjection: async () => ({ supported: false, status: 'failed', pausedReason: 'error' }) });
    const report = await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude' })], { boot: true });
    expect(h.events).toHaveLength(0);
    expect(report.skipped).toContain('cl-1');
  });

  it('an active non-Pi goal is visible in the BOOT sweep with the real supported flag', async () => {
    const h = harness({ readRuntimeProjection: async () => ({ supported: false, status: 'running', objective: 'claude goal' }) });
    const report = await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude' })], { boot: true });
    const event = h.events.find((e) => e.sessionId === 'cl-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.supported).toBe(false);
    expect(report.interruptedVisible).toEqual(['cl-1']);
  });

  it('an active non-Pi goal gets NOTHING in the in-process drain-timeout sweep', async () => {
    const h = harness({ readRuntimeProjection: async () => ({ supported: false, status: 'running', objective: 'claude goal' }) });
    const report = await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude', announced: { source: 'drain', interruptionReason: 'drain_timeout' } })]);
    expect(h.events).toHaveLength(0);
    expect(report.skipped).toContain('cl-1');
  });

  it('an explicitly paused non-Pi goal gets nothing', async () => {
    const h = harness({ readRuntimeProjection: async () => ({ supported: false, status: 'paused', pausedReason: 'owner pause' }) });
    await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude' })], { boot: true });
    expect(h.events).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('isApiOriginChild and withinPreviousLifetime encode R1', () => {
    expect(isApiOriginChild(apiChild())).toBe(true);
    expect(isApiOriginChild(apiChild({ origin: 'browser' }))).toBe(false);
    expect(isApiOriginChild(apiChild({ origin: undefined, parentSource: 'body' }))).toBe(true);
    expect(withinPreviousLifetime(apiChild(), BOOT, 6 * 3_600_000)).toBe(true);
    expect(withinPreviousLifetime(apiChild({ lastActivityMs: BOOT - 7 * 3_600_000 }), BOOT, 6 * 3_600_000)).toBe(false);
    expect(withinPreviousLifetime(apiChild({ lastActivityMs: BOOT + 5000 }), BOOT, 6 * 3_600_000)).toBe(false);
  });
});
