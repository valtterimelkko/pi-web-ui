import fs from 'fs/promises';
import { stat } from 'fs/promises';
import { replayEventsToVisibleItems, buildVisibleTranscript } from './visible-transcript.js';
import type { VisibleTranscript, VisibleTranscriptSource, TransferScope } from './types.js';
import type { SdkType } from '@pi-web-ui/shared';
import { isToolVisible, extractToolPrimaryArg } from './transfer-validation.js';
import { MAX_TOOL_OUTPUT_LENGTH, RECENT_ITEM_COUNT } from './types.js';
import type { VisibleTranscriptItem } from './types.js';

export interface SourceAdapterResult {
  transcript: VisibleTranscript;
  error?: string;
}

export interface PiSessionEntry {
  type: string;
  id?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; thinking?: string }> | string;
    timestamp?: number;
  };
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Read a Pi Coding Agent session JSONL and emit the common replay-event stream
 * (`message_start` / `message_update` / `message_end` + `tool_execution_*`).
 *
 * Pi session files store `message` envelopes (role + content parts) and tool
 * events rather than the message_start/update/end deltas the other runtimes
 * produce, so this normalizes them into the same flat shape — letting the
 * shared screen-view projection consume all four runtimes uniformly.
 *
 * Read-only: never writes. Returns [] if the file is missing/unreadable so a
 * thin/empty session yields a valid (empty) screen view rather than an error.
 */
export async function piSessionToReplayEvents(
  sessionPath: string,
): Promise<Array<Record<string, unknown>>> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, 'utf-8');
  } catch {
    return [];
  }

  const events: Array<Record<string, unknown>> = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(line) as PiSessionEntry;
    } catch {
      continue;
    }

    if (entry.type === 'message' && entry.message) {
      const role = entry.message.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const id = entry.id ?? `msg_${entry.timestamp ?? events.length}`;
      const ts = entry.message.timestamp ?? entry.timestamp;
      const parts = extractReplayContentParts(entry.message.content);
      events.push({ type: 'message_start', message: { id, role }, timestamp: ts });
      for (const part of parts) {
        if (part.type === 'text' && part.text) {
          events.push({
            type: 'message_update',
            message: { id },
            assistantMessageEvent: { type: 'text_delta', delta: part.text },
            timestamp: ts,
          });
        } else if (part.type === 'thinking' && part.thinking) {
          events.push({
            type: 'message_update',
            message: { id },
            assistantMessageEvent: { type: 'thinking', thinking: part.thinking },
            timestamp: ts,
          });
        }
      }
      events.push({ type: 'message_end', message: { id }, timestamp: ts });
    } else if (entry.type === 'tool_execution_start' || entry.type === 'tool_execution_end') {
      // Already in the common replay-event shape — pass straight through.
      events.push(entry as unknown as Record<string, unknown>);
    }
  }

  return events;
}

export async function extractPiTranscript(
  sessionPath: string,
  source: VisibleTranscriptSource,
  scope: TransferScope,
): Promise<SourceAdapterResult> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { transcript: emptyTranscript(source, scope), error: 'Session file not found' };
    }
    return { transcript: emptyTranscript(source, scope), error: 'Failed to read session file' };
  }

  return extractPiTranscriptFromRaw(raw, source, scope);
}

export function extractPiTranscriptFromRaw(
  raw: string,
  source: VisibleTranscriptSource,
  scope: TransferScope,
): SourceAdapterResult {
  const items: VisibleTranscriptItem[] = [];
  let omittedRecentItems = false;
  const addItem = (item: VisibleTranscriptItem) => {
    items.push(item);
    if (scope === 'visible_recent' && items.length > RECENT_ITEM_COUNT) {
      items.shift();
      omittedRecentItems = true;
    }
  };

  for (const line of iterateNonEmptyLines(raw)) {
    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(line) as PiSessionEntry;
    } catch {
      continue;
    }

    if (entry.type === 'message' && entry.message) {
      const role = entry.message.role;
      const timestamp = entry.timestamp ?? entry.message.timestamp ?? Date.now();

      if (role === 'user' || role === 'assistant') {
        const text = extractTextFromContent(entry.message.content);
        if (text.trim()) {
          addItem({
            kind: role,
            text: transformSkillContent(text),
            timestamp,
          });
        }
      }
    } else if (entry.type === 'tool_execution_start') {
      const toolName = (entry as Record<string, unknown>).toolName as string | undefined;
      if (toolName && isToolVisible(toolName)) {
        addItem({
          kind: 'tool',
          text: '',
          timestamp: entry.timestamp ?? Date.now(),
          toolName,
          toolPrimaryArg: extractToolPrimaryArg(toolName, (entry as Record<string, unknown>).args),
        });
      }
    } else if (entry.type === 'tool_execution_end') {
      const toolName = (entry as Record<string, unknown>).toolName as string | undefined;
      if (toolName && isToolVisible(toolName)) {
        const resultText = extractPiToolResult((entry as Record<string, unknown>).result);
        const truncated = resultText.length > MAX_TOOL_OUTPUT_LENGTH
          ? resultText.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '...'
          : resultText;
        addItem({
          kind: 'tool',
          text: truncated,
          timestamp: entry.timestamp ?? Date.now(),
          toolName,
          toolPrimaryArg: extractToolPrimaryArg(toolName, (entry as Record<string, unknown>).args),
        });
      }
    }
  }

  if (items.length === 0) {
    return { transcript: emptyTranscript(source, scope), error: 'Nothing visible to transfer' };
  }

  const transcript = buildVisibleTranscript(items, source, scope);
  transcript.truncated ||= omittedRecentItems;
  return { transcript };
}

function* iterateNonEmptyLines(raw: string): Generator<string> {
  let start = 0;
  for (;;) {
    const end = raw.indexOf('\n', start);
    const line = end === -1 ? raw.slice(start) : raw.slice(start, end);
    if (line.trim()) yield line;
    if (end === -1) return;
    start = end + 1;
  }
}

function extractReplayContentParts(
  content: Array<{ type: string; text?: string; thinking?: string }> | string | undefined,
): Array<{ type: string; text?: string; thinking?: string }> {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content;
}

function extractTextFromContent(
  content: Array<{ type: string; text?: string; thinking?: string }> | string | undefined,
): string {
  return extractReplayContentParts(content)
    .filter(item => item.type === 'text' && item.text)
    .map(item => item.text ?? '')
    .join('');
}

function extractPiToolResult(result: unknown): string {
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

function emptyTranscript(source: VisibleTranscriptSource, scope: TransferScope): VisibleTranscript {
  return {
    source,
    scope,
    itemCount: 0,
    truncated: false,
    items: [],
  };
}
