import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeSdkEventAdapter } from '../../../src/claude/claude-sdk-event-adapter.js';

const SESSION_ID = 'sdk-test-session';

describe('ClaudeSdkEventAdapter', () => {
  let adapter: ClaudeSdkEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeSdkEventAdapter();
  });

  // ─── system/init ────────────────────────────────────────────────────────────

  it('system/init → session_init event', () => {
    const events = adapter.adapt(
      {
        type: 'system',
        subtype: 'init',
        model: 'glm-5.2[1m]',
        session_id: 'native-uuid',
        tools: ['Bash', 'Read', 'Write'],
        cwd: '/tmp/test',
        permissionMode: 'dontAsk',
        apiKeySource: 'none',
      },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_init');
    expect((events[0].data as Record<string, unknown>).model).toBe('glm-5.2[1m]');
    expect((events[0].data as Record<string, unknown>).sessionId).toBe('native-uuid');
    expect((events[0].data as Record<string, unknown>).apiKeySource).toBe('none');
  });

  it('system/non-init → raw event', () => {
    const events = adapter.adapt(
      { type: 'system', subtype: 'commands_changed' },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('claude_sdk_raw');
  });

  // ─── assistant text ─────────────────────────────────────────────────────────

  it('assistant text block → message_start + message_update + message_end', () => {
    const events = adapter.adapt(
      {
        type: 'assistant',
        message: {
          id: 'msg_001',
          model: 'glm-5.2',
          content: [{ type: 'text', text: 'Hello world' }],
        },
        session_id: 'native-uuid',
      },
      SESSION_ID,
    );
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_update');
    expect(events[2].type).toBe('message_end');
    const update = events[1].data as { assistantMessageEvent: { delta: string } };
    expect(update.assistantMessageEvent.delta).toBe('Hello world');
  });

  // ─── assistant tool_use ─────────────────────────────────────────────────────

  it('assistant tool_use block → tool_execution_start', () => {
    const events = adapter.adapt(
      {
        type: 'assistant',
        message: {
          id: 'msg_002',
          content: [
            {
              type: 'tool_use',
              id: 'tool_abc',
              name: 'Write',
              input: { file_path: '/tmp/test.txt', content: 'hello' },
            },
          ],
        },
        session_id: 'native-uuid',
      },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
    const data = events[0].data as { toolCallId: string; toolName: string; args: unknown };
    expect(data.toolCallId).toBe('tool_abc');
    expect(data.toolName).toBe('Write');
    expect((data.args as { file_path: string }).file_path).toBe('/tmp/test.txt');
  });

  it('assistant with mixed text + tool_use blocks → all events', () => {
    const events = adapter.adapt(
      {
        type: 'assistant',
        message: {
          id: 'msg_003',
          content: [
            { type: 'text', text: 'I will write a file.' },
            { type: 'tool_use', id: 'tool_def', name: 'Write', input: {} },
          ],
        },
      },
      SESSION_ID,
    );
    // text → 3 events, tool_use → 1 event
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('message_start');
    expect(events[3].type).toBe('tool_execution_start');
  });

  // ─── assistant error ────────────────────────────────────────────────────────

  it('assistant with error → error event', () => {
    const events = adapter.adapt(
      {
        type: 'assistant',
        message: { id: 'msg_err', content: [] },
        error: 'rate_limit',
        session_id: 'x',
      },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0].data as { error: string }).error).toBe('rate_limit');
  });

  // ─── user tool_result ───────────────────────────────────────────────────────

  it('user tool_result block → tool_execution_end', () => {
    const events = adapter.adapt(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_abc',
              content: 'File written successfully',
              is_error: false,
            },
          ],
        },
      },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    const data = events[0].data as { toolCallId: string; result: { content: Array<{ text: string }> }; isError: boolean };
    expect(data.toolCallId).toBe('tool_abc');
    expect(data.result.content[0].text).toBe('File written successfully');
    expect(data.isError).toBe(false);
  });

  it('user tool_result with array content → joined text', () => {
    const events = adapter.adapt(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_xyz',
              content: [
                { type: 'text', text: 'part1' },
                { type: 'text', text: 'part2' },
              ],
            },
          ],
        },
      },
      SESSION_ID,
    );
    const data = events[0].data as { result: { content: Array<{ text: string }> } };
    expect(data.result.content[0].text).toBe('part1part2');
  });

  // ─── result ─────────────────────────────────────────────────────────────────

  it('result → claude_result (NOT agent_end)', () => {
    const events = adapter.adapt(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.05,
        session_id: 'native-uuid',
        num_turns: 1,
        duration_ms: 5000,
      },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('claude_result');
    expect(events[0].type).not.toBe('agent_end');
    const data = events[0].data as { result: string; totalCostUsd: number; usage: Record<string, number> };
    expect(data.result).toBe('Done');
    expect(data.totalCostUsd).toBe(0.05);
    expect(data.usage.input_tokens).toBe(100);
  });

  // ─── unknown message type ───────────────────────────────────────────────────

  it('unknown message type → raw event', () => {
    const events = adapter.adapt(
      { type: 'custom_event', custom: 'data' },
      SESSION_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('claude_sdk_raw');
  });

  // ─── empty content ──────────────────────────────────────────────────────────

  it('assistant with empty content → no events', () => {
    const events = adapter.adapt(
      { type: 'assistant', message: { id: 'msg', content: [] } },
      SESSION_ID,
    );
    expect(events).toHaveLength(0);
  });

  it('user with no content array → no events', () => {
    const events = adapter.adapt(
      { type: 'user', message: { role: 'user' } },
      SESSION_ID,
    );
    expect(events).toHaveLength(0);
  });
});
