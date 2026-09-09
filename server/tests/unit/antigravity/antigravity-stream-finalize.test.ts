import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end regression for the live-stream honesty defects found by the
 * 2026-09-09 A/B validation (see
 * docs/plans/ANTIGRAVITY-FRONTEND-PARITY-AND-CONTEXT-HONESTY-PLAN.md §F2/F3):
 *
 * F2 — the final assistant text was delivered TWICE live: the suppress-mode
 *      normalizer cleared its open-message bookkeeping before the service's
 *      finalize checked it, so the service re-emitted the full response under
 *      a fresh id and the streamed message never closed.
 * F3 — tool DONE steps carry `tool_info.parameters`, but the emitted
 *      `tool_execution_end` dropped the args, so live cards never showed them
 *      (replay did). write_to_file ends with EMPTY output — a friendly
 *      synthesized result is required for the card to say anything.
 *
 * The harness drives a real AntigravityService through sendPrompt with a
 * scripted fake agy child (same wire the stub binary speaks).
 */

const ctrl = vi.hoisted(() => {
  const state = {
    sessionDir: '',
    registryPath: '',
    scripted: '',
    writes: [] as string[],
  };
  return state;
});

beforeAll(() => {
  ctrl.sessionDir = mkdtempSync(join(tmpdir(), 'agy-finalize-store-'));
  ctrl.registryPath = join(ctrl.sessionDir, 'registry.json');
  process.env.ANTIGRAVITY_SESSION_DIR = ctrl.sessionDir;
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/** Non-null access that throws instead of using lint-banned `!`. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

const SID_LINE =
  '{"event":"init","conversation_id":"c-final-1","init":{"cwd":"/w","tools":["run_command","write_to_file"],"permission_mode":"always-proceed","model":"gemini-3.6-flash-medium"}}';

function delta(text: string, index: number, state: 'ACTIVE' | 'DONE' = 'ACTIVE'): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'c-final-1', step_index: index, state, step_type: 'agent_response', text_delta: text },
  });
}

function toolStep(name: string, phase: 'ACTIVE' | 'DONE', index: number, info?: Record<string, unknown>): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'c-final-1', step_index: index, state: phase, step_type: 'tool',
      tool_name: name,
      ...(info ? { tool_info: { name, ...info } } : {}),
    },
  });
}

function resultLine(): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-final-1',
      status: 'SUCCESS',
      response: 'Hello final streamed text',
      duration_seconds: 2,
      num_turns: 1,
      usage: { input_tokens: 42445, output_tokens: 2259, thinking_tokens: 1531, cache_read_tokens: 106044, total_tokens: 44704 },
    },
  });
}

/** Scripted scenario matching the live-captured turn: streamed text, a
 *  file write with EMPTY output, a command with parameters+output, final
 *  streamed text, then the result envelope. */
const SCRIPTED = [
  SID_LINE,
  delta('Hello ', 1),
  toolStep('write_to_file', 'ACTIVE', 2),
  toolStep('write_to_file', 'DONE', 2, { parameters: { TargetFile: '/tmp/x/hello.txt' }, output: '' }),
  toolStep('run_command', 'ACTIVE', 3),
  toolStep('run_command', 'DONE', 3, { parameters: { CommandLine: 'python3 -m unittest' }, output: 'OK\n1 test' }),
  delta('final streamed text', 4, 'DONE'),
  resultLine(),
].join('\n') + '\n';

function fakeSpawnChild() {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & {
    write: (s: string) => boolean;
    destroyed: boolean;
  };
  stdin.destroyed = false;
  stdin.write = (s: string) => {
    ctrl.writes.push(s);
    // First turn write triggers the whole scripted stream (immediate, so no
    // watchdog timers fire).
    if (stdout.listenerCount('data') > 0) {
      stdout.emit('data', Buffer.from(ctrl.scripted));
    }
    return true;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: () => void }).kill = vi.fn();
  return child;
}

async function runTurn(): Promise<{ events: NormalizedEvent[]; service: AntigravityService; sessionId: string }> {
  ctrl.writes = [];
  ctrl.scripted = SCRIPTED;
  const child = fakeSpawnChild();
  const service = new AntigravityService({
    registryPath: ctrl.registryPath,
    streamSpawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
  });
  const { sessionId } = await service.createSession('/tmp/finalize-test', 'gemini-3.6-flash-medium');
  const events: NormalizedEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    void service.sendPrompt(sessionId, 'do the scripted turn', (e) => events.push(e), (err) => {
      if (err) reject(err); else resolve();
    });
  });
  return { events, service, sessionId };
}

