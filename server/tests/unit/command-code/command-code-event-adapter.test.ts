import { describe, expect, it } from 'vitest';
import { projectDefaultViewFromEvents } from '@pi-web-ui/shared';
import {
  adaptCommandCodeOutput,
  commandCodeEventsToScreenEvents,
  COMMAND_CODE_AGENT_END,
} from '../../../src/command-code/command-code-event-adapter.js';

describe('Command Code event adapter', () => {
  it('normalizes assistant text, thinking, tools, and exactly one terminal event', () => {
    const result = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [
        { event: { type: 'message_update', messageId: 'm1', text: 'hello' }, lineNumber: 1 },
        { event: { type: 'thinking', messageId: 'm1', text: 'plan' }, lineNumber: 2 },
        { event: { type: 'tool_start', toolCallId: 't1', toolName: 'Read', args: { path: 'x' } }, lineNumber: 3 },
        { event: { type: 'tool_result', toolCallId: 't1', result: 'ok' }, lineNumber: 4 },
      ],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: 'hello', usage: { input: 1, output: 2 } },
      unknownEventTypes: [],
      suppressedDuplicateCount: 1,
      bytes: 100,
      lineCount: 5,
    });

    expect(result.events.map((event) => event.type)).toEqual([
      'message_update', 'message_update', 'tool_execution_start', 'tool_execution_end', COMMAND_CODE_AGENT_END,
    ]);
    expect(result.events[0]?.data).toMatchObject({ assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
    expect(result.events[1]?.data).toMatchObject({ assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } });
    expect(result.events[2]?.data).toMatchObject({ toolCallId: 't1', toolName: 'Read' });
    expect(result.events[4]?.data).toMatchObject({
      subtype: 'success',
      stopReason: undefined,
      usage: { input: 1, output: 2 },
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 1, output: 2, total: 3 },
    });
    expect(result.finalText).toBe('hello');
    expect(result.nativeSessionId).toBe('native-1');
  });

  it('preserves provider-reported effort as an explicit normalized event', () => {
    const result = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [{ event: { type: 'model_request_end', effort: 'xhigh', requestId: 'req-1' }, lineNumber: 1 }],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: '' },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 1,
      lineCount: 2,
    });
    expect(result.events.find((event) => event.type === 'model_request_end')?.data).toMatchObject({
      effort: 'xhigh',
    });
  });

  it('normalizes only complete, additive terminal usage and rejects inconsistent totals', () => {
    const valid = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [{ event: { type: 'agent_end', usage: { input: 999, output: 999 } }, lineNumber: 1 }],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: '', usage: { input_tokens: 11, output_tokens: 7, total: 18 } },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 1,
      lineCount: 2,
    });
    expect(valid.events.find((event) => event.type === COMMAND_CODE_AGENT_END)?.data).toMatchObject({
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 11, output: 7, total: 18 },
    });

    const malformed = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: '', usage: { input: 11, output: 7, total: 99 } },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 1,
      lineCount: 1,
    });
    expect(malformed.events.find((event) => event.type === COMMAND_CODE_AGENT_END)?.data).not.toHaveProperty('tokenUsage');
  });

  it('accepts the real CLI numeric-string usage shape and extracts cache tokens', () => {
    // The real cmdc CLI emits usage values as numeric strings
    // (inputTokens: "11"), not JSON numbers.
    const result = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: '', usage: { inputTokens: '11', outputTokens: '7', cacheReadTokens: '5', cacheWriteTokens: '2' } },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 1,
      lineCount: 1,
    });
    expect(result.tokenUsage).toEqual({
      scope: 'run',
      source: 'commandcode-terminal-result-v1',
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
      total: 18,
    });
  });

  it('records terminal effort on the authoritative agent_end', () => {
    const result = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', effort: 'medium', finalText: '' },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 1,
      lineCount: 1,
    });
    expect(result.events.find((event) => event.type === COMMAND_CODE_AGENT_END)?.data).toMatchObject({
      effort: 'medium',
    });
  });

  it('does not synthesize a second agent_end when a runtime event supplied one', () => {
    const result = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      nativeSessionId: 'native-1',
      events: [{ event: { type: 'agent_end', reason: 'done' }, lineNumber: 1 }],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: '' },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 1,
      lineCount: 2,
    });
    expect(result.events.filter((event) => event.type === COMMAND_CODE_AGENT_END)).toHaveLength(1);
  });

  it('preserves message-start content when projecting normalized replay events', () => {
    const normalized = [
      { type: 'message_start', sessionId: 'internal-1', timestamp: 1, data: { id: 'u1', role: 'user', content: 'prompt text' } },
      { type: 'message_end', sessionId: 'internal-1', timestamp: 2, data: { id: 'u1' } },
    ];
    const view = projectDefaultViewFromEvents(commandCodeEventsToScreenEvents(normalized));
    expect(view.items).toMatchObject([{ kind: 'user', text: 'prompt text' }]);
  });

  it('adapts the actual Command Code print stream into replayable message events', () => {
    const result = adaptCommandCodeOutput({
      sessionId: 'internal-1',
      events: [
        { event: { type: 'run_start', sessionId: 'native-1' }, lineNumber: 1 },
        { event: { type: 'message_start' }, lineNumber: 2 },
        { event: { type: 'thinking_start' }, lineNumber: 3 },
        { event: { type: 'thinking_delta', delta: 'plan' }, lineNumber: 4 },
        { event: { type: 'thinking_end', text: 'plan' }, lineNumber: 5 },
        { event: { type: 'text_delta', delta: 'hello' }, lineNumber: 6 },
        { event: { type: 'message_update', content: [{ type: 'text', text: 'hello' }] }, lineNumber: 7 },
        { event: { type: 'message_end' }, lineNumber: 8 },
        { event: { type: 'turn_end', turnNumber: 1 }, lineNumber: 9 },
        { event: { type: 'run_end' }, lineNumber: 10 },
      ],
      terminal: { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: 'hello' },
      unknownEventTypes: [],
      suppressedDuplicateCount: 0,
      bytes: 100,
      lineCount: 11,
    });

    expect(result.events.map((event) => event.type)).toEqual([
      'message_start', 'message_update', 'message_update', 'message_end', COMMAND_CODE_AGENT_END,
    ]);
    const messageStart = result.events[0];
    const textUpdate = result.events[2];
    expect(messageStart?.data).toMatchObject({ id: expect.any(String), role: 'assistant' });
    expect(textUpdate?.data).toMatchObject({
      id: (messageStart?.data as { id: string }).id,
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });

    const view = projectDefaultViewFromEvents(commandCodeEventsToScreenEvents(result.events));
    expect(view.items.map((item) => item.kind)).toEqual(['thinking', 'assistant']);
    expect(view.items[1]?.text).toBe('hello');
  });
});
