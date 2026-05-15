import type { NormalizedEvent } from '@pi-web-ui/shared';

export interface ChannelEvent {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

export class ClaudeChannelEventAdapter {
  normalize(event: ChannelEvent, timestamp?: number): NormalizedEvent[] {
    const ts = timestamp ?? (typeof event.timestamp === 'number' ? event.timestamp : Date.now());

    switch (event.type) {
      case 'session_init':
        return [
          {
            type: 'session_init',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              tools: event.tools,
              model: event.model,
              sessionId: event.claudeSessionId ?? event.sessionId,
              cwd: event.cwd,
              permissionMode: event.permissionMode,
            },
          },
        ];

      case 'agent_start':
        return [
          {
            type: 'agent_start',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              sessionId: event.sessionId,
              claudeSessionId: event.claudeSessionId,
            },
          },
        ];

      case 'message_start': {
        const message = event.message as Record<string, unknown> | undefined;
        return [
          {
            type: 'message_start',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              id: message?.id,
              role: message?.role,
            },
          },
        ];
      }

      case 'message_update': {
        const msg = event.message as Record<string, unknown> | undefined;
        return [
          {
            type: 'message_update',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              id: msg?.id,
              assistantMessageEvent: event.assistantMessageEvent ?? {
                type: 'text_delta',
                delta: event.delta ?? msg?.text,
              },
            },
          },
        ];
      }

      case 'message_end': {
        const msg = event.message as Record<string, unknown> | undefined;
        return [
          {
            type: 'message_end',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              id: msg?.id ?? event.messageId,
            },
          },
        ];
      }

      case 'tool_execution_start':
        return [
          {
            type: 'tool_execution_start',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            },
          },
        ];

      case 'tool_execution_end':
        return [
          {
            type: 'tool_execution_end',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              toolCallId: event.toolCallId,
              result: event.result,
              isError: event.isError,
            },
          },
        ];

      case 'agent_end':
        return [
          {
            type: 'agent_end',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              result: event.result,
              usage: event.usage,
            },
          },
        ];

      case 'rate_limit':
        return [
          {
            type: 'rate_limit',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              status: event.status,
              rateLimitType: event.rateLimitType,
              isUsingOverage: event.isUsingOverage,
              resetsAt: event.resetsAt,
            },
          },
        ];

      case 'permission_request':
        return [
          {
            type: 'permission_request',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              requestId: event.requestId,
              toolName: event.toolName,
              description: event.description,
              args: event.args,
              sessionId: event.sessionId,
            },
          },
        ];

      case 'tool_execution':
        return [
          {
            type: 'tool_execution_start',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              toolCallId: (event.toolCallId as string) ?? (event.tool_call_id as string),
              toolName: event.toolName ?? event.tool_name,
              args: event.args,
            },
          },
        ];

      case 'tool_result':
        return [
          {
            type: 'tool_execution_end',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              toolCallId: (event.toolCallId as string) ?? (event.tool_call_id as string),
              result: event.result,
              isError: (event.isError as boolean) ?? false,
            },
          },
        ];

      case 'session_status':
        return [
          {
            type: 'session_status',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              status: event.status,
            },
          },
        ];

      case 'error':
        return [
          {
            type: 'error',
            sessionId: event.sessionId,
            timestamp: ts,
            data: {
              message: event.message,
              code: event.code,
            },
          },
        ];

      default:
        return [
          {
            type: 'claude_channel_raw',
            sessionId: event.sessionId,
            timestamp: ts,
            data: event,
          },
        ];
    }
  }

  toPiFormat(event: NormalizedEvent): Record<string, unknown> {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case 'message_start':
        return { type: 'message_start', message: { id: data.id, role: data.role } };
      case 'message_update':
        return { type: 'message_update', message: { id: data.id }, assistantMessageEvent: data.assistantMessageEvent };
      case 'message_end':
        return { type: 'message_end', message: { id: data.id } };
      case 'tool_execution_start':
        return { type: 'tool_execution_start', toolCallId: data.toolCallId, toolName: data.toolName, args: data.args };
      case 'tool_execution_end':
        return { type: 'tool_execution_end', toolCallId: data.toolCallId, result: data.result, isError: data.isError };
      case 'tool_execution_update':
        return { type: 'tool_execution_update', toolCallId: data.toolCallId, partialResult: data.partialResult };
      case 'agent_start':
        return { type: 'agent_start' };
      case 'agent_end':
        return { type: 'agent_end', result: (data as Record<string, unknown>).result, usage: (data as Record<string, unknown>).usage };
      case 'session_init':
        return { type: 'session_init', ...data };
      case 'rate_limit':
        return { type: 'rate_limit', ...data };
      default:
        return { type: event.type, ...data };
    }
  }
}
