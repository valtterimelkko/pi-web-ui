/**
 * Antigravity goal function (contract 1.38.0) — server-side goal manager.
 *
 * `agy` has no native /goal. The antigravity goal is therefore fully
 * server-owned: a per-session control store plus a turn-driven auto-continue
 * sweeper (the Command Code "wide" pattern, minus the mod — verification and
 * continuation both live in this process).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AGY_GOAL_SENTINEL,
  type AntigravityGoalRecord,
  AntigravityGoalControlStore,
  type AgyGoalAutoContinueConfig,
  type AgyGoalSweeperDeps,
  buildAgyGoalContinuationPrompt,
  buildAgyGoalStartPrompt,
  createAgyGoalSweeper,
  loadAgyGoalAutoContinueConfig,
  parseAgyGoalCommand,
  projectAgyGoal,
  verifyAgyGoalTurn,
} from '../../../../src/internal-api/goal/antigravity-goal.js';

// ─── parseAgyGoalCommand ─────────────────────────────────────────────────────

describe('parseAgyGoalCommand', () => {
  it('parses a bare objective as start', () => {
    const parsed = parseAgyGoalCommand('/goal Fix all lint errors');
    expect(parsed).toEqual({ kind: 'start', objective: 'Fix all lint errors', verifyCommand: undefined });
  });

  it('strips one wrapping pair of quotes from the objective', () => {
    const parsed = parseAgyGoalCommand('/goal "Fix all lint errors"');
    expect(parsed).toEqual({ kind: 'start', objective: 'Fix all lint errors', verifyCommand: undefined });
  });

  it('parses --verify with a quoted command before the objective', () => {
    const parsed = parseAgyGoalCommand('/goal --verify "npm run lint" Fix all lint errors');
    expect(parsed).toEqual({ kind: 'start', objective: 'Fix all lint errors', verifyCommand: 'npm run lint' });
  });

  it('parses --verify= single-token form', () => {
    const parsed = parseAgyGoalCommand('/goal --verify=make-check Fix lint');
    expect(parsed).toEqual({ kind: 'start', objective: 'Fix lint', verifyCommand: 'make-check' });
  });

  it('maps control verbs (spaced, hyphenated, pause-now)', () => {
    expect(parseAgyGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
    expect(parseAgyGoalCommand('/goal pause-now')).toEqual({ kind: 'pause' });
    expect(parseAgyGoalCommand('/goal-pause')).toEqual({ kind: 'pause' });
    expect(parseAgyGoalCommand('/goal resume')).toEqual({ kind: 'resume' });
    expect(parseAgyGoalCommand('/goal continue')).toEqual({ kind: 'resume' });
    expect(parseAgyGoalCommand('/goal clear')).toEqual({ kind: 'clear' });
    expect(parseAgyGoalCommand('/goal stop')).toEqual({ kind: 'clear' });
    expect(parseAgyGoalCommand('/goal status')).toEqual({ kind: 'status' });
    expect(parseAgyGoalCommand('/goal')).toEqual({ kind: 'status' });
  });

  it('returns null for non-goal prompts and near-misses', () => {
    expect(parseAgyGoalCommand('hello world')).toBeNull();
    expect(parseAgyGoalCommand('/goals list')).toBeNull();
    expect(parseAgyGoalCommand('/goalist')).toBeNull();
    expect(parseAgyGoalCommand('/goalverbose')).toBeNull();
  });

  it('preserves objective case and tolerates padded input', () => {
    const parsed = parseAgyGoalCommand('  /goal   Ship the MiXeD-case Release  ');
    expect(parsed).toEqual({ kind: 'start', objective: 'Ship the MiXeD-case Release', verifyCommand: undefined });
  });
});

// ─── control store ───────────────────────────────────────────────────────────

describe('AntigravityGoalControlStore', () => {
  it('answers null for sessions without a record and round-trips patches', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agy-goal-'));
    const store = new AntigravityGoalControlStore(dir);
    await expect(store.get('s1')).resolves.toBeNull();

    const patched = await store.patch('s1', { objective: 'Ship it', status: 'running', runs: 0, maxRuns: 100, createdAt: 1, updatedAt: 2, autoContinue: true });
    expect(patched.status).toBe('running');
    const raw = JSON.parse(await readFile(path.join(dir, 's1.json'), 'utf8'));
    expect(raw.objective).toBe('Ship it');
    await expect(store.get('s1')).resolves.toMatchObject({ objective: 'Ship it' });

    const again = await store.patch('s1', { runs: 3 });
    expect(again.runs).toBe(3);
    expect(again.objective).toBe('Ship it');
  });
});

// ─── projection ──────────────────────────────────────────────────────────────

describe('projectAgyGoal', () => {
  it('projects idle (supported) when no record exists', () => {
    expect(projectAgyGoal(null)).toEqual({ supported: true, status: 'idle' });
  });

  it('projects a running goal with verification and budget', () => {
    const record: AntigravityGoalRecord = {
      objective: 'Ship it',
      maxRuns: 100,
      status: 'running',
      runs: 4,
      autoContinue: true,
      createdAt: 10,
      updatedAt: 20,
      verification: { status: 'self_reported', message: 'not yet' },
      lastReason: 'not yet',
    };
    const projection = projectAgyGoal(record);
    expect(projection).toMatchObject({
      supported: true,
      status: 'running',
      objective: 'Ship it',
      runs: 4,
      maxRuns: 100,
      verification: { status: 'self_reported', message: 'not yet' },
      lastReason: 'not yet',
      autoContinue: true,
    });
  });

  it('projects achieved with completedAt and paused with reason', () => {
    const done: AntigravityGoalRecord = {
      objective: 'Ship it', maxRuns: 100, status: 'achieved', runs: 2, autoContinue: true,
      createdAt: 1, updatedAt: 5, completedAt: 6, verification: { status: 'passed' },
    };
    expect(projectAgyGoal(done)).toMatchObject({ status: 'achieved', completedAt: 6 });

    const paused: AntigravityGoalRecord = { ...done, status: 'paused', pausedReason: 'user', completedAt: null };
    expect(projectAgyGoal(paused)).toMatchObject({ status: 'paused', pausedReason: 'user' });
  });
});

// ─── prompts + sentinel ──────────────────────────────────────────────────────

describe('goal prompts', () => {
  it('start prompt carries the objective and the sentinel only without verifyCommand', () => {
    const withVerify = buildAgyGoalStartPrompt('Ship it', true);
    expect(withVerify).toContain('Ship it');
    expect(withVerify).not.toContain(AGY_GOAL_SENTINEL);

    const selfReport = buildAgyGoalStartPrompt('Ship it', false);
    expect(selfReport).toContain(AGY_GOAL_SENTINEL);
  });

  it('continuation prompt is request-shaped and sentinel-aware', () => {
    const withVerify = buildAgyGoalContinuationPrompt('Ship it', true);
    expect(withVerify).toContain('Ship it');
    expect(withVerify).not.toContain(AGY_GOAL_SENTINEL);
    expect(buildAgyGoalContinuationPrompt('Ship it', false)).toContain(AGY_GOAL_SENTINEL);
  });
});

// ─── verification ────────────────────────────────────────────────────────────

describe('verifyAgyGoalTurn', () => {
  it('command verifier: exit 0 passes, non-zero fails', async () => {
    const pass = await verifyAgyGoalTurn({ verifyCommand: 'exit 0', response: '', cwd: tmpdir(), timeoutMs: 5000 });
    expect(pass).toEqual({ met: true, verification: { status: 'passed', command: 'exit 0', message: null } });

    const fail = await verifyAgyGoalTurn({ verifyCommand: 'exit 3', response: '', cwd: tmpdir(), timeoutMs: 5000 });
    expect(fail.met).toBe(false);
    expect(fail.verification.status).toBe('failed');
    expect(fail.verification.command).toBe('exit 3');
  });

  it('command verifier timeouts report failed with a message', async () => {
    const result = await verifyAgyGoalTurn({ verifyCommand: 'sleep 2', response: '', cwd: tmpdir(), timeoutMs: 200 });
    expect(result.met).toBe(false);
    expect(result.verification.status).toBe('failed');
    expect(result.verification.message).toContain('timed out');
  });

  it('sentinel scan self-reports achievement and stays honest otherwise', async () => {
    const met = await verifyAgyGoalTurn({ response: `All done.\n${AGY_GOAL_SENTINEL}`, cwd: tmpdir(), timeoutMs: 1000 });
    expect(met).toEqual({ met: true, verification: { status: 'self_reported', command: null, message: 'model self-reported goal achievement' } });

    const unmet = await verifyAgyGoalTurn({ response: 'Still working on it.', cwd: tmpdir(), timeoutMs: 1000 });
    expect(unmet).toEqual({ met: false, verification: { status: 'not_run', command: null, message: null } });
  });

  it('prefers the command verifier when both are available', async () => {
    const result = await verifyAgyGoalTurn({
      verifyCommand: 'exit 1',
      response: AGY_GOAL_SENTINEL,
      cwd: tmpdir(),
      timeoutMs: 5000,
    });
    expect(result.met).toBe(false);
    expect(result.verification.status).toBe('failed');
  });
});

// ─── sweeper ─────────────────────────────────────────────────────────────────

function record(overrides: Partial<AntigravityGoalRecord> = {}): AntigravityGoalRecord {
  return {
    objective: 'Ship it',
    maxRuns: 3,
    status: 'running',
    runs: 0,
    autoContinue: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface SweeperHarness {
  events: Array<{ sessionId: string; event: { type: string } }>;
  dispatched: Array<{ sessionId: string; message: string }>;
  store: AntigravityGoalControlStore;
  dir: string;
  turns: Map<string, { completedAt: number; response: string } | null>;
  running: Set<string>;
  deps: AgyGoalSweeperDeps;
}

async function harness(records: Record<string, AntigravityGoalRecord>, config: Partial<AgyGoalAutoContinueConfig> = {}): Promise<SweeperHarness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-sweep-'));
  const store = new AntigravityGoalControlStore(dir);
  for (const [sessionId, rec] of Object.entries(records)) await store.patch(sessionId, rec);
  const h: SweeperHarness = {
    events: [],
    dispatched: [],
    store,
    dir,
    turns: new Map(),
    running: new Set(),
    deps: undefined as unknown as AgyGoalSweeperDeps,
  };
  h.deps = {
    config: { enabled: true, sweepIntervalMs: 1000, maxRuns: 3, verifyTimeoutMs: 1000, ...config },
    now: () => 1000,
    listGoalSessions: async () => Object.keys(records),
    isRunning: (id) => h.running.has(id),
    getStore: () => store,
    readLastCompletedTurn: async (id) => h.turns.get(id) ?? null,
    sessionCwd: async (id) => tmpdir(),
    dispatch: async (id, message) => { h.dispatched.push({ sessionId: id, message }); },
    verify: async (rec, turn) => verifyAgyGoalTurn({ response: turn.response, cwd: tmpdir(), timeoutMs: 1000, verifyCommand: rec.verifyCommand }),
    publish: (sessionId, event) => { h.events.push({ sessionId, event }); },
  };
  return h;
}

describe('createAgyGoalSweeper', () => {
  it('verifies the newly completed turn and achieves on the sentinel', async () => {
    const h = await harness({ s1: record({ lastVerifiedTurnAt: 0 }) });
    h.turns.set('s1', { completedAt: 500, response: `done\n${AGY_GOAL_SENTINEL}` });
    await createAgyGoalSweeper(h.deps).sweepOnce();

    const after = await h.store.get('s1');
    expect(after).toMatchObject({ status: 'achieved', runs: 1, completedAt: 1000, lastVerifiedTurnAt: 500 });
    expect(h.dispatched).toEqual([]);
    expect(h.events.map((e) => e.event.type)).toEqual(['goal_state', 'goal_end']);
  });

  it('continues on an unmet turn within budget and records the verification', async () => {
    const h = await harness({ s1: record() });
    h.turns.set('s1', { completedAt: 400, response: 'still working' });
    await createAgyGoalSweeper(h.deps).sweepOnce();

    const after = await h.store.get('s1');
    expect(after).toMatchObject({ status: 'running', runs: 1, lastVerifiedTurnAt: 400 });
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].message).toContain('Ship it');
    expect(h.dispatched[0].message).toContain(AGY_GOAL_SENTINEL);
    expect(h.events.map((e) => e.event.type)).toEqual(['goal_state']);
  });

  it('marks failed/budget at the run ceiling and emits goal_end once', async () => {
    const h = await harness({ s1: record({ runs: 2, maxRuns: 3 }) });
    h.turns.set('s1', { completedAt: 900, response: 'still working' });
    const sweeper = createAgyGoalSweeper(h.deps);
    await sweeper.sweepOnce();

    const after = await h.store.get('s1');
    expect(after).toMatchObject({ status: 'failed', pausedReason: 'budget', runs: 3 });
    expect(h.dispatched).toEqual([]);
    expect(h.events.map((e) => e.event.type)).toEqual(['goal_state', 'goal_end']);

    // Terminal state: a re-sweep must not re-emit or re-dispatch.
    await sweeper.sweepOnce();
    expect(h.events).toHaveLength(2);
    expect(h.dispatched).toEqual([]);
  });

  it('skips busy sessions, paused/cleared goals, and already-verified turns', async () => {
    const h = await harness({
      busy: record(),
      paused: record({ status: 'paused', pausedReason: 'user', autoContinue: false }),
      done: record({ status: 'achieved' }),
      stale: record({ lastVerifiedTurnAt: 250 }),
    });
    h.running.add('busy');
    h.turns.set('busy', { completedAt: 10, response: 'x' });
    h.turns.set('paused', { completedAt: 10, response: AGY_GOAL_SENTINEL });
    h.turns.set('done', { completedAt: 10, response: AGY_GOAL_SENTINEL });
    h.turns.set('stale', { completedAt: 200, response: AGY_GOAL_SENTINEL });
    await createAgyGoalSweeper(h.deps).sweepOnce();

    expect(h.dispatched).toEqual([]);
    expect(h.events).toEqual([]);
    expect(await h.store.get('paused')).toMatchObject({ status: 'paused' });
    expect(await h.store.get('stale')).toMatchObject({ runs: 0, lastVerifiedTurnAt: 250 });
  });

  it('resumes paused goals only via autoContinue re-arm + a fresh turn', async () => {
    const h = await harness({ s1: record({ status: 'paused', pausedReason: 'user', autoContinue: false }) });
    h.turns.set('s1', { completedAt: 300, response: AGY_GOAL_SENTINEL });
    await createAgyGoalSweeper(h.deps).sweepOnce();
    expect(h.events).toEqual([]);

    await h.store.patch('s1', { status: 'running', pausedReason: undefined, autoContinue: true });
    await createAgyGoalSweeper(h.deps).sweepOnce();
    expect(await h.store.get('s1')).toMatchObject({ status: 'achieved' });
  });

  it('does nothing when disabled', async () => {
    const h = await harness({ s1: record() }, { enabled: false });
    h.turns.set('s1', { completedAt: 10, response: AGY_GOAL_SENTINEL });
    await createAgyGoalSweeper(h.deps).sweepOnce();
    expect(h.events).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(await h.store.get('s1')).toMatchObject({ status: 'running', runs: 0 });
  });
});

// ─── config ──────────────────────────────────────────────────────────────────

describe('loadAgyGoalAutoContinueConfig', () => {
  it('defaults are sane and env overrides apply', () => {
    const defaults = loadAgyGoalAutoContinueConfig({});
    expect(defaults).toEqual({ enabled: true, sweepIntervalMs: 15_000, maxRuns: 100, verifyTimeoutMs: 60_000 });

    const overridden = loadAgyGoalAutoContinueConfig({
      AGY_GOAL_AUTO_CONTINUE: 'false',
      AGY_GOAL_SWEEP_MS: '5000',
      AGY_GOAL_MAX_RUNS: '7',
      AGY_GOAL_VERIFY_TIMEOUT_MS: '1234',
    });
    expect(overridden).toEqual({ enabled: false, sweepIntervalMs: 5000, maxRuns: 7, verifyTimeoutMs: 1234 });
  });
});

// sanity: store writes stay private-ish (0700 dir semantics live with the session dir owner)
describe('AntigravityGoalControlStore persistence', () => {
  it('keeps records as plain JSON on disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agy-goal2-'));
    const store = new AntigravityGoalControlStore(dir);
    await store.patch('x', { objective: 'o', status: 'cleared', runs: 0, maxRuns: 1, createdAt: 1, updatedAt: 2, autoContinue: false, clearedAt: 9 });
    const raw = JSON.parse(await writeFile_await(dir));
    expect(raw.status).toBe('cleared');
  });

  async function writeFile_await(dir: string): Promise<string> {
    return readFile(path.join(dir, 'x.json'), 'utf8');
  }
});
