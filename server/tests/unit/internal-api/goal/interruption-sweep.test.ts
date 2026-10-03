/**
 * Wave K correction 02 — interruption sweep tests (F1, F2, F5, F6, F7).
 *
 * F1: exactly-once is atomic (exclusive claim, single-flight, idempotency key,
 * ambiguous delivery consumed, definite refusal released and retried).
 * F2: explicit intent wins — only orphans, restores and typed fresh provider
 * stops (live path) may continue; an announced explicitly-paused child stays
 * untouched. F5: non-Pi candidates read the runtime's real projection.
 * F6: markers are fingerprint-keyed and pruned. F7: the auto-continue event is
 * published only with a verified post-dispatch running projection.
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
  dispatches: Array<{ sessionId: string; message: string; idempotencyKey: string }>;
  events: Array<{ sessionId: string; projection: SessionGoalProjection }>;
  dispatchBehavior: (attempt: number, sessionId: string) => SweepDispatchResult | 'accept';
  maxConcurrent: { value: number };
  markerDir: string;
  overlayDir: string;
  projection: SessionGoalProjection;
  projectionReads: number;
}

function harness(overrides: Partial<InterruptionSweepDeps> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-sweep2-'));
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
    projection: runningProjection(),
    projectionReads: 0,
  };
  let inFlight = 0;
  const attempts = new Map<string, number>();
  const deps: InterruptionSweepDeps = {
    isSessionBusy: () => false,
    readRawProjection: async () => {
      state.projectionReads += 1;
      return state.projection;
    },
    readTranscriptLines: async () => [],
    dispatchContinue: async (sessionId, message, idempotencyKey) => {
      inFlight += 1;
      state.maxConcurrent.value = Math.max(state.maxConcurrent.value, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      const attempt = (attempts.get(`${sessionId}:${idempotencyKey}`) ?? 0) + 1;
      attempts.set(`${sessionId}:${idempotencyKey}`, attempt);
      state.dispatches.push({ sessionId, message, idempotencyKey });
      inFlight -= 1;
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

async function runSweep(h: Harness, candidates: SweepCandidate[]): Promise<ReturnType<ReturnType<typeof createInterruptionSweep>['run']>> {
  const sweep = createInterruptionSweep(h.deps);
  return sweep.run(candidates, BOOT);
}

describe('R1 scope (unchanged)', () => {
  it('an interactive-origin running goal is neither continued nor marked', async () => {
    const h = harness();
    const report = await runSweep(h, [apiChild({ sessionId: 'pi-browser-1', origin: 'browser' })]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(await h.deps.markerStore.hasActiveContinue('pi-browser-1')).toBe(false);
    expect(report.continued).toHaveLength(0);
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
    await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
  });
});

describe('F1 — atomic exactly-once', () => {
  it('carries an idempotency key derived from the session and goal', async () => {
    const h = harness();
    await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    const key = h.dispatches[0].idempotencyKey;
    expect(key).toContain('pi-child-1');
    expect(key).toContain(goalFingerprint('finish the lane', BOOT - 3_600_000).slice(0, 12));
  });

  it('two overlapping sweeps dispatch once (single-flight + exclusive claim)', async () => {
    const h = harness();
    h.dispatchBehavior = () => { await0(200); return 'accept'; };
    function await0(ms: number): void { const start = Date.now(); while (Date.now() - start < ms) { /* spin briefly */ } }
    const sweep = createInterruptionSweep(h.deps);
    const candidates = [apiChild()];
    const [a, b] = await Promise.all([sweep.run(candidates, BOOT), sweep.run(candidates, BOOT)]);
    expect(h.dispatches).toHaveLength(1);
    expect(a.continued.length + b.continued.length).toBe(1);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
  });

  it('a crash after acceptance and before commit produces no second dispatch (the claim blocks)', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    // The first process claimed and accepted, then died before commit: the
    // count-0 claim stays fresh on disk.
    await h.deps.markerStore.claim('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
    expect(report.skipped).toContain('pi-child-1');
  });

  it('a stale (abandoned) claim is taken over and the dispatch proceeds once', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    const staleStore = createContinueMarkerStore(h.markerDir, { now: () => BOOT - 30 * 60_000 });
    await staleStore.claim('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    expect(report.continued).toEqual(['pi-child-1']);
  });

  it('an accepted dispatch whose response times out is consumed: no second dispatch, visible interruption', async () => {
    const h = harness({ windowMs: 30_000 });
    h.dispatchBehavior = () => ({ outcome: 'unknown', reason: 'loopback timed out' });
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.interruption).toMatchObject({ cause: 'continue_failed', autoContinued: false });
    expect(report.continued).toHaveLength(0);
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });

  it('a crash after acceptance and before commit produces no second dispatch on the next sweep (committed path)', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    await h.deps.markerStore.claim('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
    await h.deps.markerStore.commit('pi-child-1', fp);
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.interruption).toMatchObject({ cause: 'second_transient', continueCount: 1 });
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });
});

describe('F2 — explicit intent wins', () => {
  it('an announced, explicitly paused child gets no continue and no change', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'owner-approved tmux restart' }) });
    const report = await runSweep(h, [apiChild({ announced: { source: 'receipt', interruptionReason: 'server_restart' } })]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(await h.deps.markerStore.hasMarker('pi-child-1')).toBe(false);
    expect(report.skipped).toContain('pi-child-1');
  });

  it('a paused goal with a stale provider error string is not a provider abort (sweep never reads stale text)', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'pause-now', runtimeState: { lastErrorMessage: 'Provider overloaded (HTTP 429)' } }) });
    const report = await runSweep(h, [apiChild({ announced: { source: 'receipt', interruptionReason: 'server_restart' } })]);
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(report.skipped).toContain('pi-child-1');
  });

  it('a question pause, a governor pause and a budget pause are never continued', async () => {
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

  it('an announced wrapping-up orphan still continues (goal was live at the cut-off)', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'wrapping_up', objective: 'finish the lane', startedAt: BOOT - 3_600_000 }) });
    await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
  });
});

