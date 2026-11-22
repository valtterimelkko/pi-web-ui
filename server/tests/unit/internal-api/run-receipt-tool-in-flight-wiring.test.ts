import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * Lane B2 (2026-11-22): the WIRING — the receipt watchdog defers its idle rule
 * for antigravity while a tool step is in flight.
 *
 * Lane B deferred the idle rule for a tracked *background task*. agy 1.5.14
 * prints no such banner: the demoted command is one `tool` step that stays
 * ACTIVE and silent for its whole run (captured in
 * `tests/unit/antigravity/fixtures/raw-wire-agy-1.5.14.jsonl`). The live P4
 * re-run proved the consequence: `hasRunningBackgroundTasks` stayed false and
 * the watchdog terminalised a legitimate 33-minute turn TURN_STALLED at 15 min.
 *
 * This suite drives the REAL chain the server wires: RunReceiptManager →
 * `createKnownPendingWorkPredicate` (internal-api/server.ts) → a real
 * AntigravityService → a real AgyStreamProcess fed the captured wire. It asserts
 * the idle rule defers while the tool is in flight and terminalises
 * TURN_STALLED once it is not, and that no other runtime is affected.
 */

const svcCtrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-tool-wiring-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = {
    sessionDir,
    registryPath: `${sessionDir}/registry.json`,
    writes: [] as string[],
  };
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  return state;
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { createKnownPendingWorkPredicate } from '../../../src/internal-api/server.js';

const RAW_WIRE = readFileSync(
  fileURLToPath(new URL('../antigravity/fixtures/raw-wire-agy-1.5.14.jsonl', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim().length > 0);

const parsedLines = RAW_WIRE.map((line) => JSON.parse(line) as Record<string, unknown>);
const ACTIVE_TOOL_AT = parsedLines.findIndex((e) => {
  const step = e.step_update as { state?: string; step_type?: string } | undefined;
  return e.event === 'step_update' && step?.step_type === 'tool' && step.state === 'ACTIVE';
});

const baseInput: BeginRunInput = {
  sessionId: 'session-tool',
  runtime: 'antigravity',
  executionInstanceId: 'antigravity-default',
  model: 'gemini-3.8-flash-medium',
  message: 'run the long command',
  mode: 'prompt',
  verbosity: 'answers',
  detach: false,
};

function startedAnswer(sessionId: string, timestamp: number): NormalizedEvent {
  return {
    type: 'message_update',
    sessionId,
    timestamp,
    data: { assistantMessageEvent: { type: 'text_delta', delta: 'STARTED' } },
  } as NormalizedEvent;
}

/** A fake agy child whose stdout the test drives; stdin writes are no-ops. */
function makeFakeChild(): { child: EventEmitter; stdout: EventEmitter } {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroyed: boolean; end: () => void };
  stdin.destroyed = false;
  stdin.end = () => {};
  stdin.write = (s: string) => {
    svcCtrl.writes.push(s);
    return true;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: (signal?: string) => void }).kill = vi.fn();
  return { child, stdout };
}

describe('createKnownPendingWorkPredicate — the server wiring asks antigravity only', () => {
  it('defers for antigravity when the service knows of pending work, and never for another runtime', () => {
    const asked: string[] = [];
    const predicate = createKnownPendingWorkPredicate({
      hasKnownPendingWork: (sessionId: string) => {
        asked.push(sessionId);
        return true;
      },
    });

    expect(predicate('s-antigravity', 'antigravity')).toBe(true);
    expect(asked).toEqual(['s-antigravity']);

    // Every other runtime keeps today's behaviour: the antigravity service is
    // never even consulted (its tracking means nothing for a pi/claude run).
    for (const runtime of ['pi', 'claude', 'opencode', 'commandcode', 'devin'] as const) {
      expect(predicate('s-other', runtime)).toBe(false);
    }
    expect(asked).toEqual(['s-antigravity']);
  });

  it('a throwing service is no evidence of pending work (never defers)', () => {
    const predicate = createKnownPendingWorkPredicate({
      hasKnownPendingWork: () => {
        throw new Error('service lookup failed');
      },
    });
    expect(predicate('s-1', 'antigravity')).toBe(false);
  });
});

