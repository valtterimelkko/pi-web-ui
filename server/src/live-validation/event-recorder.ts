import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { ValidationSummary } from './types.js';

export function collectValidationSummary(events: NormalizedEvent[]): ValidationSummary {
  let assistantText = '';
  const toolNames = new Set<string>();
  const approvalRequestIds = new Set<string>();
  let sawAgentStart = false;
  let sawAgentEnd = false;
  let heartbeatCount = 0;

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === 'agent_start') sawAgentStart = true;
    if (event.type === 'agent_end') sawAgentEnd = true;
    if (event.type === 'stream_activity') heartbeatCount += 1;
    if (event.type === 'tool_execution_start' && typeof data.toolName === 'string') {
      toolNames.add(data.toolName);
    }
    if (event.type === 'permission_request' && typeof data.permissionId === 'string') {
      approvalRequestIds.add(data.permissionId);
    }
    if (event.type === 'message_update') {
      const assistantMessageEvent = data.assistantMessageEvent as Record<string, unknown> | undefined;
      const content = assistantMessageEvent?.content as Array<{ type: string; text?: string }> | undefined;
      if (assistantMessageEvent?.type === 'text_delta' && typeof assistantMessageEvent.delta === 'string') {
        assistantText += assistantMessageEvent.delta;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            assistantText += block.text;
          }
        }
      }
    }
  }

  return {
    sawAgentStart,
    sawAgentEnd,
    assistantText,
    toolNames: Array.from(toolNames),
    heartbeatCount,
    approvalRequestIds: Array.from(approvalRequestIds),
    events,
  };
}
