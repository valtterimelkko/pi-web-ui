import type { OpenCodeMessage } from './opencode-types.js';

export function opencodeMessagesToReplayEvents(
  messages: OpenCodeMessage[],
  piSessionId: string,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const info = message.info;
    const timestamp = info.time.created ?? Date.now();
    const msgId = info.id;

    if (info.role === 'user') {
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
    } else if (info.role === 'assistant') {
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
        } else if (part.type === 'tool-invocation' || part.type === 'tool') {
          const toolCallId = part.toolInvocationId ?? part.callID ?? `tool_${timestamp}_${events.length}`;
          const toolName = part.toolName ?? part.tool ?? 'unknown';
          const args = part.args ?? part.state?.input ?? {};
          const status = part.state?.status;

          events.push({
            type: 'tool_execution_start',
            toolCallId,
            toolName,
            args,
            timestamp,
          });

          const messageError = info.error?.data?.message ?? info.error?.name;
          const hasResult = part.result !== undefined
            || status === 'completed'
            || status === 'error'
            || (status === 'running' && messageError !== undefined && info.time.completed !== undefined);
          if (hasResult) {
            const output = part.result ?? part.state?.output ?? part.state?.error ?? messageError ?? '';
            const resultText = typeof output === 'string'
              ? output
              : JSON.stringify(output);
            events.push({
              type: 'tool_execution_end',
              toolCallId,
              result: { content: [{ type: 'text', text: resultText }] },
              isError: status === 'error' || (status === 'running' && messageError !== undefined),
              timestamp,
            });
          }
        }
      }
    }
  }

  return events;
}
