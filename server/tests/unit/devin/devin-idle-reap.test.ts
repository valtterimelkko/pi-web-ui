import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevinService, clampProcessIdleShutdownMs, DEFAULT_PROCESS_IDLE_SHUTDOWN_MS, MIN_PROCESS_IDLE_SHUTDOWN_MS } from '../../../src/devin/devin-service.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';

/**
 * Lane E — idle ACP process reaping.
 *
 * Why: production held 24 `devin acp` children (each with three MCP helpers,
 * ~460 MB) because the idle-shutdown timer was armed ONCE, at spawn. A turn
 * longer than the idle window made it fire while the session was busy, where it
 * deleted itself and returned ("busy: keep the child") and was never re-armed —
 * so the child stayed resident until a service restart. These tests prove the
 * reap now counts from the END of the last activity, never fires mid-turn, and
 * has a sweep as a backstop for a lost timer.
 *
 * Everything runs over a fake `devin acp` child (no real binary), with small
 * real-timer windows: the ACP handshake is a chain of awaited request/response
 * steps, and the reap decision is what is under test, not the scheduler.
 */

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly signals: string[] = [];
  readonly stdin: Writable;
  lastRequestId: string | number | undefined;

  constructor() {
    super();
    const writes = this.stdinWrites;
    this.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) { writes.push(chunk.toString()); cb(); },
      final(cb) { cb(); },
    }) as Writable;
    const innerWrite = this.stdin.write.bind(this.stdin);
    (this.stdin as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      try {
        const parsed = JSON.parse(chunk);
        if (parsed && parsed.method && parsed.id !== undefined) this.lastRequestId = parsed.id;
      } catch { /* response, not request */ }
      return innerWrite(chunk);
    };
  }

  writeStdout(obj: unknown): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
  respondLast(result: unknown): void { this.writeStdout({ jsonrpc: '2.0', id: this.lastRequestId, result }); }
  sent(): Array<{ method?: string; params?: any }> { return this.stdinWrites.map((w) => JSON.parse(w)); }
  kill(signal?: string): void { this.signals.push(signal ?? 'SIGTERM'); this.emit('exit', 0, null); }
}

const tick = (ms = 3) => new Promise<void>((r) => setTimeout(r, ms));

/** The service clamps the idle window to this floor (review r1 F1: a 0/1/NaN
 *  window turned the busy re-arm into a ~1 ms timer loop). Every reap test uses
 *  the floor so it also exercises the clamp — a smaller window would silently
 *  become this one. */
const IDLE_WINDOW_MS = 1000;
/** Generous upper bound for "the child was stopped after the window". */
const STOP_TIMEOUT_MS = 2500;

async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${label} not true within ${timeoutMs}ms`);
    await tick();
  }
}

async function waitForSent(child: FakeChild, method: string, nth = 1, timeoutMs = 5000): Promise<void> {
  await waitFor(() => child.sent().filter((m) => m.method === method).length >= nth, timeoutMs, `'${method}' #${nth} written`);
}

function liveConfigOptions(): unknown[] {
  return [
    { id: 'mode', name: 'Session Mode', type: 'select', currentValue: 'accept-edits', options: [{ value: 'accept-edits', name: 'Code' }, { value: 'bypass', name: 'Bypass Permissions' }] },
    { id: 'model', name: 'Model', type: 'select', currentValue: 'swe-2-flash-medium', options: [{ value: 'swe-2-flash-medium', name: 'swe-2-flash-medium' }] },
    { id: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'medium' }, { value: 'high', name: 'high' }, { value: 'max', name: 'max' }] },
  ];
}

function liveSessionNewResult(): unknown {
  return { sessionId: 'brass-akubra', modes: { currentModeId: 'accept-edits', availableModes: [] }, configOptions: liveConfigOptions() };
}

