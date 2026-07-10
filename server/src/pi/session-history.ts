import { summarizeSubagentDetails, type SubagentToolSummary } from '@pi-web-ui/shared';

/** The compact replay message shape used by Pi session switching. */
export interface PiSessionHistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; thinking?: string }>;
  timestamp: number;
  toolCall?: { id: string; name: string; args: unknown };
  toolResult?: { output: string; isError: boolean; summary?: SubagentToolSummary };
}

interface PendingSubagentCall {
  id: string;
  name: 'subagent' | 'evaluated_subagent';
  args: unknown;
  timestamp: number;
}

const SUBAGENT_TOOLS = new Set<PendingSubagentCall['name']>(['subagent', 'evaluated_subagent']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function visibleContent(content: unknown): PiSessionHistoryMessage['content'] {
  if (!Array.isArray(content)) return '';
  const parts = content
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .filter((item) => item.type === 'text' || item.type === 'thinking');
  return parts.map((item) => item.type === 'thinking'
    ? { type: 'thinking', thinking: typeof item.thinking === 'string' ? item.thinking : '' }
    : { type: 'text', text: typeof item.text === 'string' ? item.text : '' });
}

function skillPlaceholder(content: PiSessionHistoryMessage['content']): string | undefined {
  const text = Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content;
  const isSkill = text.includes('<skill name="') && text.includes('</skill>');
  if (!isSkill && !text.includes('# Lecture Website Builder')) return undefined;
  const name = text.match(/<skill name="([^"]+)"/)?.[1];
  return name ? `📚 **Skill loaded: ${name}**` : '📚 **Skill loaded**';
}

function isError(message: Record<string, unknown>, summary: SubagentToolSummary): boolean {
  if (typeof message.isError === 'boolean') return message.isError;
  return summary.agents.some((agent) => agent.timedOut || (agent.exitCode !== undefined && agent.exitCode !== 0));
}

/**
 * Projects persisted Pi JSONL entries into the compact history sent on a browser
 * session switch. It intentionally replays only subagent/evaluated_subagent
 * cards: the summary contains identity and aggregate usage, never the inner
 * subagent transcript or final report.
 */
export function parsePiSessionHistory(entries: unknown[]): PiSessionHistoryMessage[] {
  const messages: PiSessionHistoryMessage[] = [];
  const pending = new Map<string, PendingSubagentCall>();

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry || entry.type !== 'message') continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    const role = message.role;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now();

    if (role === 'user' || role === 'assistant') {
      const content = visibleContent(message.content);
      const placeholder = skillPlaceholder(content);
      messages.push({
        id: typeof entry.id === 'string' ? entry.id : `msg_${timestamp}`,
        role,
        content: placeholder ? [{ type: 'text', text: placeholder }] : content,
        timestamp,
      });

      if (role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          const toolCall = asRecord(block);
          if (!toolCall || toolCall.type !== 'toolCall' || !SUBAGENT_TOOLS.has(toolCall.name as PendingSubagentCall['name'])) continue;
          if (typeof toolCall.id !== 'string') continue;
          pending.set(toolCall.id, {
            id: toolCall.id,
            name: toolCall.name as PendingSubagentCall['name'],
            args: toolCall.arguments,
            timestamp,
          });
        }
      }
      continue;
    }

    if (role !== 'toolResult' || !SUBAGENT_TOOLS.has(message.toolName as PendingSubagentCall['name'])) continue;
    const toolCallId = message.toolCallId;
    if (typeof toolCallId !== 'string') continue;
    const call = pending.get(toolCallId);
    if (!call) continue;
    pending.delete(toolCallId);

    const summary = summarizeSubagentDetails(call.name, message.details);
    if (!summary) continue;
    messages.push({
      // Match the live event's `toolCallId`, so an in-flight replay card is
      // updated in place when its subsequent tool_execution_end arrives.
      id: call.id,
      role: 'tool',
      content: [],
      timestamp,
      toolCall: { id: call.id, name: call.name, args: call.args },
      toolResult: { output: '', isError: isError(message, summary), summary },
    });
  }

  // A session can be switched to after a subagent has been persisted as a
  // tool call but before its result has reached the JSONL. Keep that compact
  // pending card so the subscribed live `tool_execution_end` can finish it.
  for (const call of pending.values()) {
    messages.push({
      id: call.id,
      role: 'tool',
      content: [],
      timestamp: call.timestamp,
      toolCall: { id: call.id, name: call.name, args: call.args },
    });
  }

  return messages;
}
