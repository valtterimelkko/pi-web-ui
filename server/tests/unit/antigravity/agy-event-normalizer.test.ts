import { describe, it, expect } from 'vitest';
import { AgyEventNormalizer } from '../../../src/antigravity/agy-event-normalizer.js';

/** Non-null access that throws instead of using lint-banned `!`. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

import { parseAgyLine } from '../../../src/antigravity/agy-event-types.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

const SID = 'agy-session-1';
const T = 1_700_000_000_000;

function feed(n: AgyEventNormalizer, lines: string[]): NormalizedEvent[] {
  return lines.flatMap((l) => n.onParsed(parseAgyLine(l), T));
}

const INIT =
  '{"event":"init","conversation_id":"c-1111","init":{"cwd":"/w","tools":["a","b","run_command"],"permission_mode":"always-proceed","model":"gemini-3.6-flash-low"}}';

function delta(text: string, state: 'ACTIVE' | 'DONE' = 'ACTIVE', index = 2): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'c-1111', step_index: index, state, step_type: 'agent_response', text_delta: text },
  });
}

function resultLine(overrides: Record<string, unknown> = {}, conv = 'c-1111'): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: conv,
      status: 'SUCCESS',
      response: 'hello world\n',
      duration_seconds: 1.5,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 0, total_tokens: 110 },
      ...overrides,
    },
  });
}

describe('AgyEventNormalizer', () => {
  it('T1.1 (adapted for persistent process): init is metadata-only — no user-facing event, conversation id + model recorded', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT]);
    expect(events).toEqual([]);
    expect(n.state.conversationId).toBe('c-1111');
    expect(n.state.initModel).toBe('gemini-3.6-flash-low');
    expect(n.state.permissionMode).toBe('always-proceed');
  });

  it('T1.2: first text delta opens the assistant message; later deltas update it', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, delta('Hello'), delta(' world'), delta('\n', 'DONE')]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['message_start', 'message_update', 'message_update', 'message_update']);
    const start = events[0].data as { id: string; role: string };
    expect(start.role).toBe('assistant');
    for (const e of events.slice(1)) {
      const d = e.data as { id: string; assistantMessageEvent: { type: string; delta: string } };
      expect(d.id).toBe(start.id);
      expect(d.assistantMessageEvent.type).toBe('text_delta');
    }
    expect((events[1].data as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta).toBe('Hello');
  });

  it('T1.2: agent_response DONE without text_delta emits nothing (reasoning-only step)', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const before = feed(n, [INIT]);
    const reasoningOnly = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'c-1111', step_index: 4, state: 'DONE', step_type: 'agent_response',
        duration_seconds: 2.1,
        usage: { input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 0, total_tokens: 3 },
      },
    });
    const events = feed(n, [reasoningOnly]);
    expect(before).toEqual([]);
    expect(events).toEqual([]);
    expect(n.state.assistantMessageOpen).toBe(false);
  });

  it('T1.3: tool ACTIVE emits tool_execution_start; DONE emits tool_execution_end', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const toolActive = JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'c-1111', step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' },
    });
    const toolDone = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'c-1111', step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
        duration_seconds: 0.07,
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\r\n' },
      },
    });
    const events = feed(n, [INIT, toolActive, toolDone]);
    expect(events.map((e) => e.type)).toEqual(['tool_execution_start', 'tool_execution_end']);
    const start = events[0].data as { toolCallId: string; toolName: string };
    expect(start.toolName).toBe('run_command');
    const end = events[1].data as { toolCallId: string; result: unknown; isError: boolean };
    expect(end.toolCallId).toBe(start.toolCallId);
    expect(end.isError).toBe(false);
    expect(n.state.turnTools).toHaveLength(1);
    expect(n.state.turnTools[0].output).toContain('hi');
  });

  it('T1.3: tool error surfaces isError=true and the error message', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const toolDone = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'c-1111', step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: {}, error: { type: 'exit', message: 'exited 1' } },
      },
    });
    const events = feed(n, [INIT, toolDone]);
    // orphan DONE (no ACTIVE seen) emits start+end; the end carries the verdict
    const end = events[events.length - 1].data as { isError: boolean; result: unknown };
    expect(end.isError).toBe(true);
    expect(n.state.turnTools[0].isError).toBe(true);
  });

  it('T1.3: text interleaved with tools continues the SAME assistant message', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const toolStep = JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'c-1111', step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file' } },
    });
    const events = feed(n, [INIT, delta('before '), toolStep, delta('after')]);
    const starts = events.filter((e) => e.type === 'message_start');
    expect(starts).toHaveLength(1);
    const updates = events.filter((e) => e.type === 'message_update');
    expect((updates[updates.length - 1].data as { id: string }).id).toBe(
      (starts[0].data as { id: string }).id,
    );
  });

  it('T1.4: user_input / system_message / unknown / checkpoint steps emit only stream_activity', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const mk = (step_type: string, index: number) =>
      JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c-1111', step_index: index, state: 'DONE', step_type } });
    const events = feed(n, [INIT, mk('user_input', 0), mk('unknown', 1), mk('system_message', 3), mk('checkpoint', 7)]);
    expect(events.map((e) => e.type)).toEqual(['stream_activity', 'stream_activity', 'stream_activity', 'stream_activity']);
    const sa = events[0].data as { stepType: string; stepIndex: number };
    expect(sa.stepType).toBe('user_input');
    expect(sa.stepIndex).toBe(0);
  });

  it('T1.5: SUCCESS result closes the message and emits agent_end with mapped usage', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, delta('hello world\n'), resultLine()]);
    const types = events.map((e) => e.type);
    expect(types[types.length - 2]).toBe('message_end');
    const agentEnd = events[events.length - 1];
    expect(agentEnd.type).toBe('agent_end');
    const data = agentEnd.data as { result: null; usage: Record<string, number>; agyStatus: string };
    expect(data.result).toBe(null);
    expect(data.agyStatus).toBe('SUCCESS');
    expect(data.usage).toEqual({ input: 100, output: 10, thinking: 4, cacheRead: 0, total: 110 });
    expect(n.state.assistantMessageOpen).toBe(false);
  });

  it('T1.5: ERROR result emits agent_end carrying agyStatus + error (body synthesis stays in the service)', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, resultLine({ status: 'ERROR', response: '', error: 'boom', usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } })]);
    const agentEnd = events[events.length - 1];
    expect(agentEnd.type).toBe('agent_end');
    const data = agentEnd.data as { agyStatus: string; error?: string };
    expect(data.agyStatus).toBe('ERROR');
    expect(data.error).toBe('boom');
    // no assistant message was opened for an empty error turn
    expect(events.filter((e) => e.type === 'message_start')).toHaveLength(0);
  });

  it('T1.5: WAITING result maps defensively to agent_end with waiting flag', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, resultLine({ status: 'WAITING', response: '' })]);
    const data = events[events.length - 1].data as { agyStatus: string; waiting?: boolean };
    expect(data.agyStatus).toBe('WAITING');
    expect(data.waiting).toBe(true);
  });

  it('T1.6: after a result, the next turn opens a NEW assistant message id', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    feed(n, [INIT, delta('turn one '), resultLine({ num_turns: 1 }, 'c-1111')]);
    const secondTurn = feed(n, [delta('turn two', 'ACTIVE', 16), resultLine({ response: 'turn two', num_turns: 2 })]);
    const starts = secondTurn.filter((e) => e.type === 'message_start');
    expect(starts).toHaveLength(1);
    const events = n.onParsed(parseAgyLine(delta('x')), T); // sanity: still alive
    expect(Array.isArray(events)).toBe(true);
  });

  it('T1.7: conversation-id mismatch (result id ≠ expected) fires the callback and records the flag', () => {
    let mismatch: { expected: string | null; actual: string; source: string } | null = null;
    const n = new AgyEventNormalizer({
      sessionId: SID,
      expectedConversationId: 'c-expected',
      onConversationIdMismatch: (info) => { mismatch = info; },
    });
    feed(n, [resultLine({}, 'c-actual')]);
    expect(mismatch).not.toBeNull();
    expect(must(mismatch).expected).toBe('c-expected');
    expect(must(mismatch).actual).toBe('c-actual');
    expect(must(mismatch).source).toBe('result');
    expect(n.state.conversationId).toBe('c-actual');
  });

  it('T1.7: matching conversation id does not fire the callback', () => {
    let fired = 0;
    const n = new AgyEventNormalizer({
      sessionId: SID,
      expectedConversationId: 'c-1111',
      onConversationIdMismatch: () => { fired++; },
    });
    feed(n, [INIT, resultLine()]);
    expect(fired).toBe(0);
  });

  it('T1.8: streaming invariant — concatenated deltas equal result.response', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const chunks = ['Tide pools form ', 'along rugged ', 'coastlines.'];
    const lines = [INIT, ...chunks.map((c, i) => delta(c, i < chunks.length - 1 ? 'ACTIVE' : 'DONE', 84))];
    lines.push(resultLine({ response: chunks.join('') }));
    feed(n, lines);
    expect(n.lastTurn?.text).toBe(chunks.join(''));
    expect(n.lastResult?.response).toBe(chunks.join(''));
    expect(n.lastTurn?.tools).toEqual([]);
  });

  it('step_index never resets: normaliser does not key anything on index 0', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    feed(n, [INIT, delta('a', 'ACTIVE', 2), resultLine()]);
    const second = feed(n, [delta('b', 'ACTIVE', 30), resultLine({ response: 'b', num_turns: 2 })]);
    expect(second.filter((e) => e.type === 'message_start')).toHaveLength(1);
  });
});
