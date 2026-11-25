import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevinService } from '../../../src/devin/devin-service.js';

/**
 * Lane A (W1) — the Devin FIFO queue as a receipt-owned lifecycle.
 *
 * Root cause (audit §2A / critique findings 1, 3, 4; verified by reading this
 * worktree at cf876858):
 *
 *  1. `followUp` had no per-item identity, so a receipt-scoped cancellation
 *     could not exist and `abort()` had to clear the whole queue.
 *  2. The hand-over was not atomic: `finalizeRunState` deleted `runningSessions`
 *     (line 343) BEFORE `drainQueue` shifted the next item (line 300) and only
 *     re-marked the session running inside an async registry read, so in that
 *     window a plain prompt was admitted concurrently and a targeted cancel
 *     would report "not queued" for an item that then executed.
 *  3. The next item's `started` state was persisted nowhere, so the receipt
 *     could not be stamped at the real dispatch boundary.
 *
 * These tests use a fake ACP child (same harness style as
 * `devin-service.test.ts`) so the real queue, the real turn runner and the real
 * registry are exercised — no mock of the queue under repair.
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

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'devin-lane-a-'));
  mkdirSync(dir, { recursive: true });
  const children: FakeChild[] = [];
  const service = new DevinService({
    registryPath: join(dir, 'registry.json'),
    sessionDir: join(dir, 'sessions'),
    executablePath: '/root/.local/bin/devin',
    devinHome: join(dir, 'devin-home'),
    modelsOutput: JSON.stringify({ families: [
      { family_label: 'SWE-2 Flash', family_uid: 'swe-2-flash', slug: 'swe-2-flash', variants: [
        { model_uid: 'swe-2-flash-medium', label: 'SWE-2 Flash Medium', cost_tier: 'Free', max_context_tokens: 262000 },
      ] },
    ] }),
    enabledOverride: true,
    spawnFn: ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      void options;
      children.push(child);
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { service, children, dir };
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/** Shared across `openSession` calls within one test (config writes are not
 *  per-child in the fake, so a single counter is enough and avoids double
 *  answering the same request). */
let configAnswers = 0;

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

async function waitForSent(child: FakeChild, method: string, count: number, timeoutMs = 4_000): Promise<void> {
  await waitFor(() => (child.sent().filter((m) => m.method === method).length >= count ? true : undefined), `${method} x${count}`, timeoutMs);
}

/** Minimal successful `session/prompt` result (shape from the ACP probe fixtures). */
function promptResult(stopReason = 'end_turn'): unknown {
  return { stopReason, usage: { input: 0, output: 0 } };
}

/** Drive the ACP handshake for a newly spawned child (initialize → session/new
 *  → config options), mirroring `devin-service.test.ts`. Answers config writes
 *  until the first prompt is actually sent, then returns. */