describe('RunReceiptManager + real AntigravityService — a tool step in flight defers the idle rule', () => {
  let dir: string;
  let now: number;
  let nextId: number;
  let metrics: OperationalMetrics;
  const managers: RunReceiptManager[] = [];
  const services: AntigravityService[] = [];

  const makeManager = (predicate: (sessionId: string, runtime: string) => boolean) => {
    const m = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      idempotencyTtlMs: 1_000,
      metrics,
      // Production values (config.ts): a 15-minute idle window under a 6-hour
      // absolute ceiling.
      turnIdleTimeoutMs: 900_000,
      turnMaxMs: 21_600_000,
      hasKnownPendingWork: predicate,
    });
    managers.push(m);
    return m;
  };

  const reconcile = (m: RunReceiptManager) =>
    (m as unknown as { reconcileStalledRuns: () => Promise<void> }).reconcileStalledRuns();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-tool-'));
    now = Date.parse('2026-11-22T02:31:29.000Z');
    nextId = 0;
    metrics = new OperationalMetrics({ now: () => now });
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown();
    for (const s of services.splice(0)) await s.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  afterAll(() => {
    rmSync(svcCtrl.sessionDir, { recursive: true, force: true });
  });

  it('leaves the run active while agy 1.5.14\'s run_command step is in flight, then terminalises TURN_STALLED once it is done', async () => {
    expect(ACTIVE_TOOL_AT).toBeGreaterThanOrEqual(0);

    const { child: fakeChild, stdout } = makeFakeChild();
    const service = new AntigravityService({
      registryPath: svcCtrl.registryPath,
      streamSpawnFn: (() => fakeChild) as unknown as typeof import('node:child_process').spawn,
    });
    services.push(service);
    const { sessionId: agySessionId } = await service.createSession('/tmp/tool-wiring', 'gemini-3.8-flash-medium');

    // The server's real wiring, over the real service.
    const m = makeManager(createKnownPendingWorkPredicate(service));
    await m.init();
    const run = await m.beginRun({ ...baseInput, sessionId: agySessionId });
    await m.markStarted(run.receipt.runId);

    // The run produced STARTED-style activity, then agy went quiet while its
    // command ran: the live failure shape.
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer(agySessionId, now));

    let turnSettled = false;
    void service.sendPrompt(agySessionId, 'run the long command', () => {}, () => {
      turnSettled = true;
    });
    // The prompt reaches agy's stdin only after the process is spawned and its
    // stdout reader is attached, so this is the safe moment to answer.
    await vi.waitFor(() => {
      if (svcCtrl.writes.length === 0) throw new Error('turn not written yet');
    });
    // Drive the captured wire up to and including the tool step going ACTIVE.
    stdout.emit('data', Buffer.from(RAW_WIRE.slice(0, ACTIVE_TOOL_AT + 1).join('\n') + '\n'));
    expect(service.hasToolInFlight(agySessionId)).toBe(true);
    expect(service.hasRunningBackgroundTasks(agySessionId)).toBe(false);

    // The full 15-minute idle window passes with no further event: deferred.
    now += 900_100;
    await reconcile(m);
    const deferred = m.get(run.receipt.runId);
    expect(deferred?.status).toBe('started');
    expect(deferred?.errorCode).toBeUndefined();

    // The command finishes and the turn ends in the same stream...
    stdout.emit('data', Buffer.from(RAW_WIRE.slice(ACTIVE_TOOL_AT + 1).join('\n') + '\n'));
    await vi.waitFor(() => {
      if (!turnSettled) throw new Error('turn not settled yet');
    });
    expect(service.hasToolInFlight(agySessionId)).toBe(false);

    // ...so the next silent window is a real stall: the idle rule applies.
    now += 900_100;
    await reconcile(m);
    const terminal = m.get(run.receipt.runId);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.errorCode).toBe('TURN_STALLED');
    expect(terminal?.liveness?.watchdog?.reason).toBe('idle');
  });

  it('a non-antigravity run is unaffected by a tool in flight on an antigravity session', async () => {
    const asked: string[] = [];
    const m = makeManager((sessionId, runtime) => {
      asked.push(`${runtime}:${sessionId}`);
      return false;
    });
    await m.init();
    const run = await m.beginRun({ ...baseInput, sessionId: 'session-pi', runtime: 'pi' });
    await m.markStarted(run.receipt.runId);
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer('session-pi', now));

    now += 900_100;
    await reconcile(m);

    expect(asked.at(-1)).toBe('pi:session-pi');
    expect(m.get(run.receipt.runId)?.errorCode).toBe('TURN_STALLED');
  });
});