describe('antigravity stream finalize honesty (F2/F3)', () => {
  it('F2: streamed assistant text is delivered ONCE — closed, never re-emitted', async () => {
    const { events } = await runTurn();
    const assistantStarts = events.filter((e) => {
      const d = e.data as { role?: string } | undefined;
      return e.type === 'message_start' && d?.role === 'assistant';
    });
    // Exactly one streamed assistant message.
    expect(assistantStarts).toHaveLength(1);
    const streamedId = (assistantStarts[0].data as { id: string }).id;

    // Every message_update belongs to EITHER the user prompt or the streamed
    // assistant message — no third id may appear.
    const userStart = events.find((e) => {
      const d = e.data as { role?: string } | undefined;
      return e.type === 'message_start' && d?.role === 'user';
    });
    const userId = (must(userStart).data as { id: string }).id;
    const updates = events.filter((e) => e.type === 'message_update');
    for (const u of updates) {
      expect([streamedId, userId]).toContain((u.data as { id: string }).id);
    }
    const streamedText = updates
      .filter((u) => (u.data as { id: string }).id === streamedId)
      .map((u) => (u.data as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta)
      .join('');
    expect(streamedText).toContain('final streamed text');

    // The streamed message IS closed…
    const ends = events.filter((e) => e.type === 'message_end');
    expect(ends.map((e) => (e.data as { id: string }).id)).toContain(streamedId);
    // …and no SECOND assistant message re-emits the response.
    expect(assistantStarts).toHaveLength(1);
  });

  it('F2: total assistant text (streamed deltas) is not duplicated anywhere in the event stream', async () => {
    const { events } = await runTurn();
    const occurrences = events.filter((e) => {
      if (e.type !== 'message_update') return false;
      const d = e.data as { assistantMessageEvent?: { delta?: string } };
      return d.assistantMessageEvent?.delta?.includes('final streamed text') === true;
    });
    expect(occurrences).toHaveLength(1);
  });

  it('F3: tool_execution_end carries the DONE-step args (live parity with replay)', async () => {
    const { events } = await runTurn();
    const ends = events.filter((e) => e.type === 'tool_execution_end');
    expect(ends).toHaveLength(2);
    const writeEnd = ends.find((e) => (e.data as { toolCallId: string }).toolCallId !== undefined
      && ((e.data as { toolName?: string }).toolName === 'write_to_file' || true));
    void writeEnd;
    const byName = (name: string) => {
      const start = events.find((e) => e.type === 'tool_execution_start' && (e.data as { toolName: string }).toolName === name);
      const id = (must(start).data as { toolCallId: string }).toolCallId;
      return must(ends.find((e) => (e.data as { toolCallId: string }).toolCallId === id));
    };
    expect((byName('write_to_file').data as { args?: { TargetFile?: string } }).args?.TargetFile).toBe('/tmp/x/hello.txt');
    expect((byName('run_command').data as { args?: { CommandLine?: string } }).args?.CommandLine).toBe('python3 -m unittest');
  });

  it('F3: write_to_file with EMPTY agy output gets a synthesized friendly result', async () => {
    const { events } = await runTurn();
    const starts = events.filter((e) => e.type === 'tool_execution_start');
    const writeStart = must(starts.find((e) => (e.data as { toolName: string }).toolName === 'write_to_file'));
    const writeId = (writeStart.data as { toolCallId: string }).toolCallId;
    const writeEnd = must(events.find((e) => e.type === 'tool_execution_end' && (e.data as { toolCallId: string }).toolCallId === writeId));
    const result = (writeEnd.data as { result?: string }).result ?? '';
    expect(result).toContain('/tmp/x/hello.txt');
    expect(result.toLowerCase()).toContain('wrote');
  });

  it('agent_end still carries the mapped real usage', async () => {
    const { events } = await runTurn();
    const agentEnd = must(events.find((e) => e.type === 'agent_end'));
    expect((agentEnd.data as { usage: { input: number; cacheRead: number } }).usage).toEqual({
      input: 42445, output: 2259, thinking: 1531, cacheRead: 106044, total: 44704,
    });
  });
});

afterAll(() => {
  try {
    rmSync(ctrl.sessionDir, { recursive: true, force: true });
  } catch { /* tmp cleanup best-effort */ }
});
