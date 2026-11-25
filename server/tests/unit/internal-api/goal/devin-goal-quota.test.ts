/**
 * Devin goal sweeper — provider quota classification (lane C phase 1).
 *
 * The sweeper is the real caller: today it treats every error turn as an
 * anonymous provider strike and DISPATCHES a continuation for strikes 1 and 2
 * before pausing at strike 3 (contract 1.58.3). An exhausted free-model
 * allowance therefore costs repeated model attempts with no reset awareness
 * (53 recorded failures, 2026-11-24).
 *
 * Amendment 02 (binding):
 *   - a quota-classified turn pauses the goal at once and dispatches NOTHING,
 *     on this sweep and on every later sweep (no automatic quota retry);
 *   - the reset instant is anchored to the FAILURE time (`turn.completedAt`),
 *     so a delayed sweep produces the same guidance — never a shifting note;
 *   - reset remains ADVICE: no timer, no automatic resume;
 *   - generic/timeout failures keep today's three-strike behaviour exactly.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DevinGoalControlStore,
  type DevinGoalAutoContinueConfig,
  type DevinGoalRecord,
  type DevinGoalSweeperDeps,
  createDevinGoalSweeper,
  verifyDevinGoalTurn,
} from '../../../../src/internal-api/goal/devin-goal.js';

/** Sanitised shape of the recorded Devin free-model rate-limit failure. */
const ENVELOPE = 'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model.';
const QUOTA_WITH_RESET = `${ENVELOPE} Your limit will reset in 15 minutes (at 21:20 UTC).`;
const QUOTA_NO_RESET = `${ENVELOPE}`;
/** A generic provider failure that must keep the existing strike behaviour. */
const GENERIC_ERROR = 'devin acp session/prompt timed out after 120000ms';

/** 2026-11-24T21:05:00Z — the failure instant the reset statement refers to. */
const FAILED_AT = Date.UTC(2026, 10, 24, 21, 5, 0);

