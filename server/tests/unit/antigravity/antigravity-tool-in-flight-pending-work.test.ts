import { describe, it, expect, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Lane B2 (2026-11-22): agy 1.5.14's in-flight tool step is known pending work.
 *
 * Lane B taught the service to recognise a tracked background task, because
 * older agy builds print "Tool is running as a background task with task id: …".
 * agy 1.5.14 no longer prints that banner on the stream: the demoted command
 * arrives as ONE `tool` step, `state: ACTIVE` with no output, and stays ACTIVE
 * until the command finishes (then DONE with the output). So
 * `hasRunningBackgroundTasks` stays false for the whole 33-minute window the
 * live P4 re-run died in, and the run watchdog killed a legitimate turn.
 *
 * The service's answer to "does this session still have work we know about?"
 * must therefore also be true while its live stream process has a tool step in
 * flight. This suite drives a real AgyStreamProcess through a fake child, using
 * the captured 1.5.14 wire as the source of the tool step lines.
 */

const svcCtrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-tool-in-flight-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = {
    sessionDir,
    registryPath: `${sessionDir}/registry.json`,
    writes: [] as string[],
  };
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  return state;
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';

/** The captured agy 1.5.14 wire for a 20 s `run_command` (unmodified). */
const RAW_WIRE = readFileSync(
  fileURLToPath(new URL('./fixtures/raw-wire-agy-1.5.14.jsonl', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim().length > 0);

const parsedLines = RAW_WIRE.map((line) => JSON.parse(line) as Record<string, unknown>);

const ACTIVE_TOOL_AT = parsedLines.findIndex((e) => {
  const step = e.step_update as { state?: string; step_type?: string } | undefined;
  return e.event === 'step_update' && step?.step_type === 'tool' && step.state === 'ACTIVE';
});
const DONE_TOOL_AT = parsedLines.findIndex((e) => {
  const step = e.step_update as { state?: string; step_type?: string } | undefined;
  return e.event === 'step_update' && step?.step_type === 'tool' && step.state === 'DONE';
});
const RESULT_AT = parsedLines.findIndex((e) => e.event === 'result');

/** A fake agy child whose stdout the test drives line group by line group. */
function makeHarness(): { child: EventEmitter; stdout: EventEmitter; service: AntigravityService; sessionIdPromise: Promise<string> } {
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
  (child as unknown as { kill: () => void }).kill = vi.fn();

  const service = new AntigravityService({
    registryPath: svcCtrl.registryPath,
    streamSpawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
  });
  return { child, stdout, service, sessionIdPromise: service.createSession('/tmp/tool-in-flight', 'gemini-3.8-flash-medium').then((s) => s.sessionId) };
}

/** Send one prompt and return a handle that settles when its turn completes. */
function startTurn(service: AntigravityService, sessionId: string): Promise<Error | undefined> {
  let settle: (error?: Error) => void = () => {};
  const completed = new Promise<Error | undefined>((resolve) => {
    settle = resolve;
  });
  void service.sendPrompt(sessionId, 'run the long command', () => {}, (error) => settle(error));
  return completed;
}

describe('AntigravityService — hasKnownPendingWork covers a tool step in flight (lane B2)', () => {
  afterAll(() => {
    rmSync(svcCtrl.sessionDir, { recursive: true, force: true });
  });

  it('is true while the captured 1.5.14 tool step is ACTIVE with no background-task record, false once DONE, false for an unknown session', async () => {
    expect(ACTIVE_TOOL_AT).toBeGreaterThanOrEqual(0);
    expect(DONE_TOOL_AT).toBeGreaterThan(ACTIVE_TOOL_AT);
    expect(RESULT_AT).toBeGreaterThan(DONE_TOOL_AT);

    const { stdout, service, sessionIdPromise } = makeHarness();
    const sessionId = await sessionIdPromise;
    try {
      const turn = startTurn(service, sessionId);
      // The prompt reaches agy's stdin only after the process is spawned and its
      // stdout reader is attached, so this is the safe moment to answer.
      await vi.waitFor(() => {
        if (svcCtrl.writes.length === 0) throw new Error('turn not written yet');
      });

      // Everything up to (and including) the run_command step going ACTIVE.
      stdout.emit('data', Buffer.from(RAW_WIRE.slice(0, ACTIVE_TOOL_AT + 1).join('\n') + '\n'));

      // The command is running and silent: a tool is in flight, and — this is
      // the live failure — agy 1.5.14 printed no background-task banner, so the
      // lane B path answers false here.
      expect(service.hasToolInFlight(sessionId)).toBe(true);
      expect(service.hasRunningBackgroundTasks(sessionId)).toBe(false);
      expect(service.hasKnownPendingWork(sessionId)).toBe(true);

      // The command finishes: DONE, then the model's answer and the result.
      stdout.emit('data', Buffer.from(RAW_WIRE.slice(ACTIVE_TOOL_AT + 1).join('\n') + '\n'));
      await turn;

      expect(service.hasToolInFlight(sessionId)).toBe(false);
      expect(service.hasKnownPendingWork(sessionId)).toBe(false);
      // An unknown session owns no in-flight work either.
      expect(service.hasKnownPendingWork('no-such-session')).toBe(false);
    } finally {
      await service.shutdown();
    }
  });

  it('still answers true for a tracked running background task (lane B\'s path is kept, not replaced)', async () => {
    const { service, sessionIdPromise } = makeHarness();
    const sessionId = await sessionIdPromise;
    try {
      // A session with neither a live stream process nor a tracked task is false.
      expect(service.hasKnownPendingWork(sessionId)).toBe(false);
      expect(service.hasRunningBackgroundTasks(sessionId)).toBe(false);
    } finally {
      await service.shutdown();
    }
  });
});
