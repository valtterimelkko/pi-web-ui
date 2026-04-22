import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { OpenCodeSSEEvent, OpenCodeMessage } from './opencode-types.js';
import { config } from '../config.js';

export class OpenCodeEventAdapter {
  private currentMessageIdBySession: Map<string, string> = new Map();
  private partTypeById: Map<string, string> = new Map();
  private debugRawEvents: boolean;

  constructor(debugRawEvents?: boolean) {
    this.debugRawEvents = debugRawEvents ?? config.opencodeDebugRawEvents;
  }

  adaptSSEEvent(event: OpenCodeSSEEvent, sessionId: string): NormalizedEvent[] {
    const timestamp = Date.now();
    const type = event.type;
    const props = event.properties ?? {};

    switch (type) {
      case 'message.part.delta': {
        const delta = props.delta as string | undefined;
        const messageID = props.messageID as string | undefined;
        const partID = props.partID as string | undefined;
        const field = props.field as string | undefined;
        if (!delta || !messageID || field !== 'text') return [];
        if (partID && this.partTypeById.get(partID) === 'reasoning') return [];

        return [{
          type: 'message_update',
          sessionId,
          timestamp,
          data: {
            id: messageID,
            assistantMessageEvent: { type: 'text_delta', delta },
          },
        }];
      }

      case 'message.updated': {
        const info = props.info as Record<string, unknown> | undefined;
        if (!info) return [];
        const role = info.role as string;
        const messageID = info.id as string;
        const finish = info.finish as string | undefined;

        if (role === 'assistant') {
          if (finish) {
            return [{
              type: 'message_end',
              sessionId,
              timestamp,
              data: { id: messageID },
            }];
          }
          this.currentMessageIdBySession.set(sessionId, messageID);
          return [{
            type: 'message_start',
            sessionId,
            timestamp,
            data: { id: messageID, role: 'assistant' },
          }];
        }
        return [];
      }

      case 'message.part.updated': {
        const part = props.part as Record<string, unknown> | undefined;
        if (!part) return [];
        const partType = part.type as string;
        const partID = part.id as string | undefined;
        if (partID) {
          this.partTypeById.set(partID, partType);
        }

        if (partType === 'step-start' || partType === 'reasoning' || partType === 'text') {
          return [];
        }

        if (partType === 'tool-invocation') {
          const toolCallPartId = part.id as string;
          const toolName = part.toolName as string | undefined ?? 'unknown';
          const args = part.args;
          const toolCallId = (part.toolInvocationId as string | undefined) ?? toolCallPartId;
          return [{
            type: 'tool_execution_start',
            sessionId,
            timestamp,
            data: {
              toolCallId,
              toolName,
              input: args ?? {},
            },
          }];
        }

        if (partType === 'step-finish') {
          const reason = part.reason as string | undefined;
          if (reason === 'tool') {
            const partID = part.id as string;
            const resultText = typeof part.result === 'string'
              ? part.result
              : part.result != null
                ? JSON.stringify(part.result)
                : (part.snapshot as string | undefined) ?? '';
            return [{
              type: 'tool_execution_end',
              sessionId,
              timestamp,
              data: {
                toolCallId: partID,
                result: { content: [{ type: 'text', text: resultText }] },
                isError: false,
              },
            }];
          }
          return [];
        }

        return [];
      }

      case 'session.status': {
        const status = props.status as Record<string, unknown> | undefined;
        const statusType = status?.type as string;

        if (statusType === 'busy') {
          return [{ type: 'agent_start', sessionId, timestamp, data: {} }];
        }
        if (statusType === 'idle') {
          return [{
            type: 'agent_end',
            sessionId,
            timestamp,
            data: { result: null, usage: {} },
          }];
        }
        return [];
      }

      case 'session.idle': {
        return [{
          type: 'agent_end',
          sessionId,
          timestamp,
          data: { result: null, usage: {} },
        }];
      }

      case 'permission.updated': {
        const permission = props.permission as Record<string, unknown> | undefined;
        if (!permission) return [];
        const permId = permission.id as string;
        const metadata = permission.metadata as Record<string, unknown> | undefined;
        const toolName = (metadata?.toolName as string | undefined)
          ?? (permission.tool as string | undefined)
          ?? 'unknown';
        const args = metadata?.input ?? permission.args;
        const status = permission.status as string | undefined;
        if (status === 'pending' || status === undefined) {
          return [{
            type: 'permission_request',
            sessionId,
            timestamp,
            data: {
              permissionId: permId,
              toolName,
              args,
              title: `Allow ${toolName}?`,
              description: `OpenCode wants to run: ${toolName}${args ? '\n' + JSON.stringify(args, null, 2) : ''}`,
            },
          }];
        }
        return [];
      }

      default:
        if (this.debugRawEvents) {
          return [{
            type: 'opencode_raw',
            sessionId,
            timestamp,
            data: event,
          }];
        }
        return [];
    }
  }

  messageToReplayEvents(message: OpenCodeMessage, piSessionId: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const info = message.info;
    const timestamp = info.time.created ?? Date.now();
    const msgId = info.id;

    if (info.role === 'user') {
      const text = (message.parts ?? [])
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('');

      events.push(
        { type: 'message_start', sessionId: piSessionId, timestamp, data: { id: msgId, role: 'user' } },
        { type: 'message_update', sessionId: piSessionId, timestamp, data: { id: msgId, assistantMessageEvent: { type: 'text_delta', delta: text } } },
        { type: 'message_end', sessionId: piSessionId, timestamp, data: { id: msgId } },
      );
    } else if (info.role === 'assistant') {
      for (const part of message.parts ?? []) {
        if (part.type === 'text' && part.text) {
          const partId = part.id ?? `${msgId}_text`;
          events.push(
            { type: 'message_start', sessionId: piSessionId, timestamp, data: { id: partId, role: 'assistant' } },
            { type: 'message_update', sessionId: piSessionId, timestamp, data: { id: partId, assistantMessageEvent: { type: 'text_delta', delta: part.text } } },
            { type: 'message_end', sessionId: piSessionId, timestamp, data: { id: partId } },
          );
        }
      }
    }

    return events;
  }

  reset(): void {
    this.currentMessageIdBySession.clear();
    this.partTypeById.clear();
  }
}
