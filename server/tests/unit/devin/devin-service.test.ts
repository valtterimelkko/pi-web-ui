import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevinService } from '../../../src/devin/devin-service.js';

/**
 * Service-level behaviours over a fake `devin acp` child (no real runtime):
 * turn lifecycle + persistence, ALWAYS agent_end (cancel/error), FIFO
 * follow-up queue, busy 409s, level swap, respawn → session/load, registry
 * native id persistence. Wire shapes from /root/devin-trial/acp-*.jsonl.
 *
 * Synchronisation: sendPrompt resolves when the turn STARTS; completion is
 * observed via the onComplete callback (wrapped in a promise per test).
 */

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly signals: string[] = [];
  readonly spawnEnv: NodeJS.ProcessEnv;
  readonly stdin: Writable;
  lastRequestId: string | number | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    super();
    this.spawnEnv = env;
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

function makeService(opts: { catalogue?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'devin-service-test-'));
  mkdirSync(dir, { recursive: true });
  const children: FakeChild[] = [];
  const service = new DevinService({
    registryPath: join(dir, 'registry.json'),
    sessionDir: join(dir, 'sessions'),
    executablePath: '/root/.local/bin/devin',
    devinHome: join(dir, 'devin-home'),
    modelsOutput: opts.catalogue ?? JSON.stringify({ families: [
      { family_label: 'SWE-2 Flash', family_uid: 'swe-2-flash', slug: 'swe-2-flash', variants: [
        { model_uid: 'swe-2-flash-medium', label: 'SWE-2 Flash Medium', cost_tier: 'Free', max_context_tokens: 262000 },
        { model_uid: 'swe-2-flash-high', label: 'SWE-2 Flash High', cost_tier: 'Free', max_context_tokens: 262000 },
        { model_uid: 'swe-2-flash-max', label: 'SWE-2 Flash Max', cost_tier: 'Free', max_context_tokens: 262000 },
      ] },
    ] }),
    enabledOverride: true,
    spawnFn: ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(options.env ?? {});
      void file; void args;
      children.push(child);
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { service, children, dir };
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the lazy spawn (registry/store writes precede it), then complete
 *  the ACP handshake: initialize, session/new, bypass set, model set. */
async function waitForChild(children: FakeChild[], timeoutMs = 3000): Promise<FakeChild> {
  const deadline = Date.now() + timeoutMs;
  while (children.length === 0 && Date.now() < deadline) await tick();
  const child = children[0]!;
  expect(child).toBeDefined();
  await tick();
  child.respondLast({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await tick();
  child.respondLast({ sessionId: 'brass-akubra', modes: { currentModeId: 'accept-edits', availableModes: [] }, configOptions: [] });
  await tick();
  child.respondLast({}); // bypass mode set
  await tick();
  child.respondLast({}); // service-side model set
  await tick();
  return child;
}

function promptResult(stopReason = 'end_turn', input = 14362, output = 28): unknown {
  return { stopReason, usage: { totalTokens: input + output, inputTokens: input, outputTokens: output } };
}

describe('devin service', () => {
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

  it('createSession registers a devin session; the first prompt lazily spawns, streams, persists and finalizes with agent_end', async () => {
    const { sessionId } = await service.createSession('/ws');
    const entry = await service.getSession(sessionId);
    expect(entry?.sdkType).toBe('devin');

    const events: any[] = [];
    const completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'Reply READY.', (e) => events.push(e), () => resolve());
    });
    const child = await waitForChild(children);
    // prompt streams a chunk, then the terminal result arrives
    child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READY' } } } });
    child.respondLast(promptResult());
    await completed;

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');
    const end = events.find((e) => e.type === 'agent_end');
    expect(end.data.usage.input).toBe(14362);
    // native session id persisted (registry nativeSessionId + devin field)
    const updated = await service.getSession(sessionId);
    expect(updated?.nativeSessionId).toBe('brass-akubra');
    expect(updated?.devinNativeSessionId).toBe('brass-akubra');
    // turn persisted and status back to idle
    const replay = await service.getReplayEvents(sessionId);
    expect(replay.some((e) => (e as { type?: string }).type === 'agent_end')).toBe(true);
    expect(service.isRunning(sessionId)).toBe(false);
    // child keeps running after the turn (idle shutdown owns it, not the turn)
    expect(children.length).toBe(1);
  });

  it('abort mid-turn ALWAYS emits agent_end (cancelled) and the prompt resolves', async () => {
    const { sessionId } = await service.createSession('/ws');
    const events: any[] = [];
    const completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'Run `sleep 60`.', (e) => events.push(e), () => resolve());
    });
    const child = await waitForChild(children);
    service.abort(sessionId);
    expect(child.sent().some((m) => m.method === 'session/cancel')).toBe(true);
    child.respondLast(promptResult('cancelled'));
    await completed;
    const ends = events.filter((e) => e.type === 'agent_end');
    expect(ends.length).toBe(1);
    expect(ends[0]!.data.cancelled).toBe(true);
  });

  it('a prompt-level error finalizes with agent_end and a non-empty error body (never blank)', async () => {
    const { sessionId } = await service.createSession('/ws');
    const events: any[] = [];
    const completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'x', (e) => events.push(e), () => resolve());
    });
    const child = await waitForChild(children);
    child.respondLast(promptResult('error'));
    await completed;
    const end = events.find((e) => e.type === 'agent_end');
    expect(end).toBeDefined();
    expect(end.data.error).toBeDefined();
    // error body visible as an assistant message (RC2)
    const starts = events.filter((e) => e.type === 'message_start');
    expect(starts.length).toBeGreaterThan(0);
  });

  it('followUp while busy queues FIFO and runs as the next turn; returns false when idle', async () => {
    const { sessionId } = await service.createSession('/ws');
    const turn1Events: any[] = [];
    const allEvents: any[] = [];
    const turn1Completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'first', (e) => turn1Events.push(e), () => resolve());
    });
    const child = await waitForChild(children);
    child.respondLast(promptResult());
    await turn1Completed;

    // Busy simulation: start turn 2, queue follow-up before answering.
    const turn2Completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'second', (e) => allEvents.push(e), () => resolve());
    });
    await tick();
    const queued = await service.followUp(sessionId, 'queued-third', () => allEvents.push({ type: 'stream_activity' } as any), () => undefined);
    expect(queued).toBe(true);
    child.respondLast(promptResult());
    await turn2Completed;
    // the queued turn drains next; wait for its prompt to be sent, answer it
    const deadline = Date.now() + 2000;
    while (child.sent().filter((m) => m.method === 'session/prompt').length < 3 && Date.now() < deadline) await tick();
    child.respondLast(promptResult());
    const prompts = child.sent().filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt[0].text);
    expect(prompts).toEqual(['first', 'second', 'queued-third']);
    // the queued turn completes on its own answer; wait for the session to go idle
    const idleDeadline = Date.now() + 2000;
    while (service.isRunning(sessionId) && Date.now() < idleDeadline) await tick();
    // idle follow-up returns false
    expect(await service.followUp(sessionId, 'nope', () => undefined, () => undefined)).toBe(false);
  });

  it('prompt while busy throws SESSION_BUSY (steer is refused)', async () => {
    const { sessionId } = await service.createSession('/ws');
    const completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'busy turn', () => undefined, () => resolve());
    });
    const child = await waitForChild(children);
    await expect(service.sendPrompt(sessionId, 'steer!', () => undefined, () => undefined)).rejects.toThrow(/SESSION_BUSY/);
    child.respondLast(promptResult());
    await completed;
  });

  it('setThinkingLevel while busy refuses with SESSION_BUSY; when idle swaps to the sibling id', async () => {
    const { sessionId } = await service.createSession('/ws');
    await service.setModel(sessionId, 'swe-2-flash-medium');
    const completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'busy', () => undefined, () => resolve());
    });
    await waitForChild(children);
    await expect(service.setThinkingLevel(sessionId, 'high')).rejects.toThrow(/SESSION_BUSY/);
    children[0]!.respondLast(promptResult());
    await completed;
    // idle path: sibling swap persists in the registry. The live child gets a
    // set_config_option write; answer it.
    const swapPromise = service.setThinkingLevel(sessionId, 'high');
    await tick();
    children[0]!.respondLast({});
    const slug = await swapPromise;
    expect(slug).toBe('swe-2-flash-high');
    expect((await service.getSession(sessionId))?.model).toBe('swe-2-flash-high');
  });

  it('setModel on a paid model is allowed (ruling 01: no allow-list)', async () => {
    const { sessionId } = await service.createSession('/ws');
    const slug = await service.setModel(sessionId, 'claude-opus-5-5-high');
    expect(slug).toBe('claude-opus-5-5-high');
    expect((await service.getSession(sessionId))?.model).toBe('claude-opus-5-5-high');
  });

  it('process idle shutdown → respawn resumes via session/load replaying history', async () => {
    const { sessionId } = await service.createSession('/ws');
    const events: any[] = [];
    const turn1Completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'turn one', (e) => events.push(e), () => resolve());
    });
    const child1 = await waitForChild(children);
    child1.respondLast(promptResult());
    await turn1Completed;

    // Simulate idle shutdown of the process (service-owned) then a new turn.
    service.shutdownProcessForTest(sessionId);
    expect(child1.signals.length).toBeGreaterThan(0);
    const turn2Completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'turn two', () => undefined, () => resolve());
    });
    const deadline = Date.now() + 3000;
    while (children.length < 2 && Date.now() < deadline) await tick();
    expect(children.length).toBe(2); // respawned
    const child2 = children[1]!;
    await tick();
    child2.respondLast({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    await tick();
    child2.respondLast({ sessionId: 'brass-akubra', modes: { currentModeId: 'accept-edits', availableModes: [] }, configOptions: [] });
    await tick();
    child2.respondLast({}); // bypass mode set
    await tick();
    child2.respondLast({}); // model set
    await tick();
    // the respawned child must have received session/load with the native id
    const load = child2.sent().find((m) => m.method === 'session/load');
    expect(load?.params).toMatchObject({ sessionId: 'brass-akubra' });
    child2.respondLast(promptResult());
    await turn2Completed;
    // store holds both turns
    const replay = await service.getReplayEvents(sessionId);
    const agentEnds = replay.filter((e) => (e as { type?: string }).type === 'agent_end');
    expect(agentEnds.length).toBeGreaterThanOrEqual(2);
  });

  it('availableModels parses the catalogue with levels and pricing (no allow-list, ruling 01)', async () => {
    const models = await service.getAvailableModels();
    const flash = models.find((m) => m.id === 'swe-2-flash-medium');
    expect(flash?.thinkingLevels).toEqual(['medium', 'high', 'max']);
    expect(flash?.pricing?.free).toBe(true);
  });

  it('session store persists at the configured dir', async () => {
    const { sessionId } = await service.createSession('/ws');
    const completed = new Promise<void>((resolve) => {
      void service.sendPrompt(sessionId, 'persist me', () => undefined, () => resolve());
    });
    const child = await waitForChild(children);
    child.respondLast(promptResult());
    await completed;
    expect(existsSync(join(dir, 'sessions', `${sessionId}.jsonl`))).toBe(true);
  });
});
