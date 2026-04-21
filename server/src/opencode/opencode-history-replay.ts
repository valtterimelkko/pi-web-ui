import type { OpenCodeMessage } from './opencode-types.js';

export function opencodeMessagesToReplayEvents(
  messages: OpenCodeMessage[],
  piSessionId: string,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const timestamp = new Date(message.createdAt ?? Date.now()).getTime();
    const msgId = message.id;

    if (message.role === 'user') {
      const text = message.parts
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('');

      events.push({
        type: 'message_start',
        message: { id: msgId, role: 'user', content: text },
        timestamp,
      });
      events.push({
        type: 'message_end',
        message: { id: msgId },
        timestamp,
      });
    } else if (message.role === 'assistant') {
      for (const part of message.parts) {
        if (part.type === 'text' && part.text) {
          const partId = `${msgId}_text_${events.length}`;
          events.push({
            type: 'message_start',
            message: { id: partId, role: 'assistant' },
            timestamp,
          });
          events.push({
            type: 'message_update',
            message: { id: partId },
            assistantMessageEvent: { type: 'text_delta', delta: part.text },
            timestamp,
          });
          events.push({
            type: 'message_end',
            message: { id: partId },
            timestamp,
          });
        } else if (part.type === 'tool-invocation') {
          const toolCallId = part.toolInvocationId ?? `tool_${timestamp}_${events.length}`;
          events.push({
            type: 'tool_execution_start',
            toolCallId,
            toolName: part.toolName ?? 'unknown',
            args: part.args ?? {},
            timestamp,
          });
          if (part.result !== undefined) {
            const resultText = typeof part.result === 'string'
              ? part.result
              : JSON.stringify(part.result);
            events.push({
              type: 'tool_execution_end',
              toolCallId,
              result: { content: [{ type: 'text', text: resultText }] },
              isError: false,
              timestamp,
            });
          }
        }
      }
    }
  }

  return events;
}
