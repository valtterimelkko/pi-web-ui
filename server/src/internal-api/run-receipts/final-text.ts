/**
 * Contract 1.47.0 (C2): bounded final assistant text for run receipts.
 *
 * Observes the normalized events already correlated to one run and keeps the
 * text of the LAST assistant message segment, tail-truncated to
 * {@link FINAL_TEXT_MAX_CHARS}. Runtime-neutral: it understands the shapes the
 * adapters already emit —
 *
 * - `message_start` role from `data.role` (Claude/OpenCode/Command Code/agy)
 *   or `data.message.role` (Pi); user messages are ignored even when their
 *   text is echoed as a `text_delta` (Antigravity, OpenCode replay).
 * - `message_update` `assistantMessageEvent.type === 'text_delta'` appends;
 *   an `assistantMessageEvent.content` array is a snapshot of the message.
 * - `message_end` carrying a full assistant `message.content` (Pi) is
 *   authoritative for that message.
 * - a tool call starts a new segment: the final text is what the assistant
 *   said after its last tool call, falling back to the last non-empty text.
 */
import type { NormalizedEvent } from '@pi-web-ui/shared';

export const FINAL_TEXT_MAX_CHARS = 4096;

export interface FinalTextSnapshot {
  text: string;
  truncated: boolean;
}

type Role = 'assistant' | 'user' | 'unknown';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function roleOf(data: Record<string, unknown> | undefined): Role {
  const direct = data?.role;
  const nested = record(data?.message)?.role;
  const role = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : undefined;
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'unknown';
}

function textOfContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let text = '';
  let sawText = false;
  for (const block of content) {
    const b = record(block);
    if (b?.type === 'text' && typeof b.text === 'string') {
      text += b.text;
      sawText = true;
    }
  }
  return sawText ? text : undefined;
}

export class FinalTextTracker {
  private role: Role = 'unknown';
  private current = '';
  private currentTruncated = false;
  private previous?: FinalTextSnapshot;

  observe(event: NormalizedEvent): void {
    const data = record(event.data);
    switch (event.type) {
      case 'message_start': {
        const role = roleOf(data);
        this.role = role;
        if (role !== 'user') this.startSegment();
        return;
      }
      case 'message_update': {
        if (this.role === 'user') return;
        const ame = record(data?.assistantMessageEvent);
        if (!ame) return;
        const snapshot = textOfContent(ame.content);
        if (snapshot !== undefined) {
          this.replace(snapshot);
          return;
        }
        if (ame.type === 'text_delta' && typeof ame.delta === 'string') this.append(ame.delta);
        return;
      }
      case 'message_end': {
        const message = record(data?.message);
        if (message?.role === 'assistant') {
          const full = textOfContent(message.content);
          if (full !== undefined && full.length > 0) this.replace(full);
        }
        // Text after a message boundary without a new message_start (e.g. SDK
        // partials) belongs to the assistant, never to the previous user turn.
        this.role = 'unknown';
        return;
      }
      case 'tool_execution_start':
        this.startSegment();
        return;
      default:
        return;
    }
  }

  snapshot(): FinalTextSnapshot | undefined {
    if (this.current.length > 0) return { text: this.current, truncated: this.currentTruncated };
    return this.previous ? { ...this.previous } : undefined;
  }

  private startSegment(): void {
    if (this.current.length > 0) {
      this.previous = { text: this.current, truncated: this.currentTruncated };
    }
    this.current = '';
    this.currentTruncated = false;
  }

  private append(text: string): void {
    if (!text) return;
    this.setBounded(this.current + text, this.currentTruncated);
  }

  private replace(text: string): void {
    this.setBounded(text, false);
  }

  private setBounded(text: string, alreadyTruncated: boolean): void {
    if (text.length > FINAL_TEXT_MAX_CHARS) {
      this.current = text.slice(text.length - FINAL_TEXT_MAX_CHARS);
      this.currentTruncated = true;
    } else {
      this.current = text;
      this.currentTruncated = alreadyTruncated;
    }
  }
}
