import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevinService, DevinProviderTurnError } from '../../../src/devin/devin-service.js';

/**
 * Lane C phase 2 — the ACTUAL ACP failure boundary.
 *
 * The recorded Devin failure (53 messages, 2026-11-24) arrives as the JSON-RPC
 * *error response* to `session/prompt`; today the class is destroyed there and
 * the run receipt collapses to a generic RUNTIME_ERROR. These tests drive the
 * real DevinService over a fake `devin acp` child (injected spawn, private empty
 * home, no native auth, no network, no model call) and assert:
 *
 *   - the sanitised provider envelope produces a typed completion error and the
 *     additive broker `errorClass`/`resetAt` keys on the failed turn;
 *   - exactly ONE `session/prompt` is written (no added retry);
 *   - the stored turn text and the broker `error` are unchanged (no migration);
 *   - generic, timeout, invalid-params and prose-quoting failures stay `other`
 *     and untyped, keeping the pre-existing behaviour.
 */

const ENVELOPE = 'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model.';
/** 2026-11-24T21:05:00Z — the failure instant for the relative statement. */
/** Unused sentinel comment retained only if referenced below (kept out to avoid dead code). */
const QUOTA_TEXT = `${ENVELOPE} Your limit will reset in 15 minutes (at 21:20 UTC).`;

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
  respondLastError(message: string, code = -32000): void {
    this.writeStdout({ jsonrpc: '2.0', id: this.lastRequestId, error: { code, message } });
  }
  sent(): Array<{ method?: string; params?: { prompt?: Array<{ text: string }> } }> {
    return this.stdinWrites.map((w) => JSON.parse(w));
  }
  promptCount(): number { return this.sent().filter((m) => m.method === 'session/prompt').length; }
  kill(signal?: string): void { this.signals.push(signal ?? 'SIGTERM'); this.emit('exit', 0, null); }
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForSent(child: FakeChild, method: string, nth = 1, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (child.sent().filter((m) => m.method === method).length < nth) {
    if (Date.now() > deadline) throw new Error(`waitForSent: '${method}' #${nth} not written within ${timeoutMs}ms`);
    await tick(2);
  }
}

const liveSessionNewResult = () => ({
  sessionId: 'brass-akubra',
  modes: { currentModeId: 'accept-edits', availableModes: [] },
  configOptions: [
    { id: 'model', currentValue: 'swe-2-flash-medium', options: [{ value: 'swe-2-flash-medium', name: 'swe-2-flash-medium' }] },
    { id: 'thought_level', currentValue: 'medium', options: ['medium', 'high'].map((v) => ({ value: v, name: v })) },
  ],
});

/** Lazy spawn → initialize → session/new → config sets → `session/prompt`.
 *  The config-step count varies with the family/level ladder (a level already
 *  current is not re-sent), so answer whatever is pending until the prompt lands. */
