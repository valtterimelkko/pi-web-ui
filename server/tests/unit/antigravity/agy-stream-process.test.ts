import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  /** Lane B: does the owning service still track running background work? */
  hasPendingBackgroundWork?: () => boolean;
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
    ...(opts.hasPendingBackgroundWork ? { hasPendingBackgroundWork: opts.hasPendingBackgroundWork } : {}),
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

  it('B1: disables agy slash-command parsing so owner text starting with / reaches the model', async () => {
    // agy 1.4.x recognises a leading `/command` on the stream-json stdin path,
    // answers a small read-only whitelist and REFUSES everything else with
    // "error: /clear is not available in print mode …", which errors the turn
    // (exit 2). Pi Web UI never wants agy's parser: `/goal …` is intercepted
    // server-side, the model switch is the `--model` argv flag, and skills are
    // not exposed through any Pi Web UI route. `--disable-slash-commands`
    // forces literal text, so an owner message is a message.
    const seen: string[][] = [];
    const child = new FakeChild();
    const proc = new AgyStreamProcess({
      sessionId: 's',
      cwd: '/w',
      model: 'gemini-3.6-flash-low',
      conversationId: null,
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
    expect(seen[0]).toContain('--disable-slash-commands');
  });

  it('B1: writes a /-prefixed prompt verbatim as one user event (no local refusal or framing)', async () => {
    const { proc, child } = makeHarness();
    await proc.start();
    child.writeStdout(INIT_LINE);
    const pending = proc.writeTurn('/clear');
    expect(JSON.parse(child.stdinWrites[0])).toEqual({ event: 'user', message: { content: '/clear' } });
    child.writeStdout(resultLine('c-abc', 1));
    await expect(pending).resolves.toMatchObject({ status: 'SUCCESS' });
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

  it('delete-path: abort() on an IDLE process (no pending turn) still SIGTERMs the child and makes it unusable', async () => {
    // A keep-warm process owns no in-flight turn, but it DOES own a live agy
    // process. Deleting the session (or stopping the server) must end it now,
    // not wait for the idle stdin-close timer (ANTIGRAVITY_IDLE_TIMEOUT_MS,
    // 30 min by default).
    const { proc, child } = makeHarness({ idleTimeoutMs: 3_600_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const done = proc.writeTurn('one quick turn');
    child.writeStdout(resultLine());
    await done;
    expect(child.signals).toEqual([]);
    proc.abort();
    expect(child.signals).toContain('SIGTERM');
    expect(proc.hasExited).toBe(true);
    await expect(proc.writeTurn('follow-up')).rejects.toThrow(/respawn required/);
  });

  it('delete-path: an idle abort that is never acked ends stdin and escalates to SIGKILL', async () => {
    const { proc, child } = makeHarness({ idleTimeoutMs: 3_600_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const done = proc.writeTurn('one quick turn');
    child.writeStdout(resultLine());
    await done;
    proc.abort();
    expect(child.stdinWrites).toContain('__END__'); // graceful half of the termination
    expect(child.signals).not.toContain('SIGKILL');
    await vi.advanceTimersByTimeAsync(6_000); // past the abort grace window
    expect(child.signals).toContain('SIGKILL');
  });

  it('delete-path: abort() is idempotent — the same child is never SIGTERMed twice', async () => {
    const { proc, child } = makeHarness({ idleTimeoutMs: 3_600_000 });
    await proc.start();
    proc.abort();
    proc.abort();
    expect(child.signals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
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

describe('AgyStreamProcess — a known background task keeps the turn alive (lane B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-arms the stall timer instead of SIGTERMing while the owner tracks a running background task, and kills as before once it is gone', async () => {
    // agy 1.5.14 holds the stream turn open in silence while a native
    // background command runs (probed T1/T2/T3). Silence is not a stall while
    // the service still tracks that task, so the stall clock re-arms — and the
    // turn is cut as a stall the moment the work is no longer tracked.
    const { proc, child } = makeHarness({
      timeoutMs: 10_000_000,
      stallTimeoutMs: 10_000,
      hasPendingBackgroundWork: () => pending,
    });
    let pending = true;
    await proc.start();
    child.writeStdout(INIT_LINE);
    const turn = proc.writeTurn('run the long command');

    // Ten consecutive stall windows, none of which may kill the turn.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(child.signals).not.toContain('SIGTERM');
      expect(proc.hasExited).toBe(false);
    }

    // The task finished: the next silent window is a real stall again.
    pending = false;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(child.signals).toContain('SIGTERM');
    expect((await turn).reason).toBe('stall');
  });

  it('the hard turn ceiling still fires while a background task is tracked', async () => {
    // The agy hard turn timer (ANTIGRAVITY_PROMPT_TIMEOUT_MS, 60 min in
    // production) is a runaway backstop, never a work limit: pending background
    // work defers the STALL clock only.
    const { proc, child } = makeHarness({
      timeoutMs: 15_000,
      stallTimeoutMs: 10_000,
      hasPendingBackgroundWork: () => true,
    });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const turn = proc.writeTurn('background command, then silence');

    await vi.advanceTimersByTimeAsync(10_001); // stall window: deferred
    expect(child.signals).not.toContain('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000); // hard ceiling reached
    expect(child.signals).toContain('SIGTERM');
    expect((await turn).reason).toBe('timeout');
  });

  it('a predicate that answers false changes nothing: the stall kills the turn as today', async () => {
    const { proc, child } = makeHarness({
      timeoutMs: 10_000_000,
      stallTimeoutMs: 10_000,
      hasPendingBackgroundWork: () => false,
    });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const turn = proc.writeTurn('genuinely stalled turn');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(child.signals).toContain('SIGTERM');
    expect((await turn).reason).toBe('stall');
  });

  it('a throwing predicate cannot save a stalled turn (the stall path stays intact)', async () => {
    const { proc, child } = makeHarness({
      timeoutMs: 10_000_000,
      stallTimeoutMs: 10_000,
      hasPendingBackgroundWork: () => {
        throw new Error('service lookup failed');
      },
    });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const turn = proc.writeTurn('stalled turn');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(child.signals).toContain('SIGTERM');
    expect((await turn).reason).toBe('stall');
  });

  it('an idle process (no pending turn) never consults the predicate or kills anything', async () => {
    const asked = vi.fn(() => true);
    const { proc, child } = makeHarness({ idleTimeoutMs: 2_000, hasPendingBackgroundWork: asked });
    await proc.start();
    child.writeStdout(INIT_LINE);
    const done = proc.writeTurn('quick');
    child.writeStdout(resultLine());
    await done;
    await vi.advanceTimersByTimeAsync(2_001);
    expect(asked).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
  });
});

/**
 * Lane B2 (2026-11-22): agy 1.5.14's REAL wire, captured with the same argv the
 * service uses (`/root/orch-ops/agy-post-turn-20261122/laneB2/raw-wire-agy-1.5.14.jsonl`)
 * for a 20-second `run_command`. It no longer prints "Tool is running as a
 * background task …": the command is a single `tool` step that goes ACTIVE (no
 * output), stays ACTIVE for the whole run, then DONE with the output. Nothing is
 * stripped from the capture.
 */
const RAW_WIRE_1_5_14 = readFileSync(
  fileURLToPath(new URL('./fixtures/raw-wire-agy-1.5.14.jsonl', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim().length > 0);

describe('AgyStreamProcess — a tool step in flight is known pending work (lane B2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const lineIndex = (predicate: (parsed: Record<string, unknown>) => boolean): number => {
    const idx = RAW_WIRE_1_5_14.findIndex((line) => predicate(JSON.parse(line) as Record<string, unknown>));
    if (idx < 0) throw new Error('fixture shape changed: expected line not found');
    return idx;
  };

  it('the captured 1.5.14 wire: false before the tool, true while its step is ACTIVE, false after DONE and after result', async () => {
    // The real capture, one captured line at a time, through the real reader.
    // Production shape: a tool's silence gets the long tool-stall window
    // (ANTIGRAVITY_TOOL_STALL_TIMEOUT_MS, 30 min), so the stream's own clock is
    // deliberately NOT what this test exercises.
    const { proc, child } = makeHarness({ timeoutMs: 10_000_000, stallTimeoutMs: 10_000, toolStallTimeoutMs: 100_000 });
    await proc.start();
    const turn = proc.writeTurn('sleep 20 && date -u');

    const activeToolAt = lineIndex((e) => {
      const step = e.step_update as { state?: string; step_type?: string } | undefined;
      return e.event === 'step_update' && step?.step_type === 'tool' && step.state === 'ACTIVE';
    });
    const doneToolAt = lineIndex((e) => {
      const step = e.step_update as { state?: string; step_type?: string } | undefined;
      return e.event === 'step_update' && step?.step_type === 'tool' && step.state === 'DONE';
    });
    const resultAt = lineIndex((e) => e.event === 'result');
    expect(activeToolAt).toBeLessThan(doneToolAt);
    expect(doneToolAt).toBeLessThan(resultAt);

    // Before the run_command step: nothing in flight.
    for (const line of RAW_WIRE_1_5_14.slice(0, activeToolAt)) child.writeStdout(line);
    expect(proc.hasToolInFlight()).toBe(false);

    // The command is running: the step is ACTIVE and silent for its whole run.
    child.writeStdout(RAW_WIRE_1_5_14[activeToolAt]);
    expect(proc.hasToolInFlight()).toBe(true);

    // Still true while the silence continues (the live failure shape: 33 min of it).
    await vi.advanceTimersByTimeAsync(10_001);
    expect(proc.hasToolInFlight()).toBe(true);
    expect(child.signals).not.toContain('SIGTERM');

    // DONE carries the output: the tool is no longer in flight.
    for (const line of RAW_WIRE_1_5_14.slice(activeToolAt + 1, resultAt)) child.writeStdout(line);
    expect(proc.hasToolInFlight()).toBe(false);

    // The closing result ends the turn: still nothing in flight.
    child.writeStdout(RAW_WIRE_1_5_14[resultAt]);
    await turn;
    expect(proc.hasToolInFlight()).toBe(false);
  });

  it('is false with no pending turn and after the process has exited (a parked process owns no in-flight work)', async () => {
    const { proc, child } = makeHarness({ timeoutMs: 10_000_000, stallTimeoutMs: 10_000 });
    await proc.start();
    child.writeStdout(INIT_LINE);
    expect(proc.hasToolInFlight()).toBe(false);

    const done = proc.writeTurn('run a tool');
    child.writeStdout('{"event":"step_update","step_update":{"conversation_id":"c-abc","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}');
    expect(proc.hasToolInFlight()).toBe(true);

    child.close(0);
    await done;
    expect(proc.hasExited).toBe(true);
    expect(proc.hasToolInFlight()).toBe(false);
  });
});

describe('AgyStreamProcess parser contract', () => {
  it('parseAgyLine discriminates the wire fixture (shared contract)', () => {
    expect(parseAgyLine(resultLine()).kind).toBe('result');
  });
});
