import { describe, expect, it } from 'vitest';
import { parsePiSessionHistory } from '../../../src/pi/session-history.js';

describe('parsePiSessionHistory', () => {
  it('replays compact subagent and evaluated_subagent cards without exposing their inner transcripts', () => {
    const history = parsePiSessionHistory([
      {
        type: 'message',
        id: 'user-1',
        message: { role: 'user', timestamp: 100, content: [{ type: 'text', text: 'Investigate this.' }] },
      },
      {
        type: 'message',
        id: 'assistant-1',
        message: {
          role: 'assistant',
          timestamp: 200,
          content: [
            { type: 'text', text: 'I will delegate it.' },
            { type: 'toolCall', id: 'sub-call', name: 'subagent', arguments: { agent: 'codescout', task: 'Map the code.' } },
            { type: 'toolCall', id: 'eval-call', name: 'evaluated_subagent', arguments: { run_id: 'sa-1', questions: ['What did you find?'] } },
          ],
        },
      },
      {
        type: 'message',
        id: 'result-1',
        message: {
          role: 'toolResult',
          timestamp: 300,
          toolCallId: 'sub-call',
          toolName: 'subagent',
          content: [{ type: 'text', text: 'This full inner report must not be replayed in the card.' }],
          details: {
            mode: 'single',
            results: [{
              agent: 'codescout',
              task: 'Map the code.',
              model: 'github-copilot/gpt-5.6-mini',
              messages: [{
                role: 'assistant',
                provider: 'github-copilot',
                model: 'gpt-5.6-mini',
                usage: { input: 120, output: 30 },
                content: [{ type: 'toolCall', name: 'read' }],
              }],
            }],
          },
        },
      },
      {
        type: 'message',
        id: 'result-2',
        message: {
          role: 'toolResult',
          timestamp: 400,
          toolCallId: 'eval-call',
          toolName: 'evaluated_subagent',
          content: [{ type: 'text', text: 'This evaluation answer must not be replayed in the card.' }],
          details: { agent: 'codescout', run_id: 'sa-1', usage: { input: 90, output: 10, turns: 2, cost: 0.12 } },
        },
      },
    ]);

    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);

    const subagent = history[2];
    if (!subagent) throw new Error('Expected replayed subagent card');
    expect(subagent).toMatchObject({
      id: 'sub-call',
      role: 'tool',
      toolCall: { id: 'sub-call', name: 'subagent', args: { agent: 'codescout', task: 'Map the code.' } },
      toolResult: {
        output: '',
        isError: false,
        summary: {
          kind: 'subagent',
          agents: [{ agent: 'codescout', model: 'github-copilot/gpt-5.6-mini', toolCalls: 1, turns: 1 }],
        },
      },
    });
    expect(JSON.stringify(subagent)).not.toContain('This full inner report');

    const evaluated = history[3];
    if (!evaluated) throw new Error('Expected replayed evaluated_subagent card');
    expect(evaluated).toMatchObject({
      id: 'eval-call',
      role: 'tool',
      toolCall: { id: 'eval-call', name: 'evaluated_subagent' },
      toolResult: {
        output: '',
        isError: false,
        summary: {
          kind: 'evaluated_subagent',
          agents: [{ agent: 'codescout', turns: 2, inputTokens: 90, outputTokens: 10, costUsd: 0.12 }],
        },
      },
    });
    expect(JSON.stringify(evaluated)).not.toContain('This evaluation answer');
  });

  it('replays an in-flight subagent as a pending card so the live end event can finish it', () => {
    const history = parsePiSessionHistory([{
      type: 'message',
      id: 'assistant-1',
      message: {
        role: 'assistant',
        timestamp: 200,
        content: [{
          type: 'toolCall',
          id: 'in-flight',
          name: 'evaluated_subagent',
          arguments: { run_id: 'sa-1', questions: ['What did you find?'] },
        }],
      },
    }]);

    expect(history).toMatchObject([{
      id: 'assistant-1',
      role: 'assistant',
    }, {
      id: 'in-flight',
      role: 'tool',
      content: [],
      timestamp: 200,
      toolCall: {
        id: 'in-flight',
        name: 'evaluated_subagent',
        args: { run_id: 'sa-1', questions: ['What did you find?'] },
      },
    }]);
    expect(history[1]?.toolResult).toBeUndefined();
  });
});
