import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { AgyStreamProcess } from '../../../src/antigravity/agy-stream-process.js';
import type { ParsedAgyLine } from '../../../src/antigravity/agy-event-types.js';
import { parseAgyLine } from '../../../src/antigravity/agy-event-types.js';

/**
 * Controllable fake child: tests drive stdout lines / exit and inspect stdin
 * writes + signals. No real agy process is spawned in this suite.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly signals: string[] = [];
  readonly stdin: Writable;

  constructor() {
    super();
    const writes = this.stdinWrites;
    this.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        writes.push(chunk.toString());
        cb();
      },
      final(cb) {
        writes.push('__END__');
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

interface HarnessOptions {
  sessionId?: string;
  cwd?: string;
  model?: string;
  conversationId?: string | null;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  toolStallTimeoutMs?: number;
  idleTimeoutMs?: number;
  onEvent?: (parsed: ParsedAgyLine) => void;
}

function makeHarness(opts: HarnessOptions = {}) {
  const child = new FakeChild();
  const eventsEmitted: ParsedAgyLine[] = [];
  const proc = new AgyStreamProcess({
    sessionId: opts.sessionId ?? 'sess-1',
    cwd: opts.cwd ?? '/tmp/agy-lv',
    model: opts.model ?? 'gemini-3.6-flash-low',
    conversationId: opts.conversationId ?? null,
    timeoutMs: opts.timeoutMs ?? 60_000,
    stallTimeoutMs: opts.stallTimeoutMs ?? 30_000,
    ...(opts.toolStallTimeoutMs !== undefined ? { toolStallTimeoutMs: opts.toolStallTimeoutMs } : {}),
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    onEvent: opts.onEvent ?? ((parsed) => eventsEmitted.push(parsed)),
    spawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
  });
  return { proc, child, eventsEmitted };
}

const INIT_LINE =
  '{"event":"init","conversation_id":"c-abc","init":{"cwd":"/tmp/agy-lv","tools":["run_command"],"permission_mode":"always-proceed","model":"gemini-3.6-flash-low"}}';

function resultLine(conv = 'c-abc', numTurns = 1, status = 'SUCCESS'): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: conv,
      status,
      response: `reply ${numTurns}\n`,
      duration_seconds: 1.2,
      num_turns: numTurns,
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
    },
  });
}

describe('AgyStreamProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T3.1: spawns with stream-json flags, canonical slug, and never an empty conversation id', async () => {
    const seen: string[][] = [];
    const child = new FakeChild();
    const proc = new AgyStreamProcess({
      sessionId: 's',
      cwd: '/w',
      model: 'gemini-3.6-flash-low',
      conversationId: '',
      timeoutMs: 1000,
      stallTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      onEvent: () => {},
      spawnFn: ((...args: unknown[]) => {
        seen.push(args[1] as string[]);
        return child;
      }) as unknown as typeof import('node:child_process').spawn,
    });
    await proc.start();
    expect(seen).toHaveLength(1);
    const args = seen[0];
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args.indexOf('--conversation')).toBe(-1); // empty id → fresh process
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.6-flash-low');
  });

  it('T3.1: passes a valid conversation id through to the spawn args', async () => {
    const seen: string[][] = [];
    const child = new FakeChild();
    const proc = new AgyStreamProcess({
      sessionId: 's',
      cwd: '/w',
      conversationId: '329bb0ec-d969-48eb-91f8-b0618396776e',
      timeoutMs: 1000,
      stallTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      onEvent: () => {},
      spawnFn: ((...args: unknown[]) => {
        seen.push(args[1] as string[]);
        return child;
      }) as unknown as typeof import('node:child_process').spawn,
    });
    await proc.start();
    const idx = seen[0].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(seen[0][idx + 1]).toBe('329bb0ec-d969-48eb-91f8-b0618396776e');
  });

  it('T3.2: streams NDJSON across chunked stdout deliveries; malformed lines never crash the reader', async () => {
    const { proc, child, eventsEmitted } = makeHarness();
    await proc.start();
    child.stdout.emit('data', Buffer.from(INIT_LINE.slice(0, 40)));
    child.stdout.emit('data', Buffer.from(INIT_LINE.slice(40) + '\n' + '{"event":"step_up'));
    child.stdout.emit('data', Buffer.from('date","step_update":{"conversation_id":"c-abc","step_index":0,"state":"DONE","step_type":"user_input"}}\n'));
    child.stdout.emit('data', Buffer.from('not json at all\n'));
    expect(eventsEmitted.map((p) => p.kind)).toEqual(['init', 'step', 'invalid']);
  });

  it('T3.3: writeTurn resolves with the turn outcome on the next result', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('Reply: ok');
    expect(child.stdinWrites).toHaveLength(1);
    expect(JSON.parse(child.stdinWrites[0])).toEqual({ event: 'user', message: { content: 'Reply: ok' } });
    child.writeStdout(resultLine('c-abc', 1));
    const outcome = await pending;
    expect(outcome.status).toBe('SUCCESS');
    expect(outcome.response).toBe('reply 1\n');
    expect(outcome.usage?.total).toBe(12);
    expect(outcome.conversationId).toBe('c-abc');
  });

  it('T3.3: a mid-turn write is written through (agy queues it) and resolves with the SECOND result — FIFO order', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const first = proc.writeTurn('turn one');
    const second = proc.writeTurn('turn two (queued)');
    expect(child.stdinWrites).toHaveLength(2);
    child.writeStdout(resultLine('c-abc', 1));
    expect(await first).toMatchObject({ status: 'SUCCESS', response: 'reply 1\n' });
    child.writeStdout(resultLine('c-abc', 2));
    expect(await second).toMatchObject({ status: 'SUCCESS', response: 'reply 2\n' });
  });

  it('T3.4: per-turn hard ceiling kills the process and resolves pending turns with reason timeout', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 5_000, stallTimeoutMs: 60_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('slow turn');
    await vi.advanceTimersByTimeAsync(5_001);
    expect(child.signals).toContain('SIGTERM');
    const outcome = await pending;
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toBe('timeout');
  });

  it('T3.4: stall watchdog fires only after stallTimeoutMs without ANY parsed events', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 120_000, stallTimeoutMs: 10_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('stalling turn');
    // event flow at 9s keeps resetting the stall window
    await vi.advanceTimersByTimeAsync(9_000);
    child.writeStdout('{"event":"step_update","step_update":{"conversation_id":"c-abc","step_index":1,"state":"DONE","step_type":"unknown"}}');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(child.signals).not.toContain('SIGTERM');
    // now let the window lapse fully
    await vi.advanceTimersByTimeAsync(1_001);
    expect(child.signals).toContain('SIGTERM');
    const outcome = await pending;
    expect(outcome.reason).toBe('stall');
  });

  const toolStep = (state: string, idx = 3) =>
    `{"event":"step_update","step_update":{"conversation_id":"c-abc","step_index":${idx},"state":"${state}","step_type":"tool","tool_name":"run_command"}}`;

  it('ceiling-fix: a running tool is silent on the wire, so it gets the longer tool-stall window, not the model-silence window', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 1_000_000, stallTimeoutMs: 10_000, toolStallTimeoutMs: 100_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('long build');
    child.writeStdout(toolStep('ACTIVE'));
    // well past the model-silence window, still inside the tool window: alive
    await vi.advanceTimersByTimeAsync(90_000);
    expect(child.signals).not.toContain('SIGTERM');
    // the tool finishes and the model then goes silent: back to the short window
    child.writeStdout(toolStep('DONE'));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(child.signals).not.toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(child.signals).toContain('SIGTERM');
    expect((await pending).reason).toBe('stall');
  });

  it('ceiling-fix: a tool silent past even the tool-stall window is still killed as a stall', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 1_000_000, stallTimeoutMs: 10_000, toolStallTimeoutMs: 50_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('hung tool');
    child.writeStdout(toolStep('ACTIVE'));
    await vi.advanceTimersByTimeAsync(49_000);
    expect(child.signals).not.toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await pending).reason).toBe('stall');
  });

  it('ceiling-fix: tool-in-flight state does not leak across turns (a finished turn cannot extend the next turn\'s stall window)', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 1_000_000, stallTimeoutMs: 10_000, toolStallTimeoutMs: 100_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const first = proc.writeTurn('turn one');
    child.writeStdout(toolStep('ACTIVE')); // never reported DONE
    child.writeStdout(resultLine('c-abc', 1));
    await first;
    const second = proc.writeTurn('turn two');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(child.signals).toContain('SIGTERM');
    expect((await second).reason).toBe('stall');
  });

  it('ceiling-fix: a queued turn\'s hard ceiling starts when it becomes the head, not when it was written', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 5_000, stallTimeoutMs: 600_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const first = proc.writeTurn('turn one');
    const second = proc.writeTurn('turn two (queued)');
    await vi.advanceTimersByTimeAsync(4_000);
    child.writeStdout(resultLine('c-abc', 1));
    await first;
    // 4 s queued + 3 s running = 7 s since the write, but only 3 s of its own run
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.signals).not.toContain('SIGTERM');
    child.writeStdout(resultLine('c-abc', 2));
    expect(await second).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['stall', { timeoutMs: 120_000, stallTimeoutMs: 1_000 }],
    ['timeout', { timeoutMs: 1_000, stallTimeoutMs: 600_000 }],
  ] as const)('ceiling-fix: after a %s cut-off the dying process is unusable at once, so a prompt sent before it exits cannot inherit its closing "interrupted" result', async (_name, opts) => {
    const { proc, child } = makeHarness(opts);
    await proc.start();
    child.writeStdout(INIT_LINE);
    const cut = proc.writeTurn('cut off turn');
    await vi.advanceTimersByTimeAsync(1_001);
    await cut;
    expect(child.signals).toContain('SIGTERM');
    // the child has been signalled but has NOT closed yet
    expect(proc.hasExited).toBe(true);
    await expect(proc.writeTurn('follow-up')).rejects.toThrow(/respawn required/);
    expect(child.stdinWrites).toHaveLength(1);
  });

  it('ceiling-fix: an aborted process is likewise unusable until it has been respawned', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    void proc.writeTurn('to be aborted');
    proc.abort();
    expect(proc.hasExited).toBe(true);
    await expect(proc.writeTurn('follow-up')).rejects.toThrow(/respawn required/);
  });

  it('T3.4/T3.6: abort SIGTERMs, consumes the closing result, resolves with reason aborted', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('to be aborted');
    proc.abort();
    expect(child.signals).toContain('SIGTERM');
    child.writeStdout(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'c-abc', status: 'ERROR', response: '', error: 'timeout waiting for response',
          duration_seconds: 0.2, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        },
      }),
    );
    const outcome = await pending;
    expect(outcome.reason).toBe('aborted');
    expect(outcome.status).toBe('ERROR');
  });

  it('T3.4: if no closing result arrives after abort, SIGKILL escalation resolves the turn aborted', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('never completes');
    proc.abort();
    await vi.advanceTimersByTimeAsync(6_000); // past the abort grace window
    expect(child.signals).toContain('SIGKILL');
    child.close(1);
    const outcome = await pending;
    expect(outcome.reason).toBe('aborted');
  });

  it('T3.3: process death with pending turns resolves them with reason process-exited', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('doomed');
    child.close(1);
    const outcome = await pending;
    expect(outcome.reason).toBe('process-exited');
  });

  it('T3.5: idle timeout closes stdin after the idle window with no pending turns', async () => {
    const { proc, child } = makeHarness({ idleTimeoutMs: 2_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const done = proc.writeTurn('quick');
    child.writeStdout(resultLine());
    await done;
    expect(child.stdinWrites.filter((w) => w === '__END__')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(child.stdinWrites).toContain('__END__');
  });

  it('tracks conversationId from result events for durable persistence', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const done = proc.writeTurn('x');
    child.writeStdout(resultLine('c-new-id', 1));
    await done;
    expect(proc.conversationId).toBe('c-new-id');
  });

  it('rejects writeTurn after the process has exited (caller respawns)', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    child.close(0);
    await expect(proc.writeTurn('after death')).rejects.toThrow(/exited/i);
  });
});

describe('AgyStreamProcess parser contract', () => {
  it('parseAgyLine discriminates the wire fixture (shared contract)', () => {
    expect(parseAgyLine(resultLine()).kind).toBe('result');
  });
});
