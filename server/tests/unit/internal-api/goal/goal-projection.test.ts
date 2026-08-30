/**
 * Cross-runtime goal function (contract 1.27.0) — Pi projection unit tests.
 *
 * The Pi reader must replicate the goal-engine extension's own disk layout
 * exactly (`~/.pi/agent/goal-engine/<slug>.<sha256(sessionKey)[:16]>.goal.json`),
 * and the projection must map native statuses into the canonical vocabulary
 * documented in docs/plans/CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md §5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { piGoalStatePath, readPiGoalStateFile, readProjectPiGoalState, projectPiGoalState, INVALID_PI_GOAL_STATE } from '../../../../src/internal-api/goal/pi-goal.js';

const BASE_STATE = {
  objective: '',
  planItems: [],
  planDone: [],
  status: 'idle',
  turnCount: 0,
  startedAt: 0,
  completedAt: null,
  verifyCommand: null,
  minReviewCycles: 0,
  reviewCyclesCompleted: 0,
  lastReviewCycleTurn: null,
  lastVerificationStatus: 'not-run',
  lastVerificationMessage: null,
  lastVerifiedAt: null,
  maxTurns: 100,
  pendingQuestion: null,
  progressCurrent: null,
  progressTotal: null,
  progressLabel: null,
  consecutiveErrors: 0,
  lastErrorMessage: null,
  spentInputTokens: 0,
  spentUsd: 0,
  budgetTokens: 5_000_000,
  budgetUsd: null,
};

describe('pi goal state path algorithm', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-goal-home-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.env.HOME = prevHome;
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('matches the extension layout: <slug>.<sha16>.goal.json under ~/.pi/agent/goal-engine', () => {
    const sessionKey = '/home/u/.pi/agent/sessions/abc123/my-session.jsonl';
    const slug = path.basename(sessionKey, '.jsonl');
    const identity = createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
    expect(piGoalStatePath(sessionKey)).toBe(
      path.join(home, '.pi', 'agent', 'goal-engine', `${slug}.${identity}.goal.json`),
    );
  });

  it('sanitises unsafe characters into underscores and caps the slug at 80 chars', () => {
    const sessionKey = '/tmp/w éird/path name!.jsonl';
    const expectedSlug = 'path_name_'.slice(0, 80);
    const identity = createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
    expect(piGoalStatePath(sessionKey)).toBe(
      path.join(home, '.pi', 'agent', 'goal-engine', `${expectedSlug}.${identity}.goal.json`),
    );
  });

  it('reads a written state file back (round-trip)', async () => {
    const sessionKey = '/tmp/some-session.jsonl';
    await fsp.mkdir(path.dirname(piGoalStatePath(sessionKey)), { recursive: true });
    const state = { ...BASE_STATE, objective: 'Do the thing', status: 'running', turnCount: 2 };
    await fsp.writeFile(piGoalStatePath(sessionKey), JSON.stringify(state));
    const read = await readPiGoalStateFile(sessionKey);
    expect(read).not.toBeNull();
    expect(read?.objective).toBe('Do the thing');
  });

  it('returns null when no state file exists yet', async () => {
    expect(await readPiGoalStateFile('/tmp/nope/session-missing.jsonl')).toBeNull();
  });

  it('returns null when the state file holds junk instead of JSON, and projects it as "unknown" via the result reader', async () => {
    const sessionKey = '/tmp/some-session.jsonl';
    await fsp.mkdir(path.dirname(piGoalStatePath(sessionKey)), { recursive: true });
    await fsp.writeFile(piGoalStatePath(sessionKey), "{definitely not json");
    // Raw reader surfaces the invalid sentinel (absent stays null).
    expect(await readPiGoalStateFile(sessionKey)).toBe(INVALID_PI_GOAL_STATE);
    // Absent is 'idle'; present-but-unparseable must be 'unknown', never silent-idle.
    expect((await readProjectPiGoalState(sessionKey)).status).toBe('unknown');
    expect(projectPiGoalState(INVALID_PI_GOAL_STATE).status).toBe('unknown');
  });
});

describe('projectPiGoalState — canonical status mapping', () => {
  it('maps running to "running" with spend/budget/verification fields', () => {
    const p = projectPiGoalState({
      ...BASE_STATE,
      objective: 'Process 160 species',
      status: 'running',
      turnCount: 3,
      startedAt: 1690000000000,
      verifyCommand: 'test -f done.marker',
      lastVerificationStatus: 'failed',
      lastVerificationMessage: 'marker missing',
      spentInputTokens: 1234,
      spentUsd: 0.42,
      budgetTokens: 5_000_000,
      budgetUsd: 12.5,
    } as never);
    expect(p.supported).toBe(true);
    expect(p.status).toBe('running');
    expect(p.objective).toBe('Process 160 species');
    expect(p.runs).toBe(3);
    expect(p.maxRuns).toBe(100);
    expect(p.startedAt).toBe(1690000000000);
    expect(p.completedAt).toBeNull();
    expect(p.verification).toEqual({ status: 'failed', command: 'test -f done.marker', message: 'marker missing' });
    expect(p.spend).toEqual({ inputTokens: 1234, usd: 0.42 });
    expect(p.budget).toEqual({ tokens: 5_000_000, usd: 12.5 });
    expect(p.pausedReason ?? null).toBeNull();
  });

  it('maps wrapping-up to "wrapping_up"', () => {
    const p = projectPiGoalState({ ...BASE_STATE, objective: 'x', status: 'wrapping-up' } as never);
    expect(p.status).toBe('wrapping_up');
  });

  it('achieved: idle status plus completedAt', () => {
    const p = projectPiGoalState({
      ...BASE_STATE,
      objective: 'done deal',
      status: 'idle',
      completedAt: 1690000100000,
      turnCount: 5,
      lastVerificationStatus: 'passed',
    } as never);
    expect(p.status).toBe('achieved');
    expect(p.completedAt).toBe(1690000100000);
    expect(p.verification?.status).toBe('passed');
  });

  it('paused: plain pause stays "paused"; a pending question is reported as pausedReason "question"', () => {
    const plain = projectPiGoalState({ ...BASE_STATE, objective: 'x', status: 'paused' } as never);
    expect(plain.status).toBe('paused');
    expect(plain.pausedReason ?? null).toBeNull();

    const question = projectPiGoalState({
      ...BASE_STATE,
      objective: 'x',
      status: 'paused',
      pendingQuestion: 'Which API should I use?',
    } as never);
    expect(question.status).toBe('paused');
    expect(question.pausedReason).toBe('question');
    expect(question.lastReason).toBe('Which API should I use?');
  });

  it('failed: a governor error-pause surfaces as "failed"', () => {
    const p = projectPiGoalState({
      ...BASE_STATE,
      objective: 'x',
      status: 'paused',
      consecutiveErrors: 3,
      lastErrorMessage: 'model kept failing',
    } as never);
    expect(p.status).toBe('failed');
    expect(p.pausedReason).toBe('error');
  });

  it('tombstone after clear / fresh session maps to "idle"', () => {
    const cleared = projectPiGoalState({ ...BASE_STATE } as never);
    expect(cleared.status).toBe('idle');

    // A malformed/unrecognised combination must not lie.
    const weird = projectPiGoalState({ ...BASE_STATE, objective: 'still here?', status: 'idle' } as never);
    expect(weird.status).toBe('unknown');
  });

  it('keeps the verbatim native state under runtimeState', () => {
    const raw = { ...BASE_STATE, objective: 'keep me', status: 'running' };
    const p = projectPiGoalState(raw as never);
    expect((p.runtimeState as typeof raw).objective).toBe('keep me');
  });

  it('handles an absent payload as idle-with-support (never a guess)', () => {
    const p = projectPiGoalState(null);
    expect(p.status).toBe('idle');
    expect(p.supported).toBe(true);
  });
});

describe('projectPiGoalState — agent-suggested goal (contract 1.28.0)', () => {
  it('idle plus pendingSuggestion maps to "suggested" with the suggested objective', () => {
    const projection = projectPiGoalState({
      ...BASE_STATE,
      status: 'idle',
      objective: '',
      pendingSuggestion: {
        objective: 'Refactor the payments module end to end',
        rationale: 'multi-stage, long-horizon work',
        suggestedAt: 1_788_000_000_000,
      },
    } as never);
    expect(projection.supported).toBe(true);
    expect(projection.status).toBe('suggested');
    expect(projection.objective).toBe('Refactor the payments module end to end');
    expect(projection.pausedReason).toBeNull();
    // never terminal: a suggestion is not an ended goal
    expect([ 'achieved', 'cleared', 'failed' ]).not.toContain(projection.status);
  });

  it('suggested without rationale still projects; junk suggestion fields degrade honestly', () => {
    const projection = projectPiGoalState({
      ...BASE_STATE,
      status: 'idle',
      objective: '',
      pendingSuggestion: { objective: 'Big task', suggestedAt: 5 },
    } as never);
    expect(projection.status).toBe('suggested');
    expect(projection.objective).toBe('Big task');
  });

  it('pendingSuggestion without an objective is not "suggested" — falls back to idle', () => {
    const projection = projectPiGoalState({
      ...BASE_STATE,
      status: 'idle',
      objective: '',
      pendingSuggestion: { rationale: 'half-written', suggestedAt: 5 },
    } as never);
    expect(projection.status).toBe('idle');
  });

  it('an active goal wins over a leftover suggestion; achieved stays achieved', () => {
    const suggestion = { objective: 'Stale suggestion', rationale: null, suggestedAt: 1 };
    const running = projectPiGoalState({
      ...BASE_STATE,
      status: 'running',
      objective: 'Active objective',
      pendingSuggestion: suggestion,
    } as never);
    expect(running.status).toBe('running');
    expect(running.objective).toBe('Active objective');

    const achieved = projectPiGoalState({
      ...BASE_STATE,
      status: 'idle',
      objective: 'Done objective',
      completedAt: 123,
      pendingSuggestion: suggestion,
    } as never);
    expect(achieved.status).toBe('achieved');
    expect(achieved.objective).toBe('Done objective');
  });

  it('a tombstone (cleared) state with no suggestion stays "idle"', () => {
    const projection = projectPiGoalState({ ...BASE_STATE, status: 'idle' } as never);
    expect(projection.status).toBe('idle');
  });
});
