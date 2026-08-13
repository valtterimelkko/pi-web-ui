import type { CommandCodeModel } from './command-code-model-catalog.js';

export interface CommandCodeEventFrame {
  type: 'event';
  event: Record<string, unknown>;
}

export interface CommandCodeResultFrame {
  type: 'result';
  subtype: 'success' | 'error' | 'max_turns';
  sessionId?: string;
  stopReason?: string;
  finalText?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParsedCommandCodeEvent {
  event: Record<string, unknown>;
  lineNumber: number;
}

export interface ParsedCommandCodeOutput {
  events: ParsedCommandCodeEvent[];
  terminal: CommandCodeResultFrame;
  unknownEventTypes: string[];
  suppressedDuplicateCount: number;
  bytes: number;
  lineCount: number;
}

export interface CommandCodeParserOptions {
  maxLineBytes?: number;
  maxAggregateBytes?: number;
  maxUnknownEvents?: number;
  /** Called synchronously after each accepted event frame, before finish(). */
  onEvent?: (event: ParsedCommandCodeEvent) => void;
}

export class CommandCodeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandCodeProtocolError';
  }
}

/** Incremental, bounded parser for Command Code's public NDJSON print stream. */
export class CommandCodeNdjsonParser {
  private readonly maxLineBytes: number;
  private readonly maxAggregateBytes: number;
  private readonly maxUnknownEvents: number;
  private readonly onEvent?: (event: ParsedCommandCodeEvent) => void;
  private buffer = '';
  private bytes = 0;
  private lineCount = 0;
  private terminal?: CommandCodeResultFrame;
  private readonly events: ParsedCommandCodeEvent[] = [];
  private readonly unknownEventTypes: string[] = [];
  private suppressedDuplicateCount = 0;
  private readonly cumulativeSnapshots = new Map<string, string>();

  constructor(options: CommandCodeParserOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? 512 * 1024;
    this.maxAggregateBytes = options.maxAggregateBytes ?? 8 * 1024 * 1024;
    this.maxUnknownEvents = options.maxUnknownEvents ?? 100;
    this.onEvent = options.onEvent;
  }

  push(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const byteLength = Buffer.byteLength(text, 'utf8');
    this.bytes += byteLength;
    if (this.bytes > this.maxAggregateBytes) {
      throw new CommandCodeProtocolError('Command Code stdout exceeded aggregate byte limit');
    }
    this.buffer += text;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.consumeLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  finish(exitCode: number | null, signal?: NodeJS.Signals | null): ParsedCommandCodeOutput {
    if (this.buffer.trim().length > 0) {
      this.consumeLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
    if (!this.terminal) throw new CommandCodeProtocolError('Command Code stream ended without a terminal result');
    if (this.terminal.subtype === 'success' && exitCode !== 0) {
      throw new CommandCodeProtocolError(`Command Code result/exit contradiction: success with exit ${exitCode ?? signal ?? 'unknown'}`);
    }
    return {
      events: [...this.events],
      terminal: this.terminal,
      unknownEventTypes: [...this.unknownEventTypes],
      suppressedDuplicateCount: this.suppressedDuplicateCount,
      bytes: this.bytes,
      lineCount: this.lineCount,
    };
  }

  private consumeLine(line: string): void {
    this.lineCount += 1;
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      throw new CommandCodeProtocolError(`Command Code stdout line ${this.lineCount} exceeded byte limit`);
    }
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CommandCodeProtocolError(`Malformed Command Code NDJSON line ${this.lineCount}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CommandCodeProtocolError(`Command Code frame ${this.lineCount} is not an object`);
    }
    const frame = value as Record<string, unknown>;
    if (this.terminal) throw new CommandCodeProtocolError('Command Code emitted data after its terminal result');
    if (frame.type === 'event') {
      this.consumeEvent(frame, this.lineCount);
      return;
    }
    if (frame.type === 'result') {
      this.consumeResult(frame);
      return;
    }
    throw new CommandCodeProtocolError(`Unknown Command Code top-level frame type: ${String(frame.type)}`);
  }

  private consumeEvent(frame: Record<string, unknown>, lineNumber: number): void {
    const rawEvent = frame.event;
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      throw new CommandCodeProtocolError(`Malformed Command Code event frame ${lineNumber}`);
    }
    const event = rawEvent as Record<string, unknown>;
    if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 160) {
      throw new CommandCodeProtocolError(`Malformed Command Code event type at line ${lineNumber}`);
    }
    const cumulative = event.cumulative === true || event.snapshot === true;
    const textKey = typeof event.messageId === 'string'
      ? event.messageId
      : typeof event.contentId === 'string'
        ? event.contentId
        : event.type;
    const text = typeof event.text === 'string'
      ? event.text
      : typeof event.content === 'string'
        ? event.content
        : undefined;
    if (cumulative && text !== undefined) {
      const previous = this.cumulativeSnapshots.get(textKey) ?? '';
      if (text === previous || text.startsWith(previous) === false) {
        if (text === previous) {
          this.suppressedDuplicateCount += 1;
          return;
        }
        // A replacement snapshot is retained as a new visible snapshot rather
        // than guessing a suffix from unrelated content.
        this.cumulativeSnapshots.set(textKey, text);
      } else {
        this.cumulativeSnapshots.set(textKey, text);
        const suffix = text.slice(previous.length);
        if (!suffix) {
          this.suppressedDuplicateCount += 1;
          return;
        }
        const normalized = { ...event, text: suffix, cumulative: false };
        const parsed = { event: normalized, lineNumber };
        this.events.push(parsed);
        this.onEvent?.(parsed);
        return;
      }
    }
    if (event.type === 'unknown' || event.unknown === true || event.known === false) {
      if (this.unknownEventTypes.length < this.maxUnknownEvents) this.unknownEventTypes.push(event.type);
    } else if (!KNOWN_EVENT_TYPES.has(event.type) && this.unknownEventTypes.length < this.maxUnknownEvents) {
      this.unknownEventTypes.push(event.type);
    }
    const parsed = { event: { ...event }, lineNumber };
    this.events.push(parsed);
    this.onEvent?.(parsed);
  }

  private consumeResult(frame: Record<string, unknown>): void {
    if (frame.subtype !== 'success' && frame.subtype !== 'error' && frame.subtype !== 'max_turns') {
      throw new CommandCodeProtocolError('Malformed Command Code terminal result subtype');
    }
    if (frame.sessionId !== undefined && typeof frame.sessionId !== 'string') {
      throw new CommandCodeProtocolError('Malformed Command Code native session id');
    }
    if (frame.stopReason !== undefined && typeof frame.stopReason !== 'string') {
      throw new CommandCodeProtocolError('Malformed Command Code stop reason');
    }
    if (frame.finalText !== undefined && typeof frame.finalText !== 'string') {
      throw new CommandCodeProtocolError('Malformed Command Code final text');
    }
    this.terminal = frame as CommandCodeResultFrame;
  }
}

const KNOWN_EVENT_TYPES = new Set([
  'session_start', 'session_end', 'turn_start', 'turn_end', 'message_start',
  'message_update', 'message_end', 'tool_start', 'tool_execution_start',
  'tool_update', 'tool_execution_update', 'tool_result', 'tool_execution_end',
  'thinking', 'reasoning', 'usage', 'compaction_start', 'compaction_end',
  'error', 'heartbeat',
  // Command Code 1.19.0 print-stream lifecycle and delta events.
  'run_start', 'run_end', 'model_request_start', 'model_request_end', 'model_trace',
  'thinking_start', 'thinking_delta', 'thinking_end', 'text_delta',
]);

export type { CommandCodeModel };