function liveModelEcho(): unknown {
  return { configOptions: [
    { id: 'model', currentValue: 'swe-2-flash-medium', options: [{ value: 'swe-2-flash-medium', name: 'swe-2-flash-medium' }] },
    { id: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'medium' }, { value: 'high', name: 'high' }, { value: 'max', name: 'max' }] },
  ] };
}

function promptResult(): unknown {
  return { stopReason: 'end_turn', usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } };
}

/** Answer the ACP handshake in request order: initialize, then session/new OR
 *  session/load (respawn), then the mode / model / thought_level config sets. */
async function completeHandshake(child: FakeChild): Promise<void> {
  await waitForSent(child, 'initialize', 1);
  child.respondLast({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await waitFor(
    () => child.sent().some((m) => m.method === 'session/load' || m.method === 'session/new'),
    5000,
    'session/load or session/new written',
  );
  const resumed = child.sent().some((m) => m.method === 'session/load');
  child.respondLast(resumed ? { configOptions: liveConfigOptions() } : liveSessionNewResult());
  await waitForSent(child, 'session/set_config_option', 1);
  child.respondLast({}); // mode → bypass
  await waitForSent(child, 'session/set_config_option', 2);
  child.respondLast(liveModelEcho()); // model application
  await waitForSent(child, 'session/set_config_option', 3);
  child.respondLast({}); // thought_level
  await tick();
}

interface HarnessOptions {
  processIdleShutdownMs: number;
  cleanupIntervalMs?: number;
}

interface Harness {
  service: DevinService;
  children: FakeChild[];
  dir: string;
  dispose(): void;
}

function makeHarness(opts: HarnessOptions): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'devin-idle-reap-'));
  const children: FakeChild[] = [];
  const service = new DevinService({
    registryPath: join(dir, 'registry.json'),
    sessionDir: join(dir, 'sessions'),
    executablePath: '/root/.local/bin/devin',
    devinHome: join(dir, 'devin-home'),
    modelsOutput: JSON.stringify({ families: [
      { family_label: 'SWE-2 Flash', family_uid: 'swe-2-flash', slug: 'swe-2-flash', variants: [
        { model_uid: 'swe-2-flash-medium', label: 'SWE-2 Flash Medium', cost_tier: 'Free' },
        { model_uid: 'swe-2-flash-high', label: 'SWE-2 Flash High', cost_tier: 'Free' },
        { model_uid: 'swe-2-flash-max', label: 'SWE-2 Flash Max', cost_tier: 'Free' },
      ] },
    ] }),
    enabledOverride: true,
    spawnFn: ((_file: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn,
    processIdleShutdownMs: opts.processIdleShutdownMs,
    ...(opts.cleanupIntervalMs !== undefined ? { cleanupIntervalMs: opts.cleanupIntervalMs } : {}),
  });
  return {
    service,
    children,
    dir,
    dispose() {
      void service.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Start a turn and complete the handshake; resolves with the live child once
 *  the prompt request is in flight (NOT answered). `fromIndex` is the number of
 *  children that already existed, so a respawn is never confused with the
 *  previous (reaped) child. */
async function startTurn(h: Harness, sessionId: string, prompt = 'do work', fromIndex = h.children.length): Promise<FakeChild> {
  const done = new Promise<void>((resolve) => {
    void h.service.sendPrompt(sessionId, prompt, () => undefined, () => resolve());
  });
  await waitFor(() => h.children.length > fromIndex, 3000, 'child spawned');
  const child = h.children[fromIndex]!;
  await completeHandshake(child);
  await waitForSent(child, 'session/prompt', 1);
  // Keep the completion promise reachable for the caller via a marker.
  (child as unknown as { turnDone?: Promise<void> }).turnDone = done;
  return child;
}

function turnDone(child: FakeChild): Promise<void> {
  return (child as unknown as { turnDone?: Promise<void> }).turnDone ?? Promise.resolve();
}

describe('devin idle process reaping (lane E)', () => {
  const harnesses: Harness[] = [];

  const newHarness = (opts: HarnessOptions): Harness => {
    const h = makeHarness(opts);
    harnesses.push(h);
    return h;
  };

  beforeEach(() => {
    setLogTap(null);
  });

  afterEach(() => {
    for (const h of harnesses.splice(0)) h.dispose();
    setLogTap(null);
  });

  it('T1: a turn longer than the idle window is never reaped mid-turn and is stopped about one window after it ends', async () => {
    const WINDOW = IDLE_WINDOW_MS;
    const h = newHarness({ processIdleShutdownMs: WINDOW });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);

    // Hold the turn past the idle window: the spawn-time timer fires while the
    // session is busy.
    await tick(WINDOW + Math.floor(WINDOW / 2));
    expect(child.signals).toEqual([]);
    expect(h.service.isRunning(sessionId)).toBe(true);

    child.respondLast(promptResult());
    await turnDone(child);
    const endedAt = Date.now();
    await waitFor(() => child.signals.length > 0, STOP_TIMEOUT_MS, 'idle child stopped after the turn');
    const elapsed = Date.now() - endedAt;
    // Stopped in bounded time after the LAST activity — not left resident
    // (the bug), and not killed the instant the turn ended.
    expect(elapsed).toBeGreaterThanOrEqual(Math.floor(WINDOW * 0.4));
    expect(elapsed).toBeLessThanOrEqual(STOP_TIMEOUT_MS);
    expect(child.signals).toContain('SIGTERM');
  });

  it('T2: a timer that fires while the session is busy with a queued follow-up is not dropped — the child stops after the queue drains', async () => {
    const WINDOW = IDLE_WINDOW_MS;
    const h = newHarness({ processIdleShutdownMs: WINDOW });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId, 'first');

    // Queue a follow-up while the long turn runs (past the idle window).
    await tick(WINDOW + Math.floor(WINDOW / 2));
    expect(await h.service.followUp(sessionId, 'queued-second', () => undefined, () => undefined)).toBe(true);
    expect(child.signals).toEqual([]);

    child.respondLast(promptResult());
    const queuedCompleted = new Promise<void>((resolve) => {
      void (async () => {
        await waitForSent(child, 'session/prompt', 2);
        resolve();
      })();
    });
    await queuedCompleted;
    // The drained turn is running: still no reap.
    await tick(WINDOW + Math.floor(WINDOW / 2));
    expect(child.signals).toEqual([]);

    child.respondLast(promptResult());
    await waitFor(() => !h.service.isRunning(sessionId), 3000, 'session idle after the drain');
    await waitFor(() => child.signals.length > 0, STOP_TIMEOUT_MS, 'child stopped after the drain');
    expect(child.signals).toContain('SIGTERM');
  });

  it('T3: queue drain — the window counts from the end of the LAST drained item, never from the first turn', async () => {
    const WINDOW = IDLE_WINDOW_MS;
    const h = newHarness({ processIdleShutdownMs: WINDOW });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId, 'first');

    await tick(WINDOW);
    expect(await h.service.followUp(sessionId, 'second', () => undefined, () => undefined)).toBe(true);
    expect(await h.service.followUp(sessionId, 'third', () => undefined, () => undefined)).toBe(true);
    child.respondLast(promptResult());
    await waitForSent(child, 'session/prompt', 2);

    // Second item runs longer than the window; third is still queued.
    await tick(WINDOW + Math.floor(WINDOW / 2));
    expect(child.signals).toEqual([]);
    child.respondLast(promptResult());
    await waitForSent(child, 'session/prompt', 3);
    await tick(WINDOW);
    expect(child.signals).toEqual([]);

    child.respondLast(promptResult());
    const lastEndedAt = Date.now();
    await waitFor(() => !h.service.isRunning(sessionId), 3000, 'queue drained and idle');
    await waitFor(() => child.signals.length > 0, STOP_TIMEOUT_MS, 'child stopped after the last drained item');
    const elapsed = Date.now() - lastEndedAt;
    expect(elapsed).toBeGreaterThanOrEqual(Math.floor(WINDOW * 0.4));
    expect(elapsed).toBeLessThanOrEqual(STOP_TIMEOUT_MS);
  });

  it('T4a: the sweep stops an idle client whose timer never fired, even with a browser subscriber attached', async () => {
    const h = newHarness({ processIdleShutdownMs: 5000, cleanupIntervalMs: 60_000 });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);
    child.respondLast(promptResult());
    await turnDone(child);
    await waitFor(() => !h.service.isRunning(sessionId), 3000, 'session idle');

    // A viewer must never keep the ACP child resident (the next turn respawns).
    h.service.getSubscriberTracker().subscribe('browser-1', sessionId);
    // The window has elapsed but no timer spoke: exactly the lost-timer case.
    expect(h.service.sweepIdleProcesses(Date.now() + 60_000)).toBe(1);
    expect(child.signals).toContain('SIGTERM');
  });

  it('T4b: the sweep never touches a running session', async () => {
    const h = newHarness({ processIdleShutdownMs: 5000, cleanupIntervalMs: 60_000 });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);
    expect(h.service.sweepIdleProcesses(Date.now() + 60_000)).toBe(0);
    expect(child.signals).toEqual([]);
    child.respondLast(promptResult());
    await turnDone(child);
  });

  it('T4c: the sweep never touches a pinned session (and reaps it once unpinned)', async () => {
    const h = newHarness({ processIdleShutdownMs: 5000, cleanupIntervalMs: 60_000 });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);
    child.respondLast(promptResult());
    await turnDone(child);
    await waitFor(() => !h.service.isRunning(sessionId), 3000, 'session idle');

    expect(await h.service.pinSession(sessionId, 'test-claim')).toBe(true);
    expect(h.service.sweepIdleProcesses(Date.now() + 60_000)).toBe(0);
    expect(child.signals).toEqual([]);

    expect(h.service.unpinSession(sessionId, 'test-claim')).toBe(true);
    expect(h.service.sweepIdleProcesses(Date.now() + 60_000)).toBe(1);
    expect(child.signals).toContain('SIGTERM');
  });

  it('T4d: the cleanup interval runs the sweep (wiring, not just the method)', async () => {
    const spy = vi.spyOn(DevinService.prototype as unknown as { sweepIdleProcesses: () => number }, 'sweepIdleProcesses');
    const h = newHarness({ processIdleShutdownMs: 5000, cleanupIntervalMs: 25 });
    expect(h.service).toBeDefined();
    await waitFor(() => spy.mock.calls.length > 0, 1500, 'cleanup interval invoked the sweep');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('T5: each idle shutdown writes exactly one info line carrying the session id and the idle duration', async () => {
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    const h = newHarness({ processIdleShutdownMs: IDLE_WINDOW_MS });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);
    await tick(IDLE_WINDOW_MS + 200);
    child.respondLast(promptResult());
    await turnDone(child);
    await waitFor(() => child.signals.length > 0, STOP_TIMEOUT_MS, 'child stopped');

    const reaps = records.filter((r) => r.component === 'DevinService' && r.level === 'info' && /process idle shutdown/i.test(r.msg));
    expect(reaps).toHaveLength(1);
    expect(reaps[0]!.msg).toContain(sessionId);
    expect(reaps[0]!.msg).toMatch(/idleMs=\d+/);
    const idleMs = Number(/idleMs=(\d+)/.exec(reaps[0]!.msg)![1]);
    expect(idleMs).toBeGreaterThanOrEqual(IDLE_WINDOW_MS);
  });

  it('T6: the next prompt after an idle shutdown respawns and resumes the same native session via session/load', async () => {
    const h = newHarness({ processIdleShutdownMs: IDLE_WINDOW_MS });
    const { sessionId } = await h.service.createSession('/ws');
    const first = await startTurn(h, sessionId, 'first');
    first.respondLast(promptResult());
    await turnDone(first);
    await waitFor(() => first.signals.length > 0, STOP_TIMEOUT_MS, 'idle child reaped');
    expect(h.children).toHaveLength(1);

    const second = await startTurn(h, sessionId, 'second', 1);
    expect(h.children).toHaveLength(2);
    const load = second.sent().find((m) => m.method === 'session/load');
    expect(load?.params).toMatchObject({ sessionId: 'brass-akubra' });
    expect(second.sent().some((m) => m.method === 'session/new')).toBe(false);
    second.respondLast(promptResult());
    await turnDone(second);
    const replay = await h.service.getReplayEvents(sessionId);
    expect(replay.filter((e) => (e as { type?: string }).type === 'agent_end').length).toBeGreaterThanOrEqual(2);
  });

  // ── review r1 finding F1: clamp the process idle window at the read site ───

  it('C1 (RED before the clamp): a sub-floor window (1 ms) does not reap the child the moment the turn ends', async () => {
    const h = newHarness({ processIdleShutdownMs: 1 });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);
    child.respondLast(promptResult());
    await turnDone(child);
    const endedAt = Date.now();

    // A 1 ms window reaps immediately — and, while busy, spins a 1 ms re-arm
    // loop for the whole turn (review finding F1). The floor is 1000 ms.
    await tick(300);
    expect(child.signals).toEqual([]);
    await waitFor(() => child.signals.length > 0, STOP_TIMEOUT_MS, 'child stopped at the clamped floor');
    const elapsed = Date.now() - endedAt;
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThanOrEqual(STOP_TIMEOUT_MS);
  });

  it('C2 (RED before the clamp): a non-finite window (NaN, what a non-numeric env value parses to) falls back to the 300000 ms default', async () => {
    const h = newHarness({ processIdleShutdownMs: Number.NaN });
    const { sessionId } = await h.service.createSession('/ws');
    const child = await startTurn(h, sessionId);
    child.respondLast(promptResult());
    await turnDone(child);
    const endedAt = Date.now();

    // NaN (and 0) would fire the timer on the next tick — the child must survive.
    await tick(300);
    expect(child.signals).toEqual([]);

    // The effective window is the 300000 ms default, not the 1000 ms floor:
    // 290 s of idleness must NOT reap, 305 s must.
    expect(h.service.sweepIdleProcesses(endedAt + 290_000)).toBe(0);
    expect(child.signals).toEqual([]);
    expect(h.service.sweepIdleProcesses(endedAt + 305_000)).toBe(1);
    expect(child.signals).toContain('SIGTERM');
  });

  it('C3: the clamp itself — non-finite → 300000, finite below 1000 → 1000, otherwise unchanged', () => {
    expect(clampProcessIdleShutdownMs(Number.NaN)).toBe(300_000);
    expect(clampProcessIdleShutdownMs(Number.POSITIVE_INFINITY)).toBe(300_000);
    expect(clampProcessIdleShutdownMs(Number.NEGATIVE_INFINITY)).toBe(300_000);
    expect(clampProcessIdleShutdownMs(0)).toBe(1_000);
    expect(clampProcessIdleShutdownMs(1)).toBe(1_000);
    expect(clampProcessIdleShutdownMs(-5)).toBe(1_000);
    expect(clampProcessIdleShutdownMs(999)).toBe(1_000);
    expect(clampProcessIdleShutdownMs(1_000)).toBe(1_000);
    expect(clampProcessIdleShutdownMs(1_001)).toBe(1_001);
    expect(clampProcessIdleShutdownMs(300_000)).toBe(300_000);
    expect(DEFAULT_PROCESS_IDLE_SHUTDOWN_MS).toBe(300_000);
    expect(MIN_PROCESS_IDLE_SHUTDOWN_MS).toBe(1_000);
  });
});
