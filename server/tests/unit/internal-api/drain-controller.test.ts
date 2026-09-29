import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DrainController,
  consumeDrainRecord,
  readDrainRecord,
  type DrainBusySession,
  type DrainRunRef,
} from '../../../src/internal-api/drain-controller.js';

/**
 * B4 drain-then-restart: the drain state machine.
 *
 * idle → draining → settled | timed_out → (hold expires | cancel) → idle
 *
 * Settling requires BOTH zero active execution turns (excluding quarantined
 * capacity debt, which no wait can clear) AND zero nonterminal run receipts —
 * "drain waits only for turns and ignores nonterminal receipts" is the plan's
 * explicit not-victory case.
 */

interface FakeAdmission {
  state: { since: number; reason: string } | null;
  activeTurns: number;
  setDraining(state: { since: number; reason: string } | null): void;
  getDraining(): { since: number; reason: string } | null;
  snapshot(): { activeTurns: number };
}

function fakeAdmission(): FakeAdmission {
  const admission: FakeAdmission = {
    state: null,
    activeTurns: 0,
    setDraining(state) { admission.state = state; },
    getDraining() { return admission.state; },
    snapshot() { return { activeTurns: admission.activeTurns }; },
  };
  return admission;
}

const run = (runId: string, status = 'started'): DrainRunRef => ({ runId, sessionId: `s-${runId}`, runtime: 'pi', status });

