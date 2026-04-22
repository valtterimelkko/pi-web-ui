import {
  MAX_TOOL_OUTPUT_LENGTH,
  RECENT_ITEM_COUNT,
  type VisibleTranscript,
  type VisibleTranscriptItem,
  type VisibleTranscriptSource,
  type TransferScope,
} from './types.js';
import { isToolVisible, extractToolPrimaryArg } from './transfer-validation.js';

interface AccumulatedMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface PendingTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startTimestamp: number;
  result?: string;
  isError?: boolean;
}

export function replayEventsToVisibleItems(events: Array<Record<string, unknown>>): VisibleTranscriptItem[] {
  const items: VisibleTranscriptItem[] = [];
  const currentMessages = new Map<string, AccumulatedMessage>();
  const pendingTools = new Map<string, PendingTool>();

  for (const event of events) {
    const type = event.type as string;

    if (type === 'message_start') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const id = msg.id as string;
      const role = msg.role as string;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = msg.content as string | undefined;
      currentMessages.set(id, {
        id,
        role: role as 'user' | 'assistant',
        text: content ?? '',
        timestamp: (event.timestamp as number) ?? Date.now(),
      });
    } else if (type === 'message_update') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const id = msg.id as string;
      const acc = currentMessages.get(id);
      if (!acc) continue;

      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent?.type === 'text_delta' && typeof assistantEvent.delta === 'string') {
        acc.text += assistantEvent.delta;
      }
    } else if (type === 'message_end') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const id = msg.id as string;
      const acc = currentMessages.get(id);
      if (!acc) continue;
      currentMessages.delete(id);

      if (acc.role === 'user') {
        items.push({
          kind: 'user',
          text: transformSkillContent(acc.text),
          timestamp: acc.timestamp,
        });
      } else {
        items.push({
          kind: 'assistant',
          text: acc.text,
          timestamp: acc.timestamp,
        });
      }
    } else if (type === 'tool_execution_start') {
      const toolCallId = event.toolCallId as string;
      const toolName = event.toolName as string;
      const args = event.args;

      if (isToolVisible(toolName)) {
        pendingTools.set(toolCallId, {
          toolCallId,
          toolName,
          args,
          startTimestamp: (event.timestamp as number) ?? Date.now(),
        });
      }
    } else if (type === 'tool_execution_end') {
      const toolCallId = event.toolCallId as string;
      const pending = pendingTools.get(toolCallId);
      if (!pending) continue;
      pendingTools.delete(toolCallId);

      const resultText = extractToolResultText(event.result);
      const truncated = resultText.length > MAX_TOOL_OUTPUT_LENGTH
        ? resultText.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '...'
        : resultText;

      items.push({
        kind: 'tool',
        text: truncated,
        timestamp: pending.startTimestamp,
        toolName: pending.toolName,
        toolPrimaryArg: extractToolPrimaryArg(pending.toolName, pending.args),
      });
    }
  }

  return items;
}

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';

  const record = result as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    return record.content
      .filter((c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
      .map((c: Record<string, unknown>) => (c.text as string) ?? '')
      .join('');
  }

  if (typeof record.text === 'string') return record.text;

  return '';
}

export function applyScope(items: VisibleTranscriptItem[], scope: TransferScope): VisibleTranscriptItem[] {
  if (scope === 'visible_full') return items;
  if (items.length <= RECENT_ITEM_COUNT) return items;
  return items.slice(-RECENT_ITEM_COUNT);
}

export function buildVisibleTranscript(
  items: VisibleTranscriptItem[],
  source: VisibleTranscriptSource,
  scope: TransferScope,
): VisibleTranscript {
  const scoped = applyScope(items, scope);

  return {
    source,
    scope,
    itemCount: scoped.length,
    truncated: scope === 'visible_recent' && items.length > RECENT_ITEM_COUNT,
    items: scoped,
  };
}

function transformSkillContent(text: string): string {
  const hasSkillOpen = text.includes('<skill name="');
  const hasSkillClose = text.includes('</skill>');
  if (hasSkillOpen && hasSkillClose) {
    const match = text.match(/<skill name="([^"]+)"/);
    const name = match ? match[1] : null;
    return name ? `📚 **Skill loaded: ${name}**` : '📚 **Skill loaded**';
  }
  return text;
}
