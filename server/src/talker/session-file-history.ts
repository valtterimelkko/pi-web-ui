/**
 * Reading the worker's conversation from its session FILE.
 *
 * Why this exists: a session is loaded into the Pi manager lazily, so an idle,
 * evicted, or post-restart worker has no in-memory messages — while its session
 * file is complete on disk and the UI displays it perfectly well. The talker's
 * projection read only the in-memory session, so on 2026-09-18 the operator asked
 * the native lane to summarise a real 540-message session and heard *"I don't have
 * access to the worker's session history"*. This is the reader that closes that
 * gap for the `pi` runtime.
 *
 * It is deliberately a READER and nothing else: it returns the operator-visible
 * conversation (user and assistant, oldest first), a truthful total, and the file
 * version it read, so a caller can cache safely. It cannot send, hold, confirm or
 * release anything, and this module imports no delivery path.
 *
 * The parse reuses `parsePiSessionHistory` — the SAME interpretation of a session
 * file the browser replay uses — so the talker and the UI never disagree about
 * what a session says. Tool results and raw thinking are excluded: they are
 * harness noise, never spoken material (P20).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parsePiSessionHistory, type PiSessionHistoryMessage } from '../pi/session-history.js';
import type { WorkerHistoryEntry } from './types.js';

export const SESSION_FILE_HISTORY_LIMITS = {
  /**
   * Conversation entries a single read keeps when the caller does not say. The
   * renderer clips and budgets from here; this only stops a pathological file
   * from filling memory. The TOTAL is always exact, so a capped read still
   * discloses honestly what it is not showing.
   */
  maxEntries: 2_000,
} as const;

/** The file version a read was taken from, for safe caching by the caller. */
export interface SessionFileVersion {
  size: number;
  mtimeMs: number;
}

export interface SessionFileHistory {
  /** The operator-visible conversation, oldest first. */
  entries: WorkerHistoryEntry[];
  /** Exact number of conversation messages the file holds (not lines). */
  total: number;
  /**
   * Present when the file was read. Absent means "nothing readable here" — the
   * caller must not cache that as a version, so a file that appears later is seen.
   */
  fileVersion?: SessionFileVersion;
}

const EMPTY: SessionFileHistory = { entries: [], total: 0 };

/** Visible text of one parsed message; thinking parts carry no text and drop out. */
function textOf(content: PiSessionHistoryMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join(' ');
}

/**
 * The file's version WITHOUT reading it. This is what makes a cache safe: a caller
 * can compare versions and skip the stream entirely when nothing has changed —
 * which matters because the worker-status poll runs every second.
 */
export async function sessionFileVersion(sessionPath: string): Promise<SessionFileVersion | undefined> {
  try {
    const info = await stat(sessionPath);
    if (!info.isFile() || info.size === 0) return undefined;
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Stream the session file once, keeping only the newest `maxEntries` conversation
 * messages in memory while counting every one of them. Streaming (rather than
 * `readFile`) is what keeps a 70 MB session from becoming a 70 MB buffer, and the
 * count keeps the truncation disclosure exact.
 */
export async function readSessionFileHistory(
  sessionPath: string,
  options: { maxEntries?: number } = {},
): Promise<SessionFileHistory> {
  const maxEntries = Math.max(1, options.maxEntries ?? SESSION_FILE_HISTORY_LIMITS.maxEntries);

  const version = await sessionFileVersion(sessionPath);
  if (!version) return EMPTY;

  const entries: WorkerHistoryEntry[] = [];
  let total = 0;
  try {
    const lines = createInterface({
      input: createReadStream(sessionPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // An interrupted write leaves a partial final line: skip it, keep the rest.
        continue;
      }
      for (const message of parsePiSessionHistory([raw])) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const text = textOf(message.content).trim();
        if (!text) continue;
        total += 1;
        entries.push({ role: message.role, text });
        if (entries.length > maxEntries) entries.shift();
      }
    }
  } catch {
    // The file vanished or could not be streamed: report what was read, which is
    // nothing invented and at most an honest, if empty, view.
    return total > 0 ? { entries, total, fileVersion: version } : { ...EMPTY, fileVersion: version };
  }

  return { entries, total, fileVersion: version };
}