describe('DrainController', () => {
  let dir: string;
  let recordPath: string;
  let admission: FakeAdmission;
  let runs: DrainRunRef[];
  let quarantined: number;
  let busy: DrainBusySession[];
  let controller: DrainController | undefined;

  const make = (overrides: Partial<ConstructorParameters<typeof DrainController>[0]> = {}): DrainController => {
    controller = new DrainController({
      admission,
      listNonterminalRuns: () => runs.map((r) => ({ ...r })),
      listBusySessions: () => busy.map((b) => ({ ...b })),
      quarantinedTurns: () => quarantined,
      recordPath,
      pollIntervalMs: 5,
      ...overrides,
    });
    return controller;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pi-drain-controller-'));
    recordPath = path.join(dir, 'internal-api-drain.json');
    admission = fakeAdmission();
    runs = [];
    quarantined = 0;
    busy = [];
  });

  afterEach(() => {
    controller?.shutdown();
    controller = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts idle with admission open', () => {
    const drain = make();
    expect(drain.status()).toMatchObject({ state: 'idle', draining: false, cutOffRunIds: [] });
    expect(admission.state).toBeNull();
  });

  it('closes admission on start and settles at once when nothing is in flight', async () => {
    const drain = make();
    const { status, joined } = drain.start({ reason: 'deploy 1.51.0', timeoutMs: 1_000 });
    expect(joined).toBe(false);
    // Nothing in flight: the verdict is reached synchronously inside start().
    expect(status.state).toBe('settled');
    expect(admission.state).toMatchObject({ reason: 'deploy 1.51.0' });
    const outcome = await drain.waitForOutcome();
    expect(outcome).toMatchObject({
      state: 'settled',
      draining: true,
      initial: { activeTurns: 0, nonterminalRuns: 0 },
      remaining: { activeTurns: 0, nonterminalRuns: 0, runs: [] },
      cutOffRunIds: [],
    });
    // Admission stays closed after settling: the restart is what ends a drain.
    expect(admission.state).not.toBeNull();
  });

  it('waits for nonterminal receipts even when no turn is active (receipts, not just turns)', async () => {
    runs = [run('queued-1', 'queued')];
    admission.activeTurns = 0;
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 40));
    expect(drain.status().state).toBe('draining');
    expect(drain.status().remaining).toMatchObject({ nonterminalRuns: 1, runs: [{ runId: 'queued-1', status: 'queued' }] });
    runs = [];
    const outcome = await drain.waitForOutcome();
    expect(outcome.state).toBe('settled');
    expect(outcome.completedDuringDrain).toBe(1);
  });

  it('waits for active turns even when no receipt is nonterminal', async () => {
    admission.activeTurns = 1;
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 40));
    expect(drain.status()).toMatchObject({ state: 'draining', remaining: { activeTurns: 1 } });
    admission.activeTurns = 0;
    expect((await drain.waitForOutcome()).state).toBe('settled');
  });

  it('does not wait on quarantined capacity debt, which no wait can clear', async () => {
    admission.activeTurns = 2;
    quarantined = 2;
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 5_000 });
    const outcome = await drain.waitForOutcome();
    expect(outcome).toMatchObject({ state: 'settled', remaining: { activeTurns: 0, quarantinedTurns: 2 } });
  });

  it('times out with the unfinished runs as the cut-off list and records it durably', async () => {
    runs = [run('a'), run('b'), run('c')];
    admission.activeTurns = 3;
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 60 });
    // One child finishes inside the window.
    setTimeout(() => { runs = runs.filter((r) => r.runId !== 'a'); admission.activeTurns = 2; }, 10);
    const outcome = await drain.waitForOutcome();
    expect(outcome.state).toBe('timed_out');
    expect(outcome.cutOffRunIds.sort()).toEqual(['b', 'c']);
    expect(outcome.completedDuringDrain).toBe(1);
    // B4.1: the initial measurement also counts resident busy sessions (none here).
    expect(outcome.initial).toEqual({ activeTurns: 3, nonterminalRuns: 3, busySessions: 0 });
    const record = readDrainRecord(recordPath);
    // B4.1: record version 2 (cutOffSessions added); readers still accept v1.
    expect(record).toMatchObject({ version: 2, state: 'timed_out', reason: 'deploy' });
    expect(record?.cutOffRunIds.sort()).toEqual(['b', 'c']);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  it('treats a zero timeout as an immediate verdict', async () => {
    runs = [run('x')];
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 0 });
    const outcome = await drain.waitForOutcome();
    expect(outcome).toMatchObject({ state: 'timed_out', cutOffRunIds: ['x'] });
  });

  it('joins an in-progress drain instead of starting a second one', async () => {
    runs = [run('slow')];
    const drain = make();
    const first = drain.start({ reason: 'deploy A', timeoutMs: 5_000 });
    const second = drain.start({ reason: 'deploy B', timeoutMs: 10 });
    expect(second.joined).toBe(true);
    expect(second.status.reason).toBe('deploy A');
    expect(second.status.startedAt).toBe(first.status.startedAt);
    runs = [];
    expect((await drain.waitForOutcome()).state).toBe('settled');
  });

  it('cancel reopens admission, resolves waiters and removes the durable record', async () => {
    runs = [run('r')];
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 0 });
    await drain.waitForOutcome();
    expect(existsSync(recordPath)).toBe(true);
    const cancelled = await drain.cancel('operator');
    expect(cancelled).toMatchObject({ state: 'idle', draining: false, lastOutcome: { state: 'timed_out', endedBy: 'operator' } });
    expect(admission.state).toBeNull();
    expect(existsSync(recordPath)).toBe(false);
  });

  it('cancel during draining resolves an outstanding wait with the idle state', async () => {
    runs = [run('r')];
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 60_000 });
    const pending = drain.waitForOutcome();
    await drain.cancel('operator');
    expect((await pending).state).toBe('idle');
    expect(admission.state).toBeNull();
  });

  it('reopens admission when no restart follows within the hold window', async () => {
    const drain = make({ holdMs: 30 });
    drain.start({ reason: 'deploy', timeoutMs: 1_000 });
    expect((await drain.waitForOutcome()).state).toBe('settled');
    expect(drain.status().holdUntil).toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(drain.status()).toMatchObject({ state: 'idle', draining: false, lastOutcome: { state: 'settled', endedBy: 'hold_expired' } });
    expect(admission.state).toBeNull();
    expect(existsSync(recordPath)).toBe(false);
  });

  it('clamps timeouts to the configured maximum', () => {
    const drain = make({ maxTimeoutMs: 1_000 });
    const { status } = drain.start({ reason: 'deploy', timeoutMs: 999_999 });
    expect(status.timeoutMs).toBe(1_000);
  });

  it('exposes a positive retry-after for refused callers', () => {
    expect(make({ retryAfterSeconds: 45 }).retryAfterSeconds).toBe(45);
  });

  // ── B4.1 (contract 1.52.0): the drain also sees resident busy sessions ──

  it('a busy resident session keeps the drain open until it settles (B4.1)', async () => {
    busy = [{ sessionId: 'goal-1', runtime: 'pi', busyReason: 'sdk_streaming' }];
    const drain = make();
    const { status } = drain.start({ reason: 'deploy 1.52.0', timeoutMs: 5_000 });
    // A goal-engine continuation holds no admission turn and no receipt: the
    // pre-B4.1 drain settled here. It must keep waiting instead.
    expect(status.state).toBe('draining');
    expect(status.remaining).toMatchObject({ activeTurns: 0, nonterminalRuns: 0, busySessions: 1, sessions: [{ sessionId: 'goal-1', runtime: 'pi', busyReason: 'sdk_streaming' }] });
    busy = [];
    const outcome = await drain.waitForOutcome();
    expect(outcome.state).toBe('settled');
    expect(outcome.remaining).toMatchObject({ busySessions: 0, sessions: [] });
  });

  it('a session idle at the drain is not counted (B4.1)', () => {
    const drain = make();
    const { status } = drain.start({ reason: 'deploy', timeoutMs: 1_000 });
    expect(status.state).toBe('settled');
    expect(status.initial).toEqual({ activeTurns: 0, nonterminalRuns: 0, busySessions: 0 });
    expect(status.remaining.busySessions).toBe(0);
    expect(status.remaining.sessions).toEqual([]);
    expect(status.cutOffSessionIds).toEqual([]);
  });

  it('a timed-out drain lists the still-busy sessions in the verdict and the durable record (B4.1)', async () => {
    busy = [
      { sessionId: 'goal-1', runtime: 'pi', busyReason: 'status+sdk_streaming' },
      { sessionId: 'browser-2', runtime: 'pi', busyReason: 'status' },
    ];
    const drain = make();
    drain.start({ reason: 'deploy', timeoutMs: 40 });
    const outcome = await drain.waitForOutcome();
    expect(outcome.state).toBe('timed_out');
    expect(outcome.cutOffSessionIds.sort()).toEqual(['browser-2', 'goal-1']);
    const record = readDrainRecord(recordPath);
    expect(record?.version).toBe(2);
    expect(record?.cutOffSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 'browser-2', runtime: 'pi', busyReason: 'status' },
      { sessionId: 'goal-1', runtime: 'pi', busyReason: 'status+sdk_streaming' },
    ]);
  });

  it('reports busy sessions in the initial measurement (B4.1)', () => {
    runs = [run('r1')];
    busy = [{ sessionId: 'goal-1', runtime: 'pi', busyReason: 'sdk_streaming' }];
    const drain = make();
    const { status } = drain.start({ reason: 'deploy', timeoutMs: 5_000 });
    expect(status.initial).toEqual({ activeTurns: 0, nonterminalRuns: 1, busySessions: 1 });
  });

  it('keeps cut-off sessions in lastOutcome after the hold expires (B4.1)', async () => {
    busy = [{ sessionId: 'goal-1', runtime: 'pi', busyReason: 'sdk_streaming' }];
    const drain = make({ holdMs: 30 });
    drain.start({ reason: 'deploy', timeoutMs: 20 });
    const outcome = await drain.waitForOutcome();
    expect(outcome.state).toBe('timed_out');
    await new Promise((r) => setTimeout(r, 80));
    expect(drain.status()).toMatchObject({ state: 'idle', lastOutcome: { state: 'timed_out', endedBy: 'hold_expired', cutOffSessionIds: ['goal-1'] } });
  });

  it('a failing busy accessor degrades to not-busy with a warning, like the receipt source (B4.1)', () => {
    const drain = make({ listBusySessions: () => { throw new Error('accessor down'); } });
    const { status } = drain.start({ reason: 'deploy', timeoutMs: 1_000 });
    expect(status.state).toBe('settled');
  });
});

