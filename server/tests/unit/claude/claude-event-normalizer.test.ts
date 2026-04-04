import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ClaudeEventNormalizer } from '../../../src/claude/claude-event-normalizer.js';

// Load fixture files — server/tests/unit/claude/ → server/ → root → fixtures/
const repoRoot = join(process.cwd(), '..');
const fixtureWithTool = readFileSync(
  join(repoRoot, 'fixtures/claude-stream-json-with-tool.jsonl'),
  'utf-8',
);
const fixtureTextOnly = readFileSync(
  join(repoRoot, 'fixtures/claude-stream-json-text-only.jsonl'),
  'utf-8',
);

describe('ClaudeEventNormalizer', () => {
  let normalizer: ClaudeEventNormalizer;
  const SESSION_ID = 'test-session-123';

  beforeEach(() => {
    normalizer = new ClaudeEventNormalizer();
  });

  // ─── system event ──────────────────────────────────────────────────────────

  it('system/init event → produces session_init NormalizedEvent', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/tmp',
      model: 'claude-opus-4',
      session_id: 'abc-123',
      tools: ['Read', 'Write'],
      permissionMode: 'acceptEdits',
    });

    const events = normalizer.normalize(line, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_init');
    expect(events[0].sessionId).toBe(SESSION_ID);
    expect(events[0].data).toMatchObject({
      model: 'claude-opus-4',
      cwd: '/tmp',
      sessionId: 'abc-123',
    });
  });

  // ─── assistant event with tool_use ────────────────────────────────────────

  it('assistant event with tool_use → produces tool_execution_start', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_001',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Read',
            input: { file_path: '/tmp/test.txt' },
          },
        ],
      },
    });

    const events = normalizer.normalize(line, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
    expect((events[0].data as Record<string, unknown>).toolCallId).toBe('toolu_001');
    expect((events[0].data as Record<string, unknown>).toolName).toBe('Read');
    expect((events[0].data as Record<string, unknown>).args).toEqual({
      file_path: '/tmp/test.txt',
    });
  });

  // ─── user event with tool_result ─────────────────────────────────────────

  it('user event with tool_result → produces tool_execution_end', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_001',
            content: 'file contents here',
            is_error: false,
          },
        ],
      },
    });

    const events = normalizer.normalize(line, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    expect((events[0].data as Record<string, unknown>).toolCallId).toBe('toolu_001');
    expect((events[0].data as Record<string, unknown>).isError).toBe(false);
    const result = (events[0].data as Record<string, unknown>).result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('file contents here');
  });

  // ─── assistant event with text ────────────────────────────────────────────

  it('assistant event with text → produces message_start, message_update, message_end', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_002',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Hello, world!',
          },
        ],
      },
    });

    const events = normalizer.normalize(line, SESSION_ID);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_update');
    expect(events[2].type).toBe('message_end');

    // Check text delta
    const updateData = events[1].data as Record<string, unknown>;
    const assistantEvent = updateData.assistantMessageEvent as {
      type: string;
      delta: string;
    };
    expect(assistantEvent.delta).toBe('Hello, world!');
  });

  // ─── rate_limit_event ────────────────────────────────────────────────────

  it('rate_limit_event → produces rate_limit NormalizedEvent', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        resetsAt: 1000000,
        overageResetsAt: 2000000,
      },
    });

    const events = normalizer.normalize(line, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('rate_limit');
    expect((events[0].data as Record<string, unknown>).status).toBe('allowed');
    expect((events[0].data as Record<string, unknown>).rateLimitType).toBe('five_hour');
    expect((events[0].data as Record<string, unknown>).isUsingOverage).toBe(false);
  });

  // ─── result event ─────────────────────────────────────────────────────────

  it('result event → produces claude_result NormalizedEvent (agent_end emitted by process pool on exit)', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'All done!',
      is_error: false,
      total_cost_usd: 0.05,
      session_id: 'sess-abc',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const events = normalizer.normalize(line, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('claude_result');
    const data = events[0].data as Record<string, unknown>;
    expect(data.result).toBe('All done!');
    expect(data.isError).toBe(false);
    expect(data.totalCostUsd).toBe(0.05);
  });

  // ─── Invalid JSON line ───────────────────────────────────────────────────

  it('invalid JSON line → returns empty array (no crash)', () => {
    const events = normalizer.normalize('NOT JSON AT ALL {{{', SESSION_ID);
    expect(events).toEqual([]);
  });

  it('empty line → returns empty array', () => {
    const events = normalizer.normalize('   ', SESSION_ID);
    expect(events).toEqual([]);
  });

  // ─── isUsingOverage warning ───────────────────────────────────────────────

  it('isUsingOverage: true → warns to console', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        isUsingOverage: true,
        resetsAt: 1000000,
        overageResetsAt: 2000000,
      },
    });

    normalizer.normalize(line, SESSION_ID);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('overage'));

    warnSpy.mockRestore();
  });

  // ─── Full fixture (with-tool) ─────────────────────────────────────────────

  it('full fixture (with-tool) processes all lines and produces correct sequence', () => {
    const lines = fixtureWithTool.split('\n').filter((l) => l.trim());
    const allEvents = lines.flatMap((line) => normalizer.normalize(line, SESSION_ID));

    // Should have events from each line
    const types = allEvents.map((e) => e.type);

    // system → session_init
    expect(types).toContain('session_init');
    // assistant with tool_use → tool_execution_start
    expect(types).toContain('tool_execution_start');
    // rate_limit_event → rate_limit
    expect(types).toContain('rate_limit');
    // user with tool_result → tool_execution_end
    expect(types).toContain('tool_execution_end');
    // assistant with text → message_start, message_update, message_end
    expect(types).toContain('message_start');
    expect(types).toContain('message_update');
    expect(types).toContain('message_end');
    // result → claude_result (agent_end comes from process pool on exit)
    expect(types).toContain('claude_result');
    expect(types).not.toContain('agent_end');

    // session_init should come first
    expect(types[0]).toBe('session_init');
    // claude_result should be last from the normalizer
    expect(types[types.length - 1]).toBe('claude_result');
  });

  it('full fixture (text-only) produces session_init then text events then claude_result', () => {
    const lines = fixtureTextOnly.split('\n').filter((l) => l.trim());
    const allEvents = lines.flatMap((line) => normalizer.normalize(line, SESSION_ID));

    const types = allEvents.map((e) => e.type);
    expect(types[0]).toBe('session_init');
    expect(types).toContain('message_start');
    expect(types).toContain('message_update');
    expect(types).toContain('message_end');
    // agent_end is now emitted by the process pool on subprocess exit, not by normalizer
    expect(types[types.length - 1]).toBe('claude_result');
    // No tool events in text-only fixture
    expect(types).not.toContain('tool_execution_start');
    expect(types).not.toContain('tool_execution_end');
  });
});
