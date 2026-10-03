/**
 * Wave K (contract 1.59.0) — interruption sweep tests (K2, R1, R2).
 *
 * R1: only API goal children are candidates (Internal-API origin or
 * parentSource, last activity within the previous server lifetime bounded at
 * 6 h, runtime pi, not busy). Interactive/browser-origin running goals are
 * neither continued nor marked. R2: no fixed cap — every in-scope candidate is
 * processed at concurrency 2, honouring Retry-After within a bounded window;
 * a candidate not continued in the window gets the visible interruption.
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
  dispatches: Array<{ sessionId: string; message: string }>;
  events: Array<{ sessionId: string; projection: SessionGoalProjection }>;
  dispatchBehavior: (attempt: number, sessionId: string) => SweepDispatchResult | 'accept';
  maxConcurrent: { value: number };
  markerDir: string;
  overlayDir: string;
}

function harness(overrides: Partial<InterruptionSweepDeps> = {}, candidateOverrides: Partial<SweepCandidate> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-sweep-'));
  const markerDir = path.join(dir, 'markers');
  const overlayDir = path.join(dir, 'overlay');
  const clock = { now: BOOT + 1000 };
  const state: Harness = {
    dispatches: [],
    events: [],
    dispatchBehavior: () => 'accept',
    maxConcurrent: { value: 0 },
    markerDir,
    overlayDir,
  };
  let inFlight = 0;
  const attempts = new Map<string, number>();
  const deps: InterruptionSweepDeps = {
    isSessionBusy: () => false,
    readRawProjection: async () => runningProjection(),
    readTranscriptLines: async () => [],
    dispatchContinue: async (sessionId, message) => {
      inFlight += 1;
      state.maxConcurrent.value = Math.max(state.maxConcurrent.value, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      const attempt = (attempts.get(sessionId) ?? 0) + 1;
      attempts.set(sessionId, attempt);
      state.dispatches.push({ sessionId, message });
      inFlight -= 1;
      const behaviour = state.dispatchBehavior(attempt, sessionId);
      return behaviour === 'accept' ? { ok: true } : behaviour;
    },
    publishGoalState: (sessionId, projection) => { state.events.push({ sessionId, projection }); },
    markerStore: createContinueMarkerStore(markerDir),
    overlayStore: createInterruptionOverlayStore(overlayDir),
    readGoalFileIdentity: async () => ({ mtimeMs: 42, size: 7 }),
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    ...overrides,
  };
  state.deps = deps;
  void candidateOverrides;
  return state;
}

async function runSweep(h: Harness, candidates: SweepCandidate[]): Promise<ReturnType<ReturnType<typeof createInterruptionSweep>['run']>> {
  const sweep = createInterruptionSweep(h.deps);
  return sweep.run(candidates, BOOT);
}

describe('R1 scope', () => {
  it('an interactive-origin running goal is neither continued nor marked (the R1 test)', async () => {
    const h = harness();
    const report = await runSweep(h, [apiChild({ sessionId: 'pi-browser-1', origin: 'browser' })]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(await h.deps.markerStore.hasActiveContinue('pi-browser-1')).toBe(false);
    expect(report.continued).toHaveLength(0);
    expect(report.skipped).toContain('pi-browser-1');
  });

  it('a missing origin is out of scope unless parentSource marks a dispatched child', async () => {
    const h = harness();
    await runSweep(h, [apiChild({ sessionId: 'pi-unknown-origin', origin: undefined })]);
    expect(h.dispatches).toHaveLength(0);
    await runSweep(h, [apiChild({ sessionId: 'pi-parented', origin: undefined, parentSource: 'header' })]);
    expect(h.dispatches).toHaveLength(1);
  });

  it('last activity older than the 6 h restart bound is skipped', async () => {
    const h = harness();
    const report = await runSweep(h, [apiChild({ sessionId: 'pi-stale', lastActivityMs: BOOT - 7 * 3_600_000 })]);
    expect(h.dispatches).toHaveLength(0);
    expect(report.skipped).toContain('pi-stale');
  });

  it('an announced (drain/receipt) candidate skips the activity bound', async () => {
    const h = harness();
    await runSweep(h, [apiChild({ sessionId: 'pi-drained', lastActivityMs: BOOT - 9 * 3_600_000, announced: { source: 'drain', interruptionReason: 'drain_timeout' } })]);
    expect(h.dispatches).toHaveLength(1);
  });

  it('a live (busy) session is skipped', async () => {
    const h = harness({ isSessionBusy: (id) => id === 'pi-child-1' });
    await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a native-discovered session is out of scope', async () => {
    const h = harness();
    await runSweep(h, [apiChild({ sessionId: 'pi-native', origin: 'native-discovered' })]);
    expect(h.dispatches).toHaveLength(0);
  });
});

describe('K2 continue once', () => {
  it('continues once with a /goal resume note, commits the marker, and emits the auto_continued event', async () => {
    const h = harness({
      readTranscriptLines: async () => [JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: 5, content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git commit -m wip' } }] } })],
    });
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0].message).toContain('/goal resume');
    expect(h.dispatches[0].message).toContain('git commit');
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('running');
    expect(event?.projection.interruption).toMatchObject({ autoContinued: true, cause: 'restart_interruption', continueCount: 1 });
    expect(report.continued).toEqual(['pi-child-1']);
  });

  it('a second transient stop does not continue and emits the visible interruption', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    await h.deps.markerStore.reserve('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
    await h.deps.markerStore.commit('pi-child-1', fp);
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.pausedReason).toBe('interrupted');
    expect(event?.projection.interruption).toMatchObject({ cause: 'second_transient', continueCount: 1 });
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });

  it('a cleared or achieved goal is never continued', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'cleared' }) });
    await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    const h2 = harness({ readRawProjection: async () => ({ supported: true, status: 'achieved', completedAt: 5 }) });
    await runSweep(h2, [apiChild()]);
    expect(h2.dispatches).toHaveLength(0);
  });

  it('a budget pause and a user abort are not continued', async () => {
    const budget = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'spend budget reached' }) });
    await runSweep(budget, [apiChild()]);
    expect(budget.dispatches).toHaveLength(0);
    expect(budget.events).toHaveLength(0);

    const aborted = harness({ readRawProjection: async () => ({ supported: true, status: 'failed', pausedReason: 'error', runtimeState: { lastErrorMessage: 'Goal run aborted by user; auto-continuation paused.' } }) });
    await runSweep(aborted, [apiChild()]);
    expect(aborted.dispatches).toHaveLength(0);
    expect(aborted.events).toHaveLength(0);
  });

  it('a rehydrate pause inside the sweep scope continues once', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'restored_on_session_start' }) });
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    expect(report.continued).toEqual(['pi-child-1']);
  });

  it('a provider abort with positive evidence continues once; without evidence it does not', async () => {
    const overloaded = harness({ readRawProjection: async () => ({ supported: true, status: 'failed', pausedReason: 'error', runtimeState: { lastErrorMessage: 'Provider overloaded (HTTP 429)' } }) });
    await runSweep(overloaded, [apiChild()]);
    expect(overloaded.dispatches).toHaveLength(1);

    const opaque = harness({ readRawProjection: async () => ({ supported: true, status: 'failed', pausedReason: 'error', runtimeState: { lastErrorMessage: 'Assistant turn ended with stopReason=error' } }) });
    await runSweep(opaque, [apiChild()]);
    expect(opaque.dispatches).toHaveLength(0);
  });
});

describe('R2 window and concurrency', () => {
  it('honours Retry-After and lands the continue inside the window', async () => {
    const h = harness();
    h.dispatchBehavior = (attempt) => (attempt === 1 ? { ok: false, retryAfterSeconds: 2, reason: 'admission' } : 'accept');
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(2);
    expect(report.continued).toEqual(['pi-child-1']);
  });

  it('a candidate never admitted inside the window gets the visible interruption and no marker', async () => {
    const h = harness({ windowMs: 50 });
    h.dispatchBehavior = () => ({ ok: false, retryAfterSeconds: 30, reason: 'admission' });
    const report = await runSweep(h, [apiChild()]);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(false);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.interruption).toMatchObject({ cause: 'continue_failed' });
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });

  it('processes candidates at concurrency 2 (no fixed cap on the candidate count)', async () => {
    const h = harness();
    const candidates = Array.from({ length: 7 }, (_, i) => apiChild({ sessionId: `pi-child-${i}` }));
    await runSweep(h, candidates);
    expect(h.dispatches).toHaveLength(7);
    expect(h.maxConcurrent.value).toBeLessThanOrEqual(2);
  });
});

describe('unsupported runtimes (R4 visibility)', () => {
  it('a non-Pi announced API child emits the visible interruption without a continue', async () => {
    const h = harness();
    await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude', announced: { source: 'receipt', interruptionReason: 'SERVER_RESTART' } })]);
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'cl-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.pausedReason).toBe('interrupted');
    expect(event?.projection.interruption).toMatchObject({ cause: 'unsupported_runtime', source: 'receipt' });
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