describe('F7 — truthful auto-continue events', () => {
  it('publishes goal_state running+autoContinued only after the resume is verified', async () => {
    const h = harness();
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('running');
    expect(event?.projection.interruption).toMatchObject({ autoContinued: true, continueCount: 1 });
    expect(report.continued).toEqual(['pi-child-1']);
  });

  it('an accepted dispatch that never verifies running is not published as auto-continued', async () => {
    const h = harness({ readRawProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'restored_on_session_start', objective: 'finish the lane', startedAt: BOOT - 3_600_000 }) });
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    expect(await h.deps.markerStore.hasActiveContinue('pi-child-1')).toBe(true);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.interruption).toMatchObject({ autoContinued: false, cause: 'continue_failed' });
    expect(report.continued).toHaveLength(0);
    expect(report.interruptedVisible).toContain('pi-child-1');
  });
});

describe('F6 — fingerprint-keyed markers', () => {
  it('a marker for an older goal is pruned and a new goal gets a fresh once', async () => {
    const h = harness();
    const oldFp = goalFingerprint('an older goal', 1);
    await h.deps.markerStore.claim('pi-child-1', oldFp, 'restart_interruption', 'boot_orphan');
    await h.deps.markerStore.commit('pi-child-1', oldFp);
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(1);
    expect(report.continued).toEqual(['pi-child-1']);
    const all = await h.deps.markerStore.listForSession('pi-child-1');
    expect(all).toHaveLength(1);
    expect(all[0].fingerprint).toBe(goalFingerprint('finish the lane', BOOT - 3_600_000));
  });

  it('a second transient on the SAME goal is visible and not continued', async () => {
    const fp = goalFingerprint('finish the lane', BOOT - 3_600_000);
    const h = harness();
    await h.deps.markerStore.claim('pi-child-1', fp, 'restart_interruption', 'boot_orphan');
    await h.deps.markerStore.commit('pi-child-1', fp);
    const report = await runSweep(h, [apiChild()]);
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'pi-child-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.interruption).toMatchObject({ cause: 'second_transient', continueCount: 1 });
    expect(report.interruptedVisible).toEqual(['pi-child-1']);
  });
});

describe('F5 — non-Pi candidates read the real projection', () => {
  it('an active non-Pi goal (unannounced) gets the visible interruption with the real supported flag', async () => {
    const h = harness({
      readRuntimeProjection: async () => ({ supported: false, status: 'running', objective: 'claude goal' }),
    });
    const report = await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude' })]);
    expect(h.dispatches).toHaveLength(0);
    const event = h.events.find((e) => e.sessionId === 'cl-1');
    expect(event?.projection.status).toBe('paused');
    expect(event?.projection.pausedReason).toBe('interrupted');
    expect(event?.projection.supported).toBe(false);
    expect(event?.projection.interruption).toMatchObject({ cause: 'restart_interruption' });
    expect(report.interruptedVisible).toEqual(['cl-1']);
  });

  it('a terminal non-Pi goal gets nothing', async () => {
    const h = harness({ readRuntimeProjection: async () => ({ supported: false, status: 'achieved', completedAt: 5 }) });
    const report = await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude' })]);
    expect(h.events).toHaveLength(0);
    expect(report.skipped).toContain('cl-1');
  });

  it('an explicitly paused non-Pi goal gets nothing (no change)', async () => {
    const h = harness({ readRuntimeProjection: async () => ({ supported: false, status: 'paused', pausedReason: 'owner pause' }) });
    await runSweep(h, [apiChild({ sessionId: 'cl-1', runtime: 'claude' })]);
    expect(h.events).toHaveLength(0);
  });
});

describe('F3 — live path gating', () => {
  it('a provider stop on a non-API child is not continued', async () => {
    const h = harness();
    const sweep = createInterruptionSweep(h.deps);
    await sweep.handleLiveStop('pi-browser-9', '/tmp/x.jsonl', { supported: true, status: 'failed', pausedReason: 'error', runtimeState: { lastErrorMessage: 'Provider overloaded (HTTP 429)' } }, { apiChild: false, runtime: 'pi' });
    expect(h.dispatches).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('a typed fresh provider stop on an API child continues once and reports interception', async () => {
    const h = harness();
    const sweep = createInterruptionSweep(h.deps);
    const result = await sweep.handleLiveStop('pi-child-1', '/tmp/sessions/pi-child-1.jsonl', { supported: true, status: 'failed', pausedReason: 'error', runtimeState: { lastErrorMessage: 'Provider overloaded (HTTP 429)' } }, { apiChild: true, runtime: 'pi' });
    expect(h.dispatches).toHaveLength(1);
    expect(result.intercepted).toBe(true);
  });

  it('an ambiguous bare abort on an API child is not continued and not intercepted', async () => {
    const h = harness();
    const sweep = createInterruptionSweep(h.deps);
    const result = await sweep.handleLiveStop('pi-child-1', '/tmp/sessions/pi-child-1.jsonl', { supported: true, status: 'paused', pausedReason: 'error', runtimeState: { lastErrorMessage: 'aborted' } }, { apiChild: true, runtime: 'pi' });
    expect(h.dispatches).toHaveLength(0);
    expect(result.intercepted).toBe(false);
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
