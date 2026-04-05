import { describe, it, expect } from 'vitest';
import { sessionEventToMessages, normalizeToolName } from '../../../src/lib/messageAdapter.js';
import type { LiveMessage } from '../../../src/hooks/useSessionStream.js';

describe('sessionEventToMessages', () => {
  // ---------------------------------------------------------------------------
  // message_start
  // ---------------------------------------------------------------------------
  describe('message_start', () => {
    it('returns LiveMessage array for user role', () => {
      const result = sessionEventToMessages({
        type: 'message_start',
        message: {
          id: 'msg-1',
          role: 'user',
          content: 'Hello world',
        },
      });

      expect(Array.isArray(result)).toBe(true);
      const messages = result as LiveMessage[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
        isComplete: true,
      });
      expect(messages[0].timestamp).toBeTypeOf('number');
    });

    it('returns LiveMessage with empty content when user content is empty', () => {
      const result = sessionEventToMessages({
        type: 'message_start',
        message: {
          id: 'msg-2',
          role: 'user',
          content: '',
        },
      });

      const messages = result as LiveMessage[];
      expect(messages[0].content).toEqual([]);
    });

    it('returns partial update for assistant role', () => {
      const result = sessionEventToMessages({
        type: 'message_start',
        message: {
          id: 'msg-3',
          role: 'assistant',
        },
      });

      expect(result).not.toBe(null);
      expect(Array.isArray(result)).toBe(false);
      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('msg-3');
      expect(partial.updates).toMatchObject({
        role: 'assistant',
        isComplete: false,
      });
    });

    it('returns null when message is missing', () => {
      const result = sessionEventToMessages({
        type: 'message_start',
      });
      expect(result).toBeNull();
    });

    it('generates id when message.id is missing', () => {
      const result = sessionEventToMessages({
        type: 'message_start',
        message: { role: 'assistant' },
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toMatch(/^msg-\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // message_update
  // ---------------------------------------------------------------------------
  describe('message_update', () => {
    it('returns partial with text content for text_delta', () => {
      const result = sessionEventToMessages({
        type: 'message_update',
        message: { id: 'msg-10' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'Hello',
        },
      });

      expect(result).not.toBe(null);
      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('msg-10');
      expect(partial.updates.content).toEqual([
        { type: 'text', text: 'Hello' },
      ]);
    });

    it('returns partial with thinking content for thinking_delta', () => {
      const result = sessionEventToMessages({
        type: 'message_update',
        message: { id: 'msg-11' },
        assistantMessageEvent: {
          type: 'thinking_delta',
          delta: 'Let me think...',
        },
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.updates.content).toEqual([
        { type: 'thinking', thinking: 'Let me think...' },
      ]);
    });

    it('returns null when assistantMessageEvent is missing', () => {
      const result = sessionEventToMessages({
        type: 'message_update',
        message: { id: 'msg-12' },
      });
      expect(result).toBeNull();
    });

    it('returns null when id cannot be determined', () => {
      const result = sessionEventToMessages({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'text',
        },
      });
      expect(result).toBeNull();
    });

    it('uses messageId as fallback id', () => {
      const result = sessionEventToMessages({
        type: 'message_update',
        messageId: 'fallback-id',
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'test',
        },
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('fallback-id');
    });

    it('returns null for unknown assistant event type', () => {
      const result = sessionEventToMessages({
        type: 'message_update',
        message: { id: 'msg-13' },
        assistantMessageEvent: {
          type: 'something_else',
          delta: 'data',
        },
      });
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // message_end
  // ---------------------------------------------------------------------------
  describe('message_end', () => {
    it('returns partial with isComplete: true', () => {
      const result = sessionEventToMessages({
        type: 'message_end',
        message: { id: 'msg-20' },
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('msg-20');
      expect(partial.updates).toEqual({ isComplete: true });
    });

    it('uses messageId as fallback', () => {
      const result = sessionEventToMessages({
        type: 'message_end',
        messageId: 'msg-21',
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('msg-21');
    });

    it('returns null when id cannot be determined', () => {
      const result = sessionEventToMessages({
        type: 'message_end',
      });
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // tool_execution_start
  // ---------------------------------------------------------------------------
  describe('tool_execution_start', () => {
    it('returns tool LiveMessage', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      });

      expect(Array.isArray(result)).toBe(true);
      const messages = result as LiveMessage[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'tool-tc-1',
        role: 'tool',
        content: [],
        isComplete: false,
        toolCall: {
          id: 'tc-1',
          name: 'read',
          args: { path: '/foo.ts' },
        },
      });
      expect(messages[0].timestamp).toBeTypeOf('number');
    });

    it('uses id as fallback for toolCallId', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        id: 'tc-fallback',
        name: 'bash',
        args: {},
      });

      const messages = result as LiveMessage[];
      expect(messages[0].id).toBe('tool-tc-fallback');
      expect(messages[0].toolCall!.id).toBe('tc-fallback');
    });

    it('normalizes PascalCase tool names (Claude Direct)', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        toolCallId: 'tc-2',
        toolName: 'Read',
        args: {},
      });

      const messages = result as LiveMessage[];
      expect(messages[0].toolCall!.name).toBe('read');
    });

    it('normalizes Bash (Claude Direct) to bash', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        toolCallId: 'tc-3',
        toolName: 'Bash',
        args: {},
      });

      const messages = result as LiveMessage[];
      expect(messages[0].toolCall!.name).toBe('bash');
    });

    it('normalizes Agent (Claude Direct) to subagent', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        toolCallId: 'tc-4',
        toolName: 'Agent',
        args: {},
      });

      const messages = result as LiveMessage[];
      expect(messages[0].toolCall!.name).toBe('subagent');
    });

    it('uses name as fallback for toolName', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        toolCallId: 'tc-5',
        name: 'edit',
        args: {},
      });

      const messages = result as LiveMessage[];
      expect(messages[0].toolCall!.name).toBe('edit');
    });

    it('returns null when toolCallId is missing', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_start',
        toolName: 'read',
        args: {},
      });
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // tool_execution_end
  // ---------------------------------------------------------------------------
  describe('tool_execution_end', () => {
    it('returns partial with toolResult', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_end',
        toolCallId: 'tc-10',
        result: 'file contents here',
        isError: false,
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('tool-tc-10');
      expect(partial.updates).toEqual({
        toolResult: {
          output: 'file contents here',
          isError: false,
        },
        isComplete: true,
      });
    });

    it('handles error results', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_end',
        toolCallId: 'tc-11',
        result: 'command failed',
        isError: true,
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.updates.toolResult!.isError).toBe(true);
    });

    it('defaults output to empty string when result is missing', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_end',
        toolCallId: 'tc-12',
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.updates.toolResult!.output).toBe('');
      expect(partial.updates.toolResult!.isError).toBe(false);
    });

    it('uses id as fallback for toolCallId', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_end',
        id: 'tc-fallback-end',
        result: 'ok',
      });

      const partial = result as { id: string; updates: Partial<LiveMessage> };
      expect(partial.id).toBe('tool-tc-fallback-end');
    });

    it('returns null when toolCallId is missing', () => {
      const result = sessionEventToMessages({
        type: 'tool_execution_end',
        result: 'ok',
      });
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown event types
  // ---------------------------------------------------------------------------
  describe('unknown event types', () => {
    it('returns null for unknown event type', () => {
      const result = sessionEventToMessages({
        type: 'agent_start',
      });
      expect(result).toBeNull();
    });

    it('returns null for agent_end', () => {
      const result = sessionEventToMessages({
        type: 'agent_end',
      });
      expect(result).toBeNull();
    });

    it('returns null for completely unknown type', () => {
      const result = sessionEventToMessages({
        type: 'something_weird',
      });
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeToolName (verify it works as expected for the adapter)
// ---------------------------------------------------------------------------
describe('normalizeToolName', () => {
  it('normalizes Read to read', () => {
    expect(normalizeToolName('Read')).toBe('read');
  });

  it('normalizes Bash to bash', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
  });

  it('normalizes Agent to subagent', () => {
    expect(normalizeToolName('Agent')).toBe('subagent');
  });

  it('passes through already-normalized names', () => {
    expect(normalizeToolName('read')).toBe('read');
    expect(normalizeToolName('bash')).toBe('bash');
    expect(normalizeToolName('subagent')).toBe('subagent');
  });
});