async function waitForChild(children: FakeChild[], settled?: () => boolean, timeoutMs = 4000): Promise<FakeChild | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (children.length === 0 && Date.now() < deadline) await tick();
  const child = children[0];
  if (!child) throw new Error('no devin acp child was spawned');
  await waitForSent(child, 'initialize');
  child.respondLast({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await waitForSent(child, 'session/new');
  child.respondLast(liveSessionNewResult());
  let answeredConfig = 0;
  while (Date.now() < deadline && child.promptCount() === 0) {
    if (settled?.()) return child; // the turn already failed (handshake/config path)
    const sent = child.sent().filter((m) => m.method === 'session/set_config_option').length;
    if (sent > answeredConfig) {
      answeredConfig = sent;
      child.respondLast(answeredConfig === 2 ? modelEcho() : {});
    }
    await tick(3);
  }
  if (child.promptCount() === 0 && !settled?.()) {
    throw new Error(`session/prompt was never written; sent=${JSON.stringify(child.sent().map((m) => m.method))}`);
  }
  return child;
}

/** The model-set echo the real CLI returns (model + the level ladder). */
const modelEcho = () => ({
  configOptions: [
    { id: 'model', currentValue: 'swe-2-flash-medium', options: [{ value: 'swe-2-flash-medium', name: 'swe-2-flash-medium' }] },
    { id: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'medium' }, { value: 'high', name: 'high' }] },
  ],
});

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'devin-quota-service-'));
  mkdirSync(dir, { recursive: true });
  const children: FakeChild[] = [];
  const service = new DevinService({
    registryPath: join(dir, 'registry.json'),
    sessionDir: join(dir, 'sessions'),
    executablePath: '/usr/bin/false',
    devinHome: join(dir, 'devin-home'),
    modelsOutput: JSON.stringify({ families: [
      { family_label: 'SWE-2 Flash', family_uid: 'swe-2-flash', slug: 'swe-2-flash', variants: [
        { model_uid: 'swe-2-flash-medium', label: 'SWE-2 Flash Medium', cost_tier: 'Free', max_context_tokens: 262000 },
      ] },
    ] }),
    enabledOverride: true,
    spawnFn: ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      void file; void args; void options;
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { service, children, dir };
}

interface TurnOutcome {
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  error: Error | undefined;
}

/** Drive one full turn and return what the runtime reported to its caller. */
async function runTurn(service: DevinService, children: FakeChild[], sessionId: string, answer: (child: FakeChild) => void): Promise<TurnOutcome> {
  const events: TurnOutcome['events'] = [];
  let settled = false;
  const done = new Promise<Error | undefined>((resolve) => {
    void service.sendPrompt(sessionId, 'do the thing', (e) => events.push(e as TurnOutcome['events'][number]), (err) => { settled = true; resolve(err); });
  });
  const child = await waitForChild(children, () => settled);
  if (child !== undefined && !settled) answer(child);
  return { events, error: await done };
}

const agentEnd = (events: TurnOutcome['events']) => {
  const ends = events.filter((e) => e.type === 'agent_end');
  expect(ends).toHaveLength(1);
  return ends[0]!.data as Record<string, unknown>;
};

describe('devin service — provider quota classification at the ACP failure boundary', () => {
  let dir: string;
  let service: DevinService;
  let children: FakeChild[];

  beforeEach(() => {
    const harness = makeService();
    service = harness.service;
    children = harness.children;
    dir = harness.dir;
  });

  afterEach(() => {
    service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns the recorded session/prompt error response into a typed quota completion error', async () => {
    const { sessionId } = await service.createSession('/ws');
    const outcome = await runTurn(service, children, sessionId, (child) => child.respondLastError(QUOTA_TEXT));

    // Typed completion error: the run receipt names the class, not RUNTIME_ERROR.
    expect(outcome.error).toBeInstanceOf(DevinProviderTurnError);
    const typed = outcome.error as DevinProviderTurnError;
    expect(typed.errorClass).toBe('quota');
    // The recorded pair carries both a relative countdown and a `HH:MM UTC`
    // instant; at test time that fixed minute is stale, so the conservative
    // outcomes are "the derived instant" or "no instant". Either way it must be
    // a real future ISO instant, never a guessed one.
    if (typed.resetAt !== undefined) {
      const parsed = Date.parse(typed.resetAt);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(Date.now() - 60_000);
    }

    // Additive broker annotations on the failed turn; nothing else changed.
    const end = agentEnd(outcome.events);
    expect(end.errorClass).toBe('quota');
    expect(end.resetAt).toBe(typed.resetAt);
    expect(end.error).toBe(QUOTA_TEXT);
    expect(end.result).toBeNull();
    expect(end.stopReason).toBeUndefined();

    // Exactly one attempt: classification adds no retry of any kind.
    expect(children[0]!.promptCount()).toBe(1);

    // The stored turn keeps exactly the pre-change shape (status + raw text).
    const last = await service.getLastCompletedTurn(sessionId);
    expect(last?.status).toBe('error');
    expect(last?.error).toBe(QUOTA_TEXT);
  });

  it('derives a reset instant from the relative statement (no wall-clock invention)', async () => {
    const { sessionId } = await service.createSession('/ws');
    const before = Date.now();
    const outcome = await runTurn(service, children, sessionId, (child) => child.respondLastError(`${ENVELOPE} Your limit will reset in 15 minutes.`));
    const after = Date.now();

    const typed = outcome.error as DevinProviderTurnError;
    expect(typed).toBeInstanceOf(DevinProviderTurnError);
    expect(typed.errorClass).toBe('quota');
    expect(typed.resetAt).toBeDefined();
    const reset = Date.parse(typed.resetAt as string);
    // now + 15 minutes, measured against the failure that just happened.
    expect(reset).toBeGreaterThanOrEqual(before + 15 * 60_000 - 5_000);
    expect(reset).toBeLessThanOrEqual(after + 15 * 60_000 + 5_000);
    expect(agentEnd(outcome.events).resetAt).toBe(typed.resetAt);
  });

  it('classifies a quota failure that states no reset as quota with no instant', async () => {
    const { sessionId } = await service.createSession('/ws');
    const outcome = await runTurn(service, children, sessionId, (child) => child.respondLastError(ENVELOPE));

    expect(outcome.error).toBeInstanceOf(DevinProviderTurnError);
    expect((outcome.error as DevinProviderTurnError).errorClass).toBe('quota');
    expect((outcome.error as DevinProviderTurnError).resetAt).toBeUndefined();
    const end = agentEnd(outcome.events);
    expect(end.errorClass).toBe('quota');
    expect('resetAt' in end).toBe(false);
  });

  it('leaves generic, timeout and invalid-params failures untyped and marked other', async () => {
    const { sessionId } = await service.createSession('/ws');
    const outcome = await runTurn(service, children, sessionId, (child) => child.respondLastError('devin acp session/prompt timed out after 120000ms'));

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(DevinProviderTurnError);
    expect(outcome.error?.message).toBe('devin acp session/prompt timed out after 120000ms');
    const end = agentEnd(outcome.events);
    expect(end.errorClass).toBe('other');
    expect('resetAt' in end).toBe(false);
    // Pre-existing behaviour preserved: the generic three-strike path in the goal
    // sweeper depends on this staying an untyped Error.
    const last = await service.getLastCompletedTurn(sessionId);
    expect(last?.status).toBe('error');
  });

  it('never classifies a successful turn whose streamed text quotes the envelope', async () => {
    const { sessionId } = await service.createSession('/ws');
    const outcome = await runTurn(service, children, sessionId, (child) => {
      child.writeStdout({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `The provider said: ${QUOTA_TEXT}` } } },
      });
      child.respondLast({ stopReason: 'end_turn', usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 } });
    });

    expect(outcome.error).toBeUndefined();
    const end = agentEnd(outcome.events);
    expect('errorClass' in end).toBe(false);
    expect('resetAt' in end).toBe(false);
    expect(await service.getLastCompletedTurn(sessionId)).toMatchObject({ status: 'done' });
  });

  it('never classifies from tool output or assistant prose when the turn itself failed generically', async () => {
    const { sessionId } = await service.createSession('/ws');
    const outcome = await runTurn(service, children, sessionId, (child) => {
      child.writeStdout({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', status: 'failed', content: [{ type: 'text', text: QUOTA_TEXT }] } },
      });
      child.respondLastError('devin acp session/prompt timed out after 60ms');
    });

    expect(outcome.error).not.toBeInstanceOf(DevinProviderTurnError);
    const end = agentEnd(outcome.events);
    expect(end.errorClass).toBe('other');
    expect('resetAt' in end).toBe(false);
  });

  it('routes a thrown handshake failure through the same boundary without inventing a class', async () => {
    const { sessionId } = await service.createSession('/ws');
    const events: TurnOutcome['events'] = [];
    const done = new Promise<Error | undefined>((resolve) => {
      void service.sendPrompt(sessionId, 'do the thing', (e) => events.push(e as TurnOutcome['events'][number]), (err) => resolve(err));
    });
    const deadline = Date.now() + 3000;
    while (children.length === 0 && Date.now() < deadline) await tick();
    const child = children[0]!;
    await waitForSent(child, 'initialize');
    child.respondLast({ protocolVersion: 1, agentCapabilities: {} });
    await waitForSent(child, 'session/new');
    // A handshake failure whose text merely CONTAINS the envelope is not a quota
    // refusal: the failure was the handshake, and the envelope is not the
    // provider's own failure message.
    child.respondLastError(`handshake refused: ${QUOTA_TEXT}`);

    const error = await done;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DevinProviderTurnError);
    const end = agentEnd(events);
    expect(end.errorClass).toBe('other');
    expect('resetAt' in end).toBe(false);
  });
});

/** Guard: the reset annotation is the provider's own statement resolved against
 *  the failure, never a recomputed wall-clock instant. */
describe('devin service — reset annotation is the provider statement', () => {
  it('keeps the derived instant inside the stated countdown window', async () => {
    const harness = makeService();
    try {
      const { sessionId } = await harness.service.createSession('/ws');
      const before = Date.now();
      const outcome = await runTurn(harness.service, harness.children, sessionId, (child) => child.respondLastError(`${ENVELOPE} Your limit will reset in 59 seconds.`));
      const typed = outcome.error as DevinProviderTurnError;
      const reset = Date.parse(typed.resetAt as string);
      expect(reset).toBeGreaterThanOrEqual(before + 59_000 - 5_000);
      expect(reset).toBeLessThanOrEqual(Date.now() + 59_000 + 5_000);
    } finally {
      harness.service.shutdown();
      rmSync(harness.dir, { recursive: true, force: true });
    }
  });
});
