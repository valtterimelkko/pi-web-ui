import fs from 'fs/promises';
import { stat } from 'fs/promises';
import { replayEventsToVisibleItems, buildVisibleTranscript } from './visible-transcript.js';
import type { VisibleTranscript, VisibleTranscriptSource, TransferScope } from './types.js';
import type { SdkType } from '@pi-web-ui/shared';
import { isToolVisible, extractToolPrimaryArg } from './transfer-validation.js';
import { MAX_TOOL_OUTPUT_LENGTH } from './types.js';
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

  const lines = raw.split('\n').filter(l => l.trim());
  const items: VisibleTranscriptItem[] = [];

  for (const line of lines) {
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
          items.push({
            kind: role,
            text: transformSkillContent(text),
            timestamp,
          });
        }
      }
    } else if (entry.type === 'tool_execution_start') {
      const toolName = (entry as Record<string, unknown>).toolName as string | undefined;
      if (toolName && isToolVisible(toolName)) {
        items.push({
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
        items.push({
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

  return { transcript: buildVisibleTranscript(items, source, scope) };
}

function extractTextFromContent(
  content: Array<{ type: string; text?: string; thinking?: string }> | string | undefined,
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
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
