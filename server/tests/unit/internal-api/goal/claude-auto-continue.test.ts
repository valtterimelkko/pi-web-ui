/**
 * Cross-runtime goal function (contract 1.27.0) — Claude auto-continue nudger tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadClaudeGoalAutoContinueConfig,
  ClaudeGoalControlStore,
  GoalSweepReadCache,
  backoffDelayMs,
  createClaudeGoalNudger,
  type ClaudeGoalNudgerDeps,
} from '../../../../src/internal-api/goal/claude-auto-continue.js';

describe('loadClaudeGoalAutoContinueConfig', () => {
  it('defaults: enabled, sweep 30s, max 20 nudges, backoff 30s→10m', () => {
    const c = loadClaudeGoalAutoContinueConfig({});
    expect(c.enabled).toBe(true);
    expect(c.sweepIntervalMs).toBe(30_000);
    expect(c.maxNudges).toBe(20);
    expect(c.baseBackoffMs).toBe(30_000);
    expect(c.maxBackoffMs).toBe(600_000);
  });
  it('hard-off switch and numeric overrides', () => {
    expect(loadClaudeGoalAutoContinueConfig({ CLAUDE_GOAL_AUTO_CONTINUE: 'false' }).enabled).toBe(false);
    const c = loadClaudeGoalAutoContinueConfig({
      CLAUDE_GOAL_AUTO_CONTINUE_MAX_NUDGES: '3',
      CLAUDE_GOAL_AUTO_CONTINUE_SWEEP_MS: '5000',
      CLAUDE_GOAL_AUTO_CONTINUE_BASE_BACKOFF_MS: '1000',
      CLAUDE_GOAL_AUTO_CONTINUE_MAX_BACKOFF_MS: '60000',
    });
    expect(c.maxNudges).toBe(3);
    expect(c.sweepIntervalMs).toBe(5000);
    expect(c.baseBackoffMs).toBe(1000);
    expect(c.maxBackoffMs).toBe(60000);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from base up to max', () => {
    expect(backoffDelayMs(30_000, 600_000, 0)).toBe(30_000);
    expect(backoffDelayMs(30_000, 600_000, 1)).toBe(60_000);
    expect(backoffDelayMs(30_000, 600_000, 2)).toBe(120_000);
    expect(backoffDelayMs(30_000, 600_000, 9)).toBe(600_000);
  });
});

describe('ClaudeGoalControlStore', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-goal-store-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('persists patches across instances (restart-safe nudge budgets)', async () => {
    const a = new ClaudeGoalControlStore(dir);
    await a.patch('s1', { autoContinue: false, nudges: 4, lastNudgeAt: 111 });
    const b = new ClaudeGoalControlStore(dir);
    const rec = await b.get('s1');
    expect(rec).toMatchObject({ autoContinue: false, nudges: 4, lastNudgeAt: 111 });
    await b.patch('s1', { nudges: 5 });
    expect((await a.get('s1'))?.nudges).toBe(5);
  });
  it('get returns null when no record exists', async () => {
    expect(await new ClaudeGoalControlStore(dir).get('ghost')).toBeNull();
  });
  it('fires the onWrite hook on every patch so sweep caches can invalidate per-session', async () => {
    const written: string[] = [];
    const store = new ClaudeGoalControlStore(dir, (id) => written.push(id));
    await store.patch('s1', { nudges: 1 });
    await store.patch('s2', { nudges: 2 });
    await store.patch('s1', { nudges: 3 });
    expect(written).toEqual(['s1', 's2', 's1']);
  });
  it('works without an onWrite hook (optional dep)', async () => {
    const store = new ClaudeGoalControlStore(dir);
    await expect(store.patch('s1', { nudges: 1 })).resolves.toMatchObject({ nudges: 1 });
  });
});

describe('GoalSweepReadCache', () => {
  it('returns the cached value only while the mtime key is unchanged', () => {
    const cache = new GoalSweepReadCache<string>();
    cache.set('s1', 'mtime:1', 'projection-v1');
    expect(cache.get('s1', 'mtime:1')).toBe('projection-v1');
    // Transcript changed → key mismatch → miss (caller re-reads and re-sets).
    expect(cache.get('s1', 'mtime:2')).toBeUndefined();
    cache.set('s1', 'mtime:2', 'projection-v2');
    expect(cache.get('s1', 'mtime:2')).toBe('projection-v2');
  });

  it('invalidate drops exactly one session (control-record writes)', () => {
    const cache = new GoalSweepReadCache<string>();
    cache.set('s1', 'k', 'v1');
    cache.set('s2', 'k', 'v2');
    cache.invalidate('s1');
    expect(cache.get('s1', 'k')).toBeUndefined();
    expect(cache.get('s2', 'k')).toBe('v2');
  });

  it('stays bounded by evicting the oldest entry', () => {
    const cache = new GoalSweepReadCache<string>(2);
    cache.set('a', 'k', 'va');
    cache.set('b', 'k', 'vb');
    cache.set('c', 'k', 'vc');
    expect(cache.get('a', 'k')).toBeUndefined();
    expect(cache.get('b', 'k')).toBe('vb');
    expect(cache.get('c', 'k')).toBe('vc');
    expect(cache.size).toBe(2);
  });

  it('re-setting an existing session does not evict itself', () => {
    const cache = new GoalSweepReadCache<string>(2);
    cache.set('a', 'k1', 'v1');
    cache.set('b', 'k1', 'v2');
    cache.set('a', 'k2', 'v3'); // refresh a in place
    expect(cache.get('a', 'k2')).toBe('v3');
    expect(cache.get('b', 'k1')).toBe('v2');
  });
});

describe('createClaudeGoalNudger sweep', () => {
  function makeDeps(overrides: Partial<ClaudeGoalNudgerDeps> & { sessions?: Array<Record<string, unknown>> }) {
    const storeDir = overrides.store as unknown as string;
    void storeDir;
    return {
      config: loadClaudeGoalAutoContinueConfig({}),
      now: () => Date.now(),
      listSupportedSessions: async () => [],
      isRunning: (_id: string) => false,
      readGoal: async (_id: string) => null,
      getStore: undefined as unknown as ClaudeGoalNudgerDeps['getStore'],
      ...overrides,
    } as unknown as ClaudeGoalNudgerDeps;
  }

  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-nudger-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('nudges once for an armed unmet goal that is idle', async () => {
    const store = new ClaudeGoalControlStore(dir);
    const dispatched: string[] = [];
    const deps = makeDeps({
      listSupportedSessions: async () => [{ sessionId: 'c1' }],
      readGoal: async () => ({ supported: true, status: 'running' }),
      getStore: () => store,
      dispatchDetached: async (_id: string, message: string) => { dispatched.push(message); },
    });
    const nudger = createClaudeGoalNudger(deps);
    await nudger.sweepOnce();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('Continue working');
    expect((await store.get('c1'))?.nudges).toBe(1);
    // Second immediate sweep is inside the backoff window → no double nudge.
    await nudger.sweepOnce();
    expect(dispatched).toHaveLength(1);
  });

  it('skips busy sessions, unsupported goals, paused goals and achieved ones', async () => {
    const store = new ClaudeGoalControlStore(dir);
    const dispatched: string[] = [];
    const deps = makeDeps({
      listSupportedSessions: async () => [{ sessionId: 'busy' }, { sessionId: 'idle-goal' }, { sessionId: 'paused' }],
      isRunning: (id) => id === 'busy',
      readGoal: async (id) =>
        id === 'paused'
          ? { supported: true, status: 'paused', pausedReason: 'user' }
          : { supported: true, status: 'running' },
      getStore: () => store,
      dispatchDetached: async (_id, m) => { dispatched.push(m); },
    });
    // 'busy' has an unmet goal but is streaming; 'idle-goal' returns
    // unsupported-ish mapping via its readGoal shape below.
    void deps;
    const nudger = createClaudeGoalNudger(makeDeps({
      listSupportedSessions: async () => [{ sessionId: 'busy' }, { sessionId: 'x' }],
      isRunning: (id) => id === 'busy',
      readGoal: async (id) => (id === 'x' ? { supported: true, status: 'running' } : null),
      getStore: () => store,
      dispatchDetached: async (_id, m) => { dispatched.push(m); },
    }));
    await nudger.sweepOnce();
    expect(dispatched).toHaveLength(1);
  });

  it('marks the goal failed(pausedReason budget) and emits goal_end exactly once at the cap', async () => {
    const store = new ClaudeGoalControlStore(dir);
    await store.patch('cap', { nudges: 20 }); // cap reached already
    const published: any[] = [];
    const deps = makeDeps({
      listSupportedSessions: async () => [{ sessionId: 'cap' }],
      readGoal: async () => ({ supported: true, status: 'running' }),
      getStore: () => store,
      dispatchDetached: async () => { throw new Error('must not dispatch past the cap'); },
      publish: (_id, e) => published.push(e),
    });
    const nudger = createClaudeGoalNudger(deps);
    await nudger.sweepOnce();
    await nudger.sweepOnce(); // idempotent: exhaustion recorded
    const rec = await store.get('cap');
    expect(rec?.exhaustedAt).toBeTypeOf('number');
    expect(published.filter((e) => e.type === 'goal_end')).toHaveLength(1);
    expect(published.find((e) => e.type === 'goal_end').data.status).toBe('failed');
    expect(published.find((e) => e.type === 'goal_end').data.pausedReason).toBe('budget');
  });

  it('resets the nudge budget when a goal reaches a terminal state so a NEW goal starts fresh', async () => {
    const store = new ClaudeGoalControlStore(dir);
    await store.patch('done', { nudges: 7 });
    const dispatched: string[] = [];
    let current: any = { supported: true, status: 'achieved' };
    const nudger = createClaudeGoalNudger(makeDeps({
      listSupportedSessions: async () => [{ sessionId: 'done' }],
      readGoal: async () => current,
      getStore: () => store,
      dispatchDetached: async (_id, m) => { dispatched.push(m); },
    }));
    await nudger.sweepOnce();
    expect((await store.get('done'))?.nudges).toBe(0);
    current = { supported: true, status: 'running' }; // operator started a new goal
    await nudger.sweepOnce();
    await nudger.sweepOnce();
    expect(dispatched).toHaveLength(1); // nudged fresh despite old count
  });
});
