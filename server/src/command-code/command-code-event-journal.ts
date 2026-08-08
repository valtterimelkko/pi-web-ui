import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';

export class CommandCodeJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandCodeJournalError';
  }
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
    const filename = this.filePath(validateSessionId(sessionId));
    let content: string;
    try { content = await readFile(filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) throw new CommandCodeJournalError('Command Code event journal exceeds byte limit');
    const result: NormalizedEvent[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
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

  private filePath(sessionId: string): string {
    return path.join(this.root, 'events', `${sessionId}.jsonl`);
  }
}

function validateSessionId(value: string): string {
  if (!/^[-a-zA-Z0-9_]+$/.test(value)) throw new CommandCodeJournalError('Invalid Command Code session id');
  return value;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.length > 20_000 ? `${value.slice(0, 20_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (/(?:token|secret|password|api[_-]?key|auth(?:entication)?)/i.test(key)) result[key] = '[REDACTED]';
    else result[key] = redactValue(item, depth + 1);
  }
  return result;
}
