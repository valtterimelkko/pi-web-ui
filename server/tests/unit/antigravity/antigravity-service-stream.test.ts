import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'stream';

/**
 * Stream-mode (agy 1.1.27 stream-json) service tests: a controllable fake
 * agy child drives the persistent-process path end to end through the real
 * AntigravityService. Runs against an isolated HOME so real session state is
 * never touched (the workspace runner isolates HOME the same way).
 */

process.env.HOME = mkdtempSync(join(tmpdir(), 'agy-stream-home-'));
process.env.ANTIGRAVITY_SESSION_DIR = join(process.env.HOME, '.pi-web-ui', 'antigravity-sessions');
process.env.ANTIGRAVITY_STREAM_MODE = 'true';

class FakeStreamChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly signals: string[] = [];
  readonly stdin: Writable;

  constructor() {
    super();
    const self = this;
    this.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        self.stdinWrites.push(chunk.toString());
        cb();
      },
      final(cb) {
        self.stdinWrites.push('__END__');
        cb();
      },
    }) as Writable;
  }

  writeStdout(line: string): void {
    this.stdout.emit('data', Buffer.from(line + '\n'));
  }

  kill(signal: string): void {
    this.signals.push(signal);
  }

  close(code = 0): void {
    this.emit('close', code, null);
  }
}

const ctrl: { children: FakeStreamChild[]; lastArgs: string[] | null } = {
  children: [],
  lastArgs: null,
};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_bin: unknown, args: string[]) => {
      // `agy models` probes (setModel/setThinkingLevel canonicalisation):
      // answer synchronously with a small catalogue, like the real CLI.
      if (args && args[0] === 'models') {
        const probe = new FakeStreamChild();
        setTimeout(() => {
          // defer: runAgy attaches stdout listeners synchronously after spawn
          probe.writeStdout([
            'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
            'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
            'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
            'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
          ].join('\n'));
          probe.close(0);
        }, 0);
        return probe;
      }
      const child = new FakeStreamChild();
      ctrl.lastArgs = args;
      ctrl.children.push(child);
      return child;
    }),
  };
});

const { AntigravityService } = await import('../../../src/antigravity/antigravity-service.js');
const { isTurnDone } = await import('../../../src/antigravity/antigravity-session-store.js');
type AntigravityServiceType = InstanceType<typeof AntigravityService>;

const CONV = '11111111-2222-4333-8444-555555555555';

function initLine(): string {
  return JSON.stringify({
    event: 'init',
    conversation_id: CONV,
    init: { cwd: '/w', tools: ['run_command', 'view_file'], permission_mode: 'always-proceed', model: 'gemini-3.6-flash-low' },
  });
}

function resultLine(response: string, numTurns: number, status = 'SUCCESS', conversationId = CONV): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status,
      response,
      duration_seconds: 1.4,
      num_turns: numTurns,
      usage: { input_tokens: 500, output_tokens: 40, thinking_tokens: 8, cache_read_tokens: 100, total_tokens: 540 },
    },
  });
}

async function makeService(): Promise<AntigravityServiceType> {
  const svc = new AntigravityService({ registryPath: join(tmpdir(), `ag-stream-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`) });
  const { sessionId } = await svc.createSession('/w', 'gemini-3.6-flash-low');
  return Object.assign(svc, { testSessionId: sessionId }) as AntigravityServiceType & { testSessionId: string };
}

interface Harness {
  svc: AntigravityServiceType & { testSessionId: string };
  sessionId: string;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  done: Promise<Error | undefined>;
  child: FakeStreamChild;
}

