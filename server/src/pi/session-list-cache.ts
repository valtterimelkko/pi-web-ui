import { open, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { SessionInfo } from '@pi-web-ui/shared';
import { config } from '../config.js';

/**
 * In-memory, mtime-keyed cache for the Pi session list.
 *
 * Replaces the `SessionManager.listAll()` scan in handleGetSessions
 * (connection.ts) that JSON-parses EVERY on-disk session file (~4s for ~826
 * files) on every page load / reconnect. This cache parses each file once and
 * thereafter re-parses ONLY files whose mtime changed — so a page load where
 * nothing changed is ~free, and an active session changing re-parses just that
 * one file.
 *
 * parsePiSessionInfo mirrors the SDK's buildSessionInfo field semantics
 * (messageCount counts every message entry; firstMessage = first user message
 * with text; lastActivity = max message activity time, falling back to the
 * header timestamp) so sidebar data is unchanged versus the scan.
 */

export interface ParsedPiSession {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  createdMs: number;
  lastActivityMs: number;
  messageCount: number;
  firstMessage: string;
  mtimeMs: number;
}

type SessionEntry = Record<string, unknown> & { message?: Record<string, unknown> };

function dateMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

/**
 * Parse a single Pi session file's metadata. Reads every line (messageCount /
 * lastActivity require it) — so this is O(file size), but the cache only calls
 * it for changed files. Returns null for a missing/unreadable file or one whose
 * first entry is not a `type:"session"` header (matches SDK buildSessionInfo).
 */
export async function parsePiSessionInfo(filePath: string, mtimeMs: number): Promise<ParsedPiSession | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    let header: SessionEntry | null = null;
    let headerId = '';
    let messageCount = 0;
    let firstMessage = '';
    let name: string | undefined;
    let lastActivityMs: number | undefined;

    for await (const line of handle.readLines()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: SessionEntry;
      try {
        entry = JSON.parse(trimmed) as SessionEntry;
      } catch {
        continue;
      }
      if (!header) {
        if (entry.type !== 'session' || typeof entry.id !== 'string') return null;
        header = entry;
        headerId = entry.id;
        continue;
      }
      if (entry.type === 'session_info') {
        name = (typeof entry.name === 'string' ? entry.name.trim() : '') || undefined;
      }
      if (entry.type !== 'message') continue;
      // messageCount counts every message entry, regardless of content
      messageCount++;
      const message = entry.message;
      if (!message || typeof message.role !== 'string' || !('content' in message)) continue;
      if (message.role === 'user' || message.role === 'assistant') {
        const t = typeof message.timestamp === 'number' ? message.timestamp : dateMs(entry.timestamp);
        if (t !== undefined) lastActivityMs = Math.max(lastActivityMs ?? -Infinity, t);
      }
      if (!firstMessage && message.role === 'user') {
        const text = extractText(message.content);
        if (text) firstMessage = text;
      }
    }
    if (!header) return null;

    const cwd = typeof header.cwd === 'string' ? header.cwd : '';
    const headerMs = dateMs(header.timestamp);
    const createdMs = headerMs ?? mtimeMs;
    const lastMs = lastActivityMs ?? headerMs ?? mtimeMs;
    return {
      id: headerId,
      path: filePath,
      cwd,
      name,
      parentSessionPath: typeof header.parentSession === 'string' ? header.parentSession : undefined,
      createdMs,
      lastActivityMs: lastMs,
      messageCount,
      firstMessage: firstMessage || '(no messages)',
      mtimeMs,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function toSessionInfo(p: ParsedPiSession): SessionInfo {
  return {
    id: p.id,
    path: p.path,
    cwd: p.cwd,
    name: p.name,
    sdkType: 'pi',
    parentSessionPath: p.parentSessionPath,
    createdAt: new Date(p.createdMs),
    lastActivity: new Date(p.lastActivityMs),
    messageCount: p.messageCount,
    firstMessage: p.firstMessage,
  };
}

/** Discover all `<sessionsDir>/<encoded-cwd>/*.jsonl` files with their mtimes. */
async function discoverFiles(sessionsDir: string): Promise<{ path: string; mtimeMs: number }[]> {
  let dirs: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));
  } catch {
    return [];
  }
  const out: { path: string; mtimeMs: number }[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const p = join(dir, name);
      try {
        const st = await stat(p);
        out.push({ path: p, mtimeMs: st.mtimeMs });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class PiSessionListCache {
  private entries = new Map<string, { info: ParsedPiSession; mtimeMs: number }>();
  private inflight: Promise<SessionInfo[]> | null = null;

  constructor(
    private sessionsDir: string,
    private parseFile: (path: string, mtimeMs: number) => Promise<ParsedPiSession | null> = parsePiSessionInfo,
  ) {}

  /** Return the current Pi session list, re-parsing only files changed since last call. */
  async list(): Promise<SessionInfo[]> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        return await this.reconcile();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async reconcile(): Promise<SessionInfo[]> {
    const files = await discoverFiles(this.sessionsDir);
    const seen = new Set<string>();
    const changed: { path: string; mtimeMs: number }[] = [];
    for (const f of files) {
      seen.add(f.path);
      const cached = this.entries.get(f.path);
      if (!cached || cached.mtimeMs !== f.mtimeMs) changed.push(f);
    }
    await runWithConcurrency(changed, 10, async (f) => {
      const info = await this.parseFile(f.path, f.mtimeMs);
      if (info) this.entries.set(f.path, { info, mtimeMs: f.mtimeMs });
      else this.entries.delete(f.path);
    });
    for (const p of [...this.entries.keys()]) {
      if (!seen.has(p)) this.entries.delete(p);
    }
    const result = [...this.entries.values()].map(({ info }) => toSessionInfo(info));
    result.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
    return result;
  }
}

// Process-wide singleton: the cache must persist across get_sessions calls
// (WebSocketConnectionManager is itself a singleton, so this is shared by all clients).
let piSessionListCacheSingleton: PiSessionListCache | null = null;

export function getPiSessionListCache(): PiSessionListCache {
  if (!piSessionListCacheSingleton) {
    piSessionListCacheSingleton = new PiSessionListCache(join(config.piAgentDir, 'sessions'));
  }
  return piSessionListCacheSingleton;
}