describe('drain record helpers', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pi-drain-record-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined for a missing or malformed record', () => {
    const p = path.join(dir, 'missing.json');
    expect(readDrainRecord(p)).toBeUndefined();
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(readDrainRecord(bad)).toBeUndefined();
    writeFileSync(bad, JSON.stringify({ version: 1, state: 'timed_out', cutOffRunIds: ['../evil', 'ok-1'] }));
    // Unsafe run ids are dropped, never trusted.
    expect(readDrainRecord(bad)?.cutOffRunIds).toEqual(['ok-1']);
  });

  it('consumes a record exactly once, keeping a consumed copy for forensics', () => {
    const p = path.join(dir, 'internal-api-drain.json');
    writeFileSync(p, JSON.stringify({ version: 1, state: 'timed_out', reason: 'r', startedAt: 'a', finishedAt: 'b', cutOffRunIds: ['run-1'] }));
    const first = consumeDrainRecord(p);
    expect(first?.cutOffRunIds).toEqual(['run-1']);
    expect(existsSync(p)).toBe(false);
    expect(JSON.parse(readFileSync(`${p}.consumed`, 'utf8')).cutOffRunIds).toEqual(['run-1']);
    expect(consumeDrainRecord(p)).toBeUndefined();
  });

  it('reads a v1 record (pre-1.52.0) with no cut-off sessions as an empty list (B4.1)', () => {
    const p = path.join(dir, 'internal-api-drain.json');
    writeFileSync(p, JSON.stringify({ version: 1, state: 'timed_out', reason: 'r', startedAt: 'a', finishedAt: 'b', cutOffRunIds: ['run-1'] }));
    expect(readDrainRecord(p)?.cutOffSessions).toEqual([]);
  });

  it('reads a v2 record and drops malformed cut-off session entries (B4.1)', () => {
    const p = path.join(dir, 'internal-api-drain.json');
    writeFileSync(p, JSON.stringify({
      version: 2, state: 'timed_out', reason: 'r', startedAt: 'a', finishedAt: 'b', cutOffRunIds: ['run-1'],
      cutOffSessions: [
        { sessionId: 'goal-1', runtime: 'pi', busyReason: 'sdk_streaming' },
        { sessionId: 42 },
        'garbage',
      ],
    }));
    expect(readDrainRecord(p)?.cutOffSessions).toEqual([{ sessionId: 'goal-1', runtime: 'pi', busyReason: 'sdk_streaming' }]);
  });
});