function record(overrides: Partial<DevinGoalRecord> = {}): DevinGoalRecord {
  return {
    objective: 'Ship it',
    maxRuns: 40,
    status: 'running',
    runs: 0,
    autoContinue: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface Harness {
  events: Array<{ sessionId: string; event: { type: string; data?: Record<string, unknown> } }>;
  dispatched: Array<{ sessionId: string; message: string }>;
  store: DevinGoalControlStore;
  turns: Map<string, { completedAt: number; response: string; status?: 'done' | 'error'; error?: string }>;
  running: Set<string>;
  deps: DevinGoalSweeperDeps;
  setNow: (value: number) => void;
}

async function harness(
  records: Record<string, DevinGoalRecord>,
  config: Partial<DevinGoalAutoContinueConfig> = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devin-quota-sweep-'));
  const store = new DevinGoalControlStore(dir);
  for (const [sessionId, rec] of Object.entries(records)) await store.patch(sessionId, rec);
  let now = FAILED_AT;
  const h: Harness = {
    events: [],
    dispatched: [],
    store,
    turns: new Map(),
    running: new Set(),
    setNow: (value: number) => { now = value; },
    deps: undefined as unknown as DevinGoalSweeperDeps,
  };
  h.deps = {
    config: { enabled: true, sweepIntervalMs: 1000, maxRuns: 40, verifyTimeoutMs: 1000, ...config },
    now: () => now,
    listGoalSessions: async () => Object.keys(records),
    isRunning: (id) => h.running.has(id),
    getStore: () => store,
    readLastCompletedTurn: async (id) => h.turns.get(id) ?? null,
    sessionCwd: async () => tmpdir(),
    dispatch: async (id, message) => { h.dispatched.push({ sessionId: id, message }); },
    verify: async (rec, turn) => verifyDevinGoalTurn({ response: turn.response, cwd: tmpdir(), timeoutMs: 1000, verifyCommand: rec.verifyCommand }),
    publish: (sessionId, event) => { h.events.push({ sessionId, event }); },
  };
  return h;
}

describe('devin goal sweeper — provider quota classification', () => {
  it('pauses at once on the FIRST quota turn and dispatches NOTHING', async () => {
    const h = await harness({ s1: record() });
    h.turns.set('s1', { completedAt: FAILED_AT, response: '', status: 'error', error: QUOTA_WITH_RESET });
    await createDevinGoalSweeper(h.deps).sweepOnce();

    const after = await h.store.get('s1');
    expect(after).toMatchObject({
      status: 'paused',
      pausedReason: 'error',
      runs: 0,
      consecutiveErrors: 0,
      lastVerifiedTurnAt: FAILED_AT,
    });
    expect(after?.lastReason).toMatch(/quota/i);
    // The binding requirement: no extra model attempt is spent on a known refusal.
    expect(h.dispatched).toEqual([]);
    expect(h.events.map((e) => e.event.type)).toEqual(['goal_state']);
    expect(h.events[0].event.data).toMatchObject({ status: 'paused', pausedReason: 'error' });
  });

  it('names the reset instant derived from the FAILURE time, not from a delayed sweep clock', async () => {
    const immediate = await harness({ s1: record() });
    immediate.turns.set('s1', { completedAt: FAILED_AT, response: '', status: 'error', error: QUOTA_WITH_RESET });
    await createDevinGoalSweeper(immediate.deps).sweepOnce();
    const immediateReason = (await immediate.store.get('s1'))?.lastReason;

    // The same turn read 25 minutes late (a stalled sweeper, a restart, a busy loop).
    const delayed = await harness({ s1: record() });
    delayed.setNow(FAILED_AT + 25 * 60_000);
    delayed.turns.set('s1', { completedAt: FAILED_AT, response: '', status: 'error', error: QUOTA_WITH_RESET });
    await createDevinGoalSweeper(delayed.deps).sweepOnce();
    const delayedReason = (await delayed.store.get('s1'))?.lastReason;

    expect(delayedReason).toBe(immediateReason);
    // 21:05Z + 15 minutes, stated as 21:20 UTC by the provider itself.
    expect(immediateReason).toContain('21:20');
    expect(delayed.dispatched).toEqual([]);
  });

  it('does not invent a reset instant when the text states none', async () => {
    const h = await harness({ s1: record() });
    h.turns.set('s1', { completedAt: FAILED_AT, response: '', status: 'error', error: QUOTA_NO_RESET });
    await createDevinGoalSweeper(h.deps).sweepOnce();
    const after = await h.store.get('s1');
    expect(after).toMatchObject({ status: 'paused', pausedReason: 'error' });
    expect(after?.lastReason).toMatch(/quota/i);
    expect(after?.lastReason).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(h.dispatched).toEqual([]);
  });

  it('never retries a paused quota goal on later sweeps (no automatic quota retry)', async () => {
    const h = await harness({ s1: record() });
    const sweeper = createDevinGoalSweeper(h.deps);
    h.turns.set('s1', { completedAt: FAILED_AT, response: '', status: 'error', error: QUOTA_WITH_RESET });
    await sweeper.sweepOnce();
    const firstReason = (await h.store.get('s1'))?.lastReason;
    const firstEventCount = h.events.length;

    // Past the stated reset instant, and with time advancing well beyond it.
    for (const offsetMs of [15 * 60_000, 16 * 60_000, 6 * 60 * 60_000]) {
      h.setNow(FAILED_AT + offsetMs);
      await sweeper.sweepOnce();
    }
    expect(h.dispatched).toEqual([]);
    expect(h.events).toHaveLength(firstEventCount);
    const after = await h.store.get('s1');
    expect(after).toMatchObject({ status: 'paused', pausedReason: 'error' });
    expect(after?.lastReason).toBe(firstReason);
  });

  it('resumes only on an explicit re-arm plus a fresh turn, never on the reset clock', async () => {
    const h = await harness({ s1: record() });
    const sweeper = createDevinGoalSweeper(h.deps);
    h.turns.set('s1', { completedAt: FAILED_AT, response: '', status: 'error', error: QUOTA_WITH_RESET });
    await sweeper.sweepOnce();
    expect(h.dispatched).toEqual([]);

    // Explicit operator/parent re-arm (the existing control path).
    await h.store.patch('s1', { status: 'running', pausedReason: undefined, autoContinue: true });
    h.setNow(FAILED_AT + 20 * 60_000);
    h.turns.set('s1', {
      completedAt: FAILED_AT + 20 * 60_000,
      response: `done\nGOAL_STATUS: ACHIEVED`,
    });
    await sweeper.sweepOnce();
    expect(await h.store.get('s1')).toMatchObject({ status: 'achieved' });
  });

  it('keeps the generic three-strike behaviour for an unclassified provider error', async () => {
    const h = await harness({ s1: record() });
    const sweeper = createDevinGoalSweeper(h.deps);
    h.turns.set('s1', { completedAt: FAILED_AT, response: GENERIC_ERROR, status: 'error', error: GENERIC_ERROR });
    await sweeper.sweepOnce();
    expect(await h.store.get('s1')).toMatchObject({ status: 'running', consecutiveErrors: 1 });
    expect(h.dispatched).toHaveLength(1);

    h.turns.set('s1', { completedAt: FAILED_AT + 100, response: GENERIC_ERROR, status: 'error', error: GENERIC_ERROR });
    await sweeper.sweepOnce();
    expect(await h.store.get('s1')).toMatchObject({ status: 'running', consecutiveErrors: 2 });
    expect(h.dispatched).toHaveLength(2);

    h.turns.set('s1', { completedAt: FAILED_AT + 200, response: GENERIC_ERROR, status: 'error', error: GENERIC_ERROR });
    await sweeper.sweepOnce();
    const paused = await h.store.get('s1');
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'error' });
    expect(paused?.lastReason).toMatch(/3 consecutive provider errors/);
    expect(h.dispatched).toHaveLength(2);
  });

  it('does not classify an error turn whose only quota text is quoted assistant prose', async () => {
    const h = await harness({ s1: record() });
    // The failing turn's OWN error is generic; the quota sentence appears only in
    // the turn's response body (assistant prose), which must never set the class.
    h.turns.set('s1', {
      completedAt: FAILED_AT,
      response: `I saw this message: ${QUOTA_WITH_RESET}`,
      status: 'error',
      error: GENERIC_ERROR,
    });
    await createDevinGoalSweeper(h.deps).sweepOnce();
    expect(await h.store.get('s1')).toMatchObject({ status: 'running', consecutiveErrors: 1 });
    expect(h.dispatched).toHaveLength(1);
  });

  it('a quota turn after generic strikes still pauses at once and spends no further attempt', async () => {
    const h = await harness({ s1: record() });
    const sweeper = createDevinGoalSweeper(h.deps);
    h.turns.set('s1', { completedAt: FAILED_AT, response: GENERIC_ERROR, status: 'error', error: GENERIC_ERROR });
    await sweeper.sweepOnce();
    expect(h.dispatched).toHaveLength(1);

    h.turns.set('s1', { completedAt: FAILED_AT + 100, response: '', status: 'error', error: QUOTA_WITH_RESET });
    await sweeper.sweepOnce();
    const after = await h.store.get('s1');
    expect(after).toMatchObject({ status: 'paused', pausedReason: 'error', consecutiveErrors: 0 });
    expect(h.dispatched).toHaveLength(1);
  });
});
