import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { OpenCodeSSEEvent, OpenCodeMessage } from './opencode-types.js';

export class OpenCodeEventAdapter {
  private currentMessageIdBySession: Map<string, string> = new Map();

  adaptSSEEvent(event: OpenCodeSSEEvent, sessionId: string): NormalizedEvent[] {
    const timestamp = Date.now();
    const type = event.type;

    switch (type) {
      case 'message:create':
      case 'message:update': {
        const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
        const role = props?.role as string | undefined;
        const messageId = props?.id as string | undefined;
        const text = props?.text as string | undefined;

        if (!messageId) return [];

        if (role === 'assistant' && type === 'message:create') {
          this.currentMessageIdBySession.set(sessionId, messageId);
          return [{
            type: 'message_start',
            sessionId,
            timestamp,
            data: { id: messageId, role: 'assistant' },
          }];
        }

        if (role === 'assistant' && type === 'message:update' && text) {
          return [{
            type: 'message_update',
            sessionId,
            timestamp,
            data: {
              id: messageId,
              assistantMessageEvent: { type: 'text_delta', delta: text },
            },
          }];
        }

        return [];
      }

      case 'message:complete': {
        const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
        const messageId = props?.id as string | undefined;
        if (messageId) {
          return [{
            type: 'message_end',
            sessionId,
            timestamp,
            data: { id: messageId },
          }];
        }
        return [];
      }

      case 'tool:call': {
        const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
        return [{
          type: 'tool_execution_start',
          sessionId,
          timestamp,
          data: {
            toolCallId: props?.id as string ?? `tool_${timestamp}`,
            toolName: props?.name as string ?? 'unknown',
            args: props?.args,
          },
        }];
      }

      case 'tool:result': {
        const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
        const toolCallId = props?.toolInvocationId as string ?? props?.id as string ?? `tool_${timestamp}`;
        const resultText = typeof props?.result === 'string'
          ? props.result
          : JSON.stringify(props?.result ?? '');
        return [{
          type: 'tool_execution_end',
          sessionId,
          timestamp,
          data: {
            toolCallId,
            result: { content: [{ type: 'text', text: resultText }] },
            isError: props?.isError as boolean ?? false,
          },
        }];
      }

      case 'session:running':
        return [{ type: 'agent_start', sessionId, timestamp, data: {} }];

      case 'session:idle':
        return [{
          type: 'agent_end',
          sessionId,
          timestamp,
          data: { result: null, usage: {} },
        }];

      case 'permission:request': {
        const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
        return [{
          type: 'permission_request' as string,
          sessionId,
          timestamp,
          data: {
            permissionId: props?.id,
            toolName: props?.toolName,
            args: props?.args,
            description: props?.description,
          },
        } as unknown as NormalizedEvent];
      }

      default:
        return [{
          type: 'opencode_raw',
          sessionId,
          timestamp,
          data: event,
        }];
    }
  }

  messageToReplayEvents(message: OpenCodeMessage, piSessionId: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const timestamp = new Date(message.createdAt ?? Date.now()).getTime();
    const msgId = message.id;

    if (message.role === 'user') {
      const text = message.parts
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('');

      events.push(
        { type: 'message_start', sessionId: piSessionId, timestamp, data: { id: msgId, role: 'user' } },
        { type: 'message_update', sessionId: piSessionId, timestamp, data: { id: msgId, assistantMessageEvent: { type: 'text_delta', delta: text } } },
        { type: 'message_end', sessionId: piSessionId, timestamp, data: { id: msgId } },
      );
    } else if (message.role === 'assistant') {
      for (const part of message.parts) {
        if (part.type === 'text' && part.text) {
          const partId = `${msgId}_text`;
          events.push(
            { type: 'message_start', sessionId: piSessionId, timestamp, data: { id: partId, role: 'assistant' } },
            { type: 'message_update', sessionId: piSessionId, timestamp, data: { id: partId, assistantMessageEvent: { type: 'text_delta', delta: part.text } } },
            { type: 'message_end', sessionId: piSessionId, timestamp, data: { id: partId } },
          );
        } else if (part.type === 'tool-invocation' || part.type === 'tool-result') {
          events.push({
            type: 'tool_execution_start',
            sessionId: piSessionId,
            timestamp,
            data: {
              toolCallId: part.toolInvocationId ?? `tool_${timestamp}`,
              toolName: part.toolName ?? 'unknown',
              args: part.args,
            },
          });
          if (part.result !== undefined) {
            const resultText = typeof part.result === 'string'
              ? part.result
              : JSON.stringify(part.result);
            events.push({
              type: 'tool_execution_end',
              sessionId: piSessionId,
              timestamp,
              data: {
                toolCallId: part.toolInvocationId ?? `tool_${timestamp}`,
                result: { content: [{ type: 'text', text: resultText }] },
                isError: false,
              },
            });
          }
        }
      }
    }

    return events;
  }

  reset(): void {
    this.currentMessageIdBySession.clear();
  }
}
