import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';

/**
 * Screen-view / replay projection parity for Antigravity tool args (plan
 * docs/plans/ANTIGRAVITY-BACKGROUND-TASKS-AND-ARCHIVE-ROBUSTNESS-PLAN.md
 * Phase 2):
 *
 * 1. Error-path turns previously DROPPED tool args in finalizeStreamError, so
 *    a failed turn's replay showed an EMPTY `run_command` card (no command).
 * 2. Replay `tool_execution_end` events previously carried no args (the live
 *    normalizer re-surfaces them; replay must match).
 * 3. agy sometimes ships arg values wrapped in literal quotes (native
 *    PLANNER_RESPONSE dumps); toolPrimaryArg must strip the wrapping so the
 *    screen view shows `run_command: python3 ...` rather than `"python3 ...`.
 */

const ctrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-args-store-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = { sessionDir, registryPath: `${sessionDir}/registry.json`, scripted: '' };
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  return state;
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';
import { AntigravitySessionStore } from '../../../src/antigravity/antigravity-session-store.js';
import { turnsToReplayEvents } from '../../../src/antigravity/antigravity-history-replay.js';
import { projectDefaultViewFromEvents, renderScreenViewMarkdown, toolPrimaryArg } from '@pi-web-ui/shared';
import type { NormalizedEvent } from '@pi-web-ui/shared';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

const CONV = 'c-args-1';
const INIT = JSON.stringify({
  event: 'init',
  conversation_id: CONV,
  init: { cwd: '/w', tools: ['run_command'], permission_mode: 'always-proceed', model: 'gemini-3.6-flash-medium' },
});

function toolStep(name: string, phase: 'ACTIVE' | 'DONE', index: number, info?: Record<string, unknown>): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONV, step_index: index, state: phase, step_type: 'tool',
      tool_name: name,
      ...(info ? { tool_info: { name, ...info } } : {}),
    },
  });
}

function errorResult(): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: CONV, status: 'ERROR', response: '', error: 'boom mid-turn',
      duration_seconds: 1, num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10 },
    },
  });
}

const ERROR_SCRIPT = [
  INIT,
  toolStep('run_command', 'ACTIVE', 2),
  toolStep('run_command', 'DONE', 2, { parameters: { CommandLine: 'python3 verify_e2e.py' }, output: 'partial output' }),
  errorResult(),
].join('\n') + '\n';

function fakeSpawnChild(scripted: string) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroyed: boolean; end: () => void };
  stdin.destroyed = false;
  stdin.end = () => {};
  stdin.write = () => {
    if (stdout.listenerCount('data') > 0) stdout.emit('data', Buffer.from(scripted));
    return true;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: () => void }).kill = vi.fn();
  return child;
}

async function runErrorTurn(): Promise<{ events: NormalizedEvent[]; sessionId: string }> {
  const child = fakeSpawnChild(ERROR_SCRIPT);
  const service = new AntigravityService({
    registryPath: ctrl.registryPath,
    streamSpawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
  });
  try {
    const { sessionId } = await service.createSession('/tmp/args-test', 'gemini-3.6-flash-medium');
    const events: NormalizedEvent[] = [];
    await new Promise<void>((resolve) => {
      // An ERROR turn completes with an Error by design (RC2: failure is
      // persisted + surfaced); the test just needs persistence to settle.
      void service.sendPrompt(sessionId, 'run the verification', (e) => events.push(e), () => resolve());
    });
    return { events, sessionId };
  } finally {
    await service.shutdown();
  }
}

describe('antigravity arg projection parity (Phase 2)', () => {
  it('error-path finalization stores tool args so replay shows the command, not an empty card', async () => {
    const { sessionId } = await runErrorTurn();
    const store = new AntigravitySessionStore(ctrl.sessionDir);
    const history = await store.loadHistory(sessionId);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('error');
    expect(history[0].tools).toHaveLength(1);
    const args = (history[0].tools?.[0].args ?? undefined) as { CommandLine?: string } | undefined;
    expect(args?.CommandLine).toBe('python3 verify_e2e.py');
  });

  it('replaying the stored error turn keeps args on BOTH tool_execution events', async () => {
    const { sessionId } = await runErrorTurn();
    const store = new AntigravitySessionStore(ctrl.sessionDir);
    const history = await store.loadHistory(sessionId);
    const events = turnsToReplayEvents(history, sessionId);
    const starts = events.filter((e) => e.type === 'tool_execution_start');
    const ends = events.filter((e) => e.type === 'tool_execution_end');
    for (const e of [...starts, ...ends]) {
      expect((e as Record<string, unknown>).args).toBeDefined();
    }
    expect(((ends[0] as Record<string, unknown>).args as { CommandLine: string }).CommandLine).toBe('python3 verify_e2e.py');
  });

  it('screen view of the replayed error turn renders the command (no empty tool card)', async () => {
    const { sessionId } = await runErrorTurn();
    const store = new AntigravitySessionStore(ctrl.sessionDir);
    const history = await store.loadHistory(sessionId);
    const view = projectDefaultViewFromEvents(turnsToReplayEvents(history, sessionId), { expand: { tools: true } });
    const tools = view.items.filter((i) => i.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(must(tools[0].toolPrimaryArg)).toBe('python3 verify_e2e.py');
    expect(tools[0].text).toBe('run_command: python3 verify_e2e.py');
  });

  it('toolPrimaryArg strips agy wrapping quotes from arg values', () => {
    expect(toolPrimaryArg('run_command', { CommandLine: '"python3 /x/e2e.py"' })).toBe('python3 /x/e2e.py');
    expect(toolPrimaryArg('write_to_file', { TargetFile: '"/tmp/a/b.py"' })).toBe('/tmp/a/b.py');
    // unquoted values pass through untouched
    expect(toolPrimaryArg('run_command', { CommandLine: 'echo hi' })).toBe('echo hi');
  });

  it('quoted native-dump args project cleanly through the full screen view', () => {
    const events = turnsToReplayEvents([{
      turnId: 't-quoted',
      prompt: 'p',
      response: 'r',
      model: 'm',
      conversationId: CONV,
      timestamp: 1000,
      status: 'done',
      tools: [{ toolName: 'run_command', args: { CommandLine: '"python3 script.py"' }, output: 'ok', isError: false }],
    }], 'sess');
    const view = projectDefaultViewFromEvents(events, { expand: { tools: true } });
    const tool = must(view.items.find((i) => i.kind === 'tool'));
    expect(tool.text).toBe('run_command: python3 script.py');
    const md = renderScreenViewMarkdown(view);
    expect(md).toContain('run_command: python3 script.py');
    expect(md).not.toContain('"python3');
  });
});

afterAll(() => {
  try {
    rmSync(ctrl.sessionDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});
