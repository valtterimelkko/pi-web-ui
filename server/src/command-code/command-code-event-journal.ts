import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { CommandCodeReplayCoalesceStats } from './command-code-replay-projection.js';

export class CommandCodeJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandCodeJournalError';
  }
}

export interface CommandCodeReplayProjectionSnapshot extends CommandCodeReplayCoalesceStats {
  sessionId: string;
  at: string;
}

export interface CommandCodeJournalStats {
  eventCount: number;
  byteSize: number;
  maxBytes: number;
  exists: boolean;
}

export class CommandCodeEventJournal {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(root: string, options: { maxBytes?: number; maxEventBytes?: number } = {}) {
    this.root = path.resolve(root);
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 50 * 1024;
  }

  async append(sessionId: string, event: NormalizedEvent): Promise<void> {
    const operation = (this.queues.get(sessionId) ?? Promise.resolve()).then(async () => {
      const safeSessionId = validateSessionId(sessionId);
      const sanitized = redactValue(event) as NormalizedEvent;
      const line = JSON.stringify(sanitized);
      if (Buffer.byteLength(line, 'utf8') > this.maxEventBytes) throw new CommandCodeJournalError('Command Code event exceeds journal event limit');
      const filename = this.filePath(safeSessionId);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      let currentBytes = 0;
      try { currentBytes = (await stat(filename)).size; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (currentBytes + Buffer.byteLength(`${line}\n`, 'utf8') > this.maxBytes) throw new CommandCodeJournalError('Command Code event journal exceeds byte limit');
      await appendFile(filename, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    this.queues.set(sessionId, operation.catch(() => undefined));
    await operation;
  }

  async read(sessionId: string): Promise<NormalizedEvent[]> {
    const safeSessionId = validateSessionId(sessionId);
    // Join this session's append queue before reading: replaying while a turn
    // is streaming must never observe a line the writer has not fully
    // committed (a partial trailing line would otherwise fail the whole
    // replay and surface to the user as an empty session view).
    const pendingWrite = this.queues.get(safeSessionId);
    if (pendingWrite) await pendingWrite;
    const filename = this.filePath(safeSessionId);
    let content: string;
    try { content = await readFile(filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) throw new CommandCodeJournalError('Command Code event journal exceeds byte limit');
    const result: NormalizedEvent[] = [];
    const lines = content.split(/\r?\n/);
    // The appender always writes `line + '\n'` in one call and reads join the
    // write queue, so a live writer can never be observed half-way. A trailing
    // fragment without a terminating newline can therefore only come from a
    // writer crash mid-append: drop it instead of failing the entire replay.
    // A corrupt complete, newline-terminated line is real corruption and
    // still fails loudly. (Both cases drop the final split element: the empty
    // tail after a terminator, or the truncated fragment without one.)
    const completeLines = lines.slice(0, -1);
    for (const [index, line] of completeLines.entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as NormalizedEvent;
        if (!event || typeof event !== 'object' || typeof event.type !== 'string' || typeof event.timestamp !== 'number') {
          throw new Error('invalid event shape');
        }
        result.push(event);
      } catch {
        throw new CommandCodeJournalError(`Command Code event journal corruption at line ${index + 1}`);
      }
    }
    return result;
  }

  async clear(sessionId: string): Promise<void> {
    const filename = this.filePath(validateSessionId(sessionId));
    await writeFile(filename, '', { encoding: 'utf8', mode: 0o600 });
  }

  /** Bounded read of journal size and event count for observability. */
  async stats(sessionId: string): Promise<CommandCodeJournalStats> {
    const safeSessionIdForStats = validateSessionId(sessionId);
    const pendingStatsWrite = this.queues.get(safeSessionIdForStats);
    if (pendingStatsWrite) await pendingStatsWrite;
    const filename = this.filePath(safeSessionIdForStats);
    try {
      const [fileStat, content] = await Promise.all([stat(filename), readFile(filename, 'utf8')]);
      return {
        eventCount: content.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
        byteSize: fileStat.size,
        maxBytes: this.maxBytes,
        exists: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { eventCount: 0, byteSize: 0, maxBytes: this.maxBytes, exists: false };
      }
      throw error;
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.root, 'events', `${sessionId}.jsonl`);
  }
}

function validateSessionId(value: string): string {
  if (!/^[-a-zA-Z0-9_]+$/.test(value)) throw new CommandCodeJournalError('Invalid Command Code session id');
  return value;
}

/** Keys whose STRING values are redacted (token-ish names included). */
const SENSITIVE_STRING_KEY = /(?:token|secret|password|api[_-]?key|auth(?:entication)?)/i;
/** Keys whose whole OBJECT value is replaced: credential blobs, never data. */
const SENSITIVE_OBJECT_KEY = /(?:secret|password|api[_-]?key|auth(?:entication)?|credential)/i;
/** A pure decimal string is a count, never a secret. */
function isNumericString(value: string): boolean {
  return /^\d+$/.test(value);
}

function redactValue(value: unknown, depth = 0, keyHint = ''): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    if (SENSITIVE_STRING_KEY.test(keyHint) && !isNumericString(value)) return '[REDACTED]';
    return redactSensitiveText(value.length > 20_000 ? `${value.slice(0, 20_000)}…` : value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1, keyHint));
  if (!value || typeof value !== 'object') return value;
  if (depth > 0 && SENSITIVE_OBJECT_KEY.test(keyHint)) return '[REDACTED]';
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (SENSITIVE_STRING_KEY.test(key) && typeof item === 'string' && !isNumericString(item)) result[key] = '[REDACTED]';
    else if (SENSITIVE_OBJECT_KEY.test(key) && item && typeof item === 'object') result[key] = '[REDACTED]';
    else result[key] = redactValue(item, depth + 1, key);
  }
  return result;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/(\b(?:token|secret|password|api[_-]?key)\b\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]');
}