async function openSession(children: FakeChild[]): Promise<FakeChild> {
  const child = await waitFor(() => children[0], 'child spawn');
  await waitForSent(child, 'initialize', 1);
  child.respondLast({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await waitForSent(child, 'session/new', 1);
  child.respondLast({
    sessionId: 'native-1',
    modes: { currentModeId: 'accept-edits', availableModes: [] },
    configOptions: [
      { id: 'mode', name: 'Session Mode', type: 'select', currentValue: 'accept-edits', options: [{ value: 'accept-edits', name: 'Code' }] },
      { id: 'model', name: 'Model', type: 'select', currentValue: 'swe-2-flash-medium', options: [{ value: 'swe-2-flash-medium', name: 'SWE-2 Flash Medium' }] },
      { id: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
    ],
  });
  const deadline = Date.now() + 3_000;
  for (;;) {
    if (child.sent().some((m) => m.method === 'session/prompt')) return child;
    const pendingConfigWrites = child.sent().filter((m) => m.method === 'session/set_config_option').length;
    if (pendingConfigWrites > configAnswers) {
      configAnswers = pendingConfigWrites;
      child.respondLast({});
      continue;
    }
    if (Date.now() > deadline) return child;
    await tick(5);
  }
}

describe('DevinService — receipt-owned queue lifecycle (lane A)', () => {
  let service: DevinService;
  let children: FakeChild[];
  let dir: string;

  beforeEach(() => {
    configAnswers = 0;
    ({ service, children, dir } = makeService());
  });

  afterEach(() => {
    service.disposeSession?.('x');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── 1. Item identity and state ──────────────────────────────────────────

  it('gives each queued follow-up its own item id and reports queued state', async () => {
    const { sessionId } = await service.createSession('/ws');
    const done1 = new Promise<void>((r) => { void service.sendPrompt(sessionId, 'first', () => undefined, () => r()); });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    const itemId = 'run-receipt-1';
    const queued = await service.followUp(sessionId, 'second', () => undefined, () => undefined, { itemId });
    expect(queued).toBe(true);

    expect(service.getQueuedItemState(sessionId, itemId)).toBe('queued');
    expect(service.getQueuedItemState(sessionId, 'other-id')).toBe(undefined);
    expect(service.hasQueuedItem(sessionId, itemId)).toBe(true);

    child.respondLast(promptResult());
    await done1;
    await waitForSent(child, 'session/prompt', 2);
    // Once dispatched the item is no longer "queued"; it is the live turn.
    expect(service.getQueuedItemState(sessionId, itemId)).toBe('dispatched');
    child.respondLast(promptResult());
    await tick(30);
  });

  // ── 2. The dispatch barrier ─────────────────────────────────────────────

  it('awaits the dispatch stamp before the queued item is sent to the runtime', async () => {
    const { sessionId } = await service.createSession('/ws');
    const done1 = new Promise<void>((r) => { void service.sendPrompt(sessionId, 'first', () => undefined, () => r()); });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    const order: string[] = [];
    await service.followUp(sessionId, 'second', () => undefined, () => undefined, {
      itemId: 'run-2',
      onDispatched: async () => { order.push('stamp:start'); await tick(20); order.push('stamp:done'); },
    });

    child.respondLast(promptResult());
    await done1;
    await waitForSent(child, 'session/prompt', 2);
    // The barrier ran to completion BEFORE the prompt was written.
    expect(order).toEqual(['stamp:start', 'stamp:done']);
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(2);
    child.respondLast(promptResult());
    await tick(30);
  });

  it('does not execute the item when the dispatch stamp fails, and says so honestly', async () => {
    const { sessionId } = await service.createSession('/ws');
    const done1 = new Promise<void>((r) => { void service.sendPrompt(sessionId, 'first', () => undefined, () => r()); });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    let failure: Error | undefined;
    const settled = new Promise<void>((r) => {
      void service.followUp(sessionId, 'second', () => undefined, (err) => { failure = err; r(); }, {
        itemId: 'run-fail',
        onDispatched: async () => { throw new Error('receipt store unavailable'); },
      });
    });

    child.respondLast(promptResult());
    await done1;
    await settled;

    // The message must NOT reach the runtime: a run whose dispatch could not be
    // recorded must not execute silently.
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1);
    expect(failure).toBeDefined();
    expect(failure!.name).toBe('DevinDispatchStampError');
    expect(service.getQueuedItemState(sessionId, 'run-fail')).toBeUndefined();
  });

  // ── 3. Targeted cancellation ─────────────────────────────────────────────

  it('removes exactly one queued item and leaves its FIFO neighbours intact', async () => {
    const { sessionId } = await service.createSession('/ws');
    const done1 = new Promise<void>((r) => { void service.sendPrompt(sessionId, 'first', () => undefined, () => r()); });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    const cancelled: string[] = [];
    await service.followUp(sessionId, 'second', () => undefined, (err) => { cancelled.push(err?.name ?? 'none'); }, { itemId: 'run-b' });
    await service.followUp(sessionId, 'third', () => undefined, () => undefined, { itemId: 'run-c' });

    expect(service.cancelQueuedItem(sessionId, 'run-b')).toBe('removed');
    expect(cancelled).toEqual(['DevinQueuedItemCancelled']);
    expect(service.getQueuedItemState(sessionId, 'run-b')).toBeUndefined();
    expect(service.getQueuedItemState(sessionId, 'run-c')).toBe('queued');

    child.respondLast(promptResult());
    await done1;
    await waitForSent(child, 'session/prompt', 2);
    const prompts = child.sent().filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt[0].text);
    // The removed item never runs; the neighbour does.
    expect(prompts).toEqual(['first', 'third']);
    child.respondLast(promptResult());
    await tick(30);
  });

  it('refuses to cancel an item that is already dispatching, rather than pretending it was removed', async () => {
    const { sessionId } = await service.createSession('/ws');
    const done1 = new Promise<void>((r) => { void service.sendPrompt(sessionId, 'first', () => undefined, () => r()); });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    await service.followUp(sessionId, 'second', () => undefined, () => undefined, { itemId: 'run-late' });
    child.respondLast(promptResult());
    await done1;
    await waitForSent(child, 'session/prompt', 2);

    expect(service.cancelQueuedItem(sessionId, 'run-late')).toBe('dispatched');
    child.respondLast(promptResult());
    await tick(30);
  });

  it("reports 'unknown' for a session with no queue rather than guessing", async () => {
    expect(service.cancelQueuedItem('no-such-session', 'run-x')).toBe('unknown');
  });

  // ── 4. The hand-over is atomic ───────────────────────────────────────────

  it('keeps the session busy across the hand-over so a plain prompt cannot interleave', async () => {
    const { sessionId } = await service.createSession('/ws');
    // Capture the service's own view AT the moment turn 1's runner settles —
    // that instant is the hand-over gap the defect lived in.
    let busyAtSettle: boolean | undefined;
    const done1 = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'first', () => undefined, () => {
        busyAtSettle = service.isRunning(sessionId);
        resolve();
      });
    });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    await service.followUp(sessionId, 'second', () => undefined, () => undefined, { itemId: 'run-handover' });

    child.respondLast(promptResult());
    await done1;

    // Before the fix `runningSessions` was deleted before the shift, so this
    // read false and a plain prompt could be admitted alongside the drained item.
    expect(busyAtSettle).toBe(true);
    expect(service.isRunning(sessionId)).toBe(true);
    expect(service.getQueuedItemState(sessionId, 'run-handover')).toBe('dispatched');
    // A concurrent plain prompt is refused, never admitted alongside.
    await expect(service.sendPrompt(sessionId, 'interloper', () => undefined, () => undefined))
      .rejects.toThrow(/SESSION_BUSY/);

    await waitForSent(child, 'session/prompt', 2);
    expect(service.isRunning(sessionId)).toBe(true);
    child.respondLast(promptResult());
    await tick(40);
    expect(service.isRunning(sessionId)).toBe(false);
  });

  it('never loses a follow-up whose enqueue races turn completion (queue-or-start is one decision)', async () => {
    const { sessionId } = await service.createSession('/ws');
    const done1 = new Promise<void>((r) => { void service.sendPrompt(sessionId, 'first', () => undefined, () => r()); });
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    // Settle the turn first, then hand the message over: the service decides
    // "start now" atomically, so the message is never dropped between the two.
    child.respondLast(promptResult());
    await done1;
    await tick(20);
    expect(service.isRunning(sessionId)).toBe(false);

    const queued = await service.followUp(sessionId, 'arrived-after-settle', () => undefined, () => undefined, { itemId: 'run-late-arrival' });
    // A non-busy session: followUp reports false and the caller must send a
    // plain prompt. What must NOT happen is a silent accept that never runs.
    expect(queued).toBe(false);
    expect(service.getQueuedItemState(sessionId, 'run-late-arrival')).toBeUndefined();
    expect(service.snapshotQueue(sessionId)).toEqual([]);
  });

  // ── 5. Explicit session abort stays broad (status quo) ───────────────────

  it('keeps abort() broad but reports each queued item with a typed cancellation', async () => {
    const { sessionId } = await service.createSession('/ws');
    void service.sendPrompt(sessionId, 'first', () => undefined, () => undefined);
    const child = await openSession(children);
    await waitForSent(child, 'session/prompt', 1);

    const errors: string[] = [];
    await service.followUp(sessionId, 'second', () => undefined, (err) => { errors.push(err?.name ?? 'none'); }, { itemId: 'run-b1' });
    await service.followUp(sessionId, 'third', () => undefined, (err) => { errors.push(err?.name ?? 'none'); }, { itemId: 'run-b2' });

    service.abort(sessionId);
    await tick(30);

    // Every queued item is settled (broad abort semantics preserved), and each
    // is typed so the route can classify it instead of a generic runtime error.
    expect(errors).toEqual(['DevinQueuedItemCancelled', 'DevinQueuedItemCancelled']);
    expect(service.snapshotQueue(sessionId)).toEqual([]);
    child.respondLast(promptResult('cancelled'));
    await tick(30);
  });
});