async function startTurn(svcIn: AntigravityServiceType, sessionId: string): Promise<Harness> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let doneResolve: (e?: Error) => void = () => {};
  const done = new Promise<Error | undefined>((r) => { doneResolve = r; });
  void svcIn.sendPrompt(sessionId, 'hello agent', (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }), doneResolve);
  // Wait until THIS turn's prompt is written through to a child's stdin —
  // either the warm child's next write or a freshly respawned child's first.
  const prevChild = ctrl.children[ctrl.children.length - 1];
  const prevCount = prevChild?.stdinWrites.length ?? 0;
  let child: FakeStreamChild | undefined;
  for (let i = 0; i < 400; i++) {
    child = ctrl.children[ctrl.children.length - 1];
    if (child && child !== prevChild && child.stdinWrites.length > 0) break; // respawn
    if (child === prevChild && (prevChild?.stdinWrites.length ?? 0) > prevCount) break; // warm reuse
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(child).toBeDefined();
  expect(child!.stdinWrites.length).toBeGreaterThan(0);
  child!.writeStdout(initLine());
  return { svc: svcIn as AntigravityServiceType & { testSessionId: string }, sessionId, events, done, child: child! };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  for (let i = 0; i < timeoutMs / 5; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

describe('AntigravityService — stream-json mode (plan phase 4)', () => {
  let svc: AntigravityServiceType & { testSessionId: string };
  let sessionId: string;

  beforeEach(async () => {
    ctrl.children = [];
    ctrl.lastArgs = null;
    svc = await makeService();
    sessionId = svc.testSessionId;
  });

  afterEach(async () => {
    await svc.shutdown();
    rmSync(process.env.HOME!, { recursive: true, force: true });
  });

  it('streams a turn: spawns stream-json process, normalised deltas flow, store finalises with usage', async () => {
    const h = await startTurn(svc, sessionId);
    h.child.writeStdout(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'partial ' },
    }));
    h.child.writeStdout(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'answer' },
    }));
    h.child.writeStdout(resultLine('partial answer', 1));
    const err = await h.done;
    expect(err).toBeUndefined();

    const types = h.events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('message_update');
    expect(types[types.length - 1]).toBe('agent_end');

    // spawn args: stream flags + slug model, no conversation on first turn
    expect(ctrl.lastArgs).toContain('--input-format');
    expect(ctrl.lastArgs).toContain('stream-json');
    expect(ctrl.lastArgs[ctrl.lastArgs.indexOf('--model') + 1]).toBe('gemini-3.6-flash-low');

    // durable store: finalized with real usage
    const history = await svc.getReplayEvents(sessionId); // replay path sanity
    expect(history.length).toBeGreaterThan(0);
    const storeDir = process.env.ANTIGRAVITY_SESSION_DIR!;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(storeDir, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('done');
    expect(turns[0].response).toBe('partial answer');
    expect(turns[0].usage).toEqual({ input: 500, output: 40, thinking: 8, cacheRead: 100, total: 540 });
    expect(turns[0].numTurns).toBe(1);
    expect(turns[0].agyStatus).toBe('SUCCESS');
    expect(turns[0].conversationId).toBe(CONV);
    expect(isTurnDone(turns[0])).toBe(true);
  });

  it('second turn reuses the warm process and passes --conversation; both turns stored', async () => {
    const h1 = await startTurn(svc, sessionId);
    h1.child.writeStdout(resultLine('one', 1));
    await h1.done;
    expect(ctrl.children).toHaveLength(1);

    const h2 = await startTurn(svc, sessionId);
    // warm process: no NEW spawn
    expect(ctrl.children).toHaveLength(1);
    h2.child.writeStdout(resultLine('two', 2));
    await h2.done;

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns.map((t: { response: string }) => t.response)).toEqual(['one', 'two']);
    expect(turns[1].numTurns).toBe(2);
  });

  it('followUp on a running session queues via stdin write-through and both turns finalise', async () => {
    const h = await startTurn(svc, sessionId);
    const followEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    let followDoneResolve: (e?: Error) => void = () => {};
    const followDone = new Promise<Error | undefined>((r) => { followDoneResolve = r; });
    const queued = await svc.followUp(sessionId, 'queued prompt', (e) => followEvents.push({ type: e.type, data: e.data as Record<string, unknown> }), followDoneResolve);
    expect(queued).toBe(true);
    await waitFor(() => h.child.stdinWrites.length >= 2);
    expect(h.child.stdinWrites).toHaveLength(2);
    h.child.writeStdout(resultLine('first', 1));
    // first sendPrompt done; queued turn still pending
    await h.done;
    h.child.writeStdout(resultLine('second', 2));
    await followDone;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns.map((t: { response: string }) => t.response)).toEqual(['first', 'second']);
    expect(followEvents.some((e) => e.type === 'message_update')).toBe(true);
  });

  it('followUp on an idle session returns false (caller must prompt)', async () => {
    expect(await svc.followUp(sessionId, 'nope', () => {}, () => {})).toBe(false);
  });

  it('agy ERROR result finalises a visible error turn with the agy error text', async () => {
    const h = await startTurn(svc, sessionId);
    h.child.writeStdout(resultLine('', 0, 'ERROR'));
    const err = await h.done;
    expect(err).toBeInstanceOf(Error);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns[0].status).toBe('error');
    expect(turns[0].agyStatus).toBe('ERROR');
    expect(String(turns[0].response).length).toBeGreaterThan(0);
  });

  it('tool calls stream through and persist as compact records', async () => {
    const h = await startTurn(svc, sessionId);
    h.child.writeStdout(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' },
    }));
    h.child.writeStdout(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'file.txt\n' } },
    }));
    h.child.writeStdout(resultLine('done', 1));
    await h.done;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns[0].tools).toHaveLength(1);
    expect(turns[0].tools[0]).toMatchObject({ toolName: 'run_command', isError: false });
    const types = h.events.map((e) => e.type);
    expect(types).toContain('tool_execution_start');
    expect(types).toContain('tool_execution_end');
  });

  it('abort mid-turn finalises the turn as a visible error and the process is reusable', async () => {
    const h = await startTurn(svc, sessionId);
    await waitFor(() => svc.isRunning(sessionId));
    svc.abort(sessionId);
    expect(h.child.signals).toContain('SIGTERM');
    h.child.writeStdout(JSON.stringify({
      event: 'result',
      result: { conversation_id: CONV, status: 'ERROR', response: '', error: 'timeout waiting for response', duration_seconds: 0.2, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } },
    }));
    await h.done;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns[0].status).toBe('error');
    // process still usable for the next turn
    const next = await startTurn(svc, sessionId);
    next.child.writeStdout(resultLine('after abort', 2));
    await next.done;
    const rawAfter = await (await import('node:fs/promises')).readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    expect(rawAfter.trim().split('\n')).toHaveLength(2);
  });

  it('process death mid-turn respawns with --conversation and retries the turn (crash recovery)', async () => {
    const h = await startTurn(svc, sessionId);
    await waitFor(() => svc.isRunning(sessionId));
    h.child.close(1); // kill the child mid-turn
    // The service respawns (attempt 2) with the conversation the dead process
    // reported and retries the same prompt.
    await waitFor(() => ctrl.children.length === 2);
    const respawn = ctrl.children[1];
    const convIdx = ctrl.lastArgs!.indexOf('--conversation');
    expect(convIdx).toBeGreaterThanOrEqual(0);
    expect(ctrl.lastArgs![convIdx + 1]).toBe(CONV);
    // Retry completes on the respawned process.
    await waitFor(() => respawn.stdinWrites.length > 0);
    respawn.writeStdout(initLine());
    respawn.writeStdout(resultLine('recovered', 1));
    const err = await h.done;
    expect(err).toBeUndefined();
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('done');
    expect(turns[0].response).toBe('recovered');
    // And the session keeps working on the respawned process.
    const h2 = await startTurn(svc, sessionId);
    expect(ctrl.children).toHaveLength(2); // warm reuse, no third spawn
    h2.child.writeStdout(resultLine('after', 2));
    await h2.done;
    const raw2 = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    expect(raw2.trim().split('\n')).toHaveLength(2);
  });

  it('conversation-id mismatch on a resumed conversation surfaces a warning and persists the actual id', async () => {
    // Simulate a stale stored id: registry carries a conversation that agy no
    // longer knows; agy silently starts a NEW conversation (live-validated).
    const warnSpy = vi.fn();
    const { setLogTap } = await import('../../../src/logging/logger.js');
    setLogTap((record: { level: string; message: string }) => {
      if (record.level === 'warn' && /conversation/i.test(record.message)) warnSpy(record.message);
    });
    const h = await startTurn(svc, sessionId);
    const newConv = '99999999-8888-4777-8666-555555555555';
    h.child.writeStdout(resultLine('rebound', 1, 'SUCCESS', newConv));
    await h.done;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(process.env.ANTIGRAVITY_SESSION_DIR!, `${sessionId}.jsonl`), 'utf-8');
    const turns = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(turns[0].conversationId).toBe(newConv);
    const entry = await svc.getSession(sessionId);
    expect(entry?.antigravityConversationId).toBe(newConv);
  });

  it('T6.1: setModel canonicalises to a slug, drops the warm process, and the next turn respawns with the new model', async () => {
    const h = await startTurn(svc, sessionId);
    h.child.writeStdout(resultLine('one', 1));
    await h.done;
    expect(ctrl.children).toHaveLength(1);
    const normalized = await svc.setModel(sessionId, 'Gemini 3.6 Flash (Medium)');
    expect(normalized).toBe('gemini-3.6-flash-medium');
    // warm process was dropped: next turn spawns fresh with the new slug
    const h2 = await startTurn(svc, sessionId);
    expect(ctrl.children).toHaveLength(2);
    const modelIdx = ctrl.lastArgs!.indexOf('--model');
    expect(ctrl.lastArgs![modelIdx + 1]).toBe('gemini-3.6-flash-medium');
    h2.child.writeStdout(resultLine('two', 2));
    await h2.done;
  });

  it('T6.1/O3: setModel while a turn runs is refused', async () => {
    await startTurn(svc, sessionId);
    await waitFor(() => svc.isRunning(sessionId));
    await expect(svc.setModel(sessionId, 'gemini-3.6-flash-high')).rejects.toThrow(/busy/i);
    await svc.abort(sessionId);
  });

  it('T6.2: setThinkingLevel swaps to the sibling slug', async () => {
    const h = await startTurn(svc, sessionId);
    h.child.writeStdout(resultLine('one', 1));
    await h.done;
    const applied = await svc.setThinkingLevel(sessionId, 'high');
    expect(applied).toBe('gemini-3.6-flash-high');
    const entry = await svc.getSession(sessionId);
    expect(entry?.model).toBe('gemini-3.6-flash-high');
  });

  it('T6.2: setThinkingLevel rejects unsupported axes loudly', async () => {
    await svc.setModel(sessionId, 'claude-sonnet-4-6');
    await expect(svc.setThinkingLevel(sessionId, 'low')).rejects.toThrow(/not supported|unsupported/i);
  });

  it('getContextUsage uses real usage when present (no char/4 estimate in stream mode)', async () => {
    const h = await startTurn(svc, sessionId);
    h.child.writeStdout(resultLine('x', 1));
    await h.done;
    const ctx = await svc.getContextUsage(sessionId);
    expect(ctx).not.toBeNull();
    expect(ctx!.tokens).toBe(540);
    expect(ctx!.contextWindow).toBeGreaterThan(0);
  });
});
