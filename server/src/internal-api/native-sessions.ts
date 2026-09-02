// Internal API: native (direct-CLI) session store discovery.
//
// Bounded, READ-ONLY scans of the on-disk session stores of the runtimes whose
// direct-CLI sessions never enter the pi-web-ui registry:
//   claude       <claudeProjectsDir>/<encoded-cwd>/<uuid>.jsonl
//   commandcode  <commandCodeCliHomeDir>/projects/<encoded-cwd>/<uuid>.jsonl
//                + <commandCodeNativeHomeDir>/<internalId>/.commandcode/projects/<encoded-cwd>/<uuid>.jsonl
//   opencode     <opencodeStorageDir>/session/<project|global>/ses_*.json
//   antigravity  <antigravityConversationsDir>/<uuid>.db
//
// Pi is deliberately not scanned: native pi sessions are auto-discovered into
// the registry by the Pi SessionWatcher, so the registry list already covers
// them. This module never mutates the registry or the scanned stores; its only
// filesystem operations are readdir/stat and bounded reads for previews.
//
// Every walker is bounded (MAX_ENTRIES_PER_ROOT per directory level) so a huge
// or hostile store cannot make the endpoint unbounded. Previews read at most
// PREVIEW_MAX_BYTES per file and are best-effort: any parse failure yields no
// preview rather than an error.

import fs from 'fs/promises';
import path from 'path';
import type { NativeSessionItem } from './types.js';

export type NativeRuntime = 'claude' | 'commandcode' | 'opencode' | 'antigravity';

export const NATIVE_RUNTIMES: readonly NativeRuntime[] = ['claude', 'commandcode', 'opencode', 'antigravity'];

/** Per-directory-level readdir cap: bound the walk even on pathological stores. */
export const MAX_ENTRIES_PER_ROOT = 2000;
/** Bounded read for preview extraction. */
const PREVIEW_MAX_BYTES = 64 * 1024;

export interface NativeScanRoots {
  claudeProjectsDir?: string;
  commandCodeCliHomeDir?: string;
  commandCodeNativeHomeDir?: string;
  opencodeStorageDir?: string;
  antigravityConversationsDir?: string;
}

export interface NativeKnownSets {
  /** native claude session id (file base name) → registry entry id */
  claudeSessionIds: Map<string, string>;
  /** native commandcode session id → registry entry id */
  commandCodeNativeSessionIds: Map<string, string>;
  /** native opencode session id → registry entry id */
  opencodeSessionIds: Map<string, string>;
  /** native antigravity conversation id → registry entry id */
  antigravityConversationIds: Map<string, string>;
}

export interface NativeScanInput {
  runtimes: NativeRuntime[];
  limit: number;
  since?: Date;
  roots: NativeScanRoots;
  known: NativeKnownSets;
}

export interface NativeScanResult {
  items: NativeSessionItem[];
  truncated: boolean;
  scannedRoots: Array<{ runtime: string; root: string; considered: number }>;
}

interface RawItem {
  runtime: NativeRuntime;
  nativePath: string;
  mtimeMs: number;
  size: number;
  cwd?: string;
  preview?: string;
  knownId?: string;
}

/** Best-effort decode of an encoded project directory name. Both claude
 *  (`-root-proj`) and commandcode (`root-proj`) encode path separators as
 *  dashes, which is lossy when a directory name itself contains a dash — so a
 *  decode is only reported when the resulting path actually exists on disk
 *  (see verifyDecodedCwd); otherwise the cwd field is omitted entirely rather
 *  than reporting a plausible-looking wrong path. */
function decodeProjectDir(name: string): string | undefined {
  const stripped = name.replace(/^-+/, '');
  if (!stripped) return undefined;
  return '/' + stripped.split('-').filter(Boolean).join('/');
}

/** Report a decoded cwd only when that directory really exists. */
async function verifyDecodedCwd(decoded: string | undefined): Promise<string | undefined> {
  if (!decoded) return undefined;
  try {
    const st = await fs.stat(decoded);
    return st.isDirectory() ? decoded : undefined;
  } catch {
    return undefined;
 }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractUserText(line: Record<string, unknown>): string | undefined {
  const message = line.message as { role?: unknown; content?: unknown } | undefined;
  const content = message?.content ?? line.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    }
  }
  return undefined;
}

/** Bounded read of the first PREVIEW_MAX_BYTES of a file. */
async function readHead(filePath: string): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(PREVIEW_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, PREVIEW_MAX_BYTES, 0);
      if (bytesRead === 0) return null;
      return buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Parse newline-delimited JSON from a bounded head; tolerates a truncated
 *  final line (the common case for a large session file). */
function parseJsonlHead(head: string): Array<Record<string, unknown>> {
  const lines = head.split('\n');
  if (lines.length > 1) lines.pop(); // drop possibly-truncated tail line
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(0, 80)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // skip malformed line
    }
  }
  return parsed;
}

async function previewFromClaudeStyleJsonl(filePath: string): Promise<{ preview?: string; cwd?: string }> {
  const head = await readHead(filePath);
  if (!head) return {};
  const lines = parseJsonlHead(head);
  let title: string | undefined;
  let userText: string | undefined;
  let cwd: string | undefined;
  for (const line of lines) {
    if (!title && line.type === 'custom-title' && typeof line.customTitle === 'string' && line.customTitle.trim()) {
      title = line.customTitle.trim();
    }
    if (!userText && (line.type === 'user' || (line.message as { role?: unknown } | undefined)?.role === 'user')) {
      userText = extractUserText(line);
    }
    if (!cwd && typeof line.cwd === 'string' && line.cwd.startsWith('/')) {
      cwd = line.cwd;
    }
  }
  return { preview: title ?? userText, cwd };
}

async function previewFromCommandCodeJsonl(filePath: string): Promise<{ preview?: string }> {
  const head = await readHead(filePath);
  if (!head) return {};
  const lines = parseJsonlHead(head);
  for (const line of lines) {
    if (typeof line.prompt === 'string' && line.prompt.trim()) return { preview: line.prompt.trim() };
    const text = extractUserText(line);
    if (text) return { preview: text };
  }
  return {};
}

/** Shared stat+classify step for one candidate file. */
async function statItem(runtime: NativeRuntime, filePath: string): Promise<RawItem | null> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return null;
    return { runtime, nativePath: filePath, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Readdir bounded; a missing root is an empty listing, not an error. */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.slice(0, MAX_ENTRIES_PER_ROOT);
  } catch {
    return [];
  }
}

async function scanClaude(root: string | undefined): Promise<RawItem[]> {
  if (!root) return [];
  const items: RawItem[] = [];
  for (const projectDir of await safeReaddir(root)) {
    for (const fileName of await safeReaddir(path.join(root, projectDir))) {
      if (!fileName.endsWith('.jsonl')) continue;
      const fullPath = path.join(root, projectDir, fileName);
      const item = await statItem('claude', fullPath);
      if (!item) continue;
      item.knownId = fileName.replace(/\.jsonl$/, '');
      const { preview, cwd: fileCwd } = await previewFromClaudeStyleJsonl(fullPath);
      item.preview = preview;
      item.cwd = fileCwd ?? (await verifyDecodedCwd(decodeProjectDir(projectDir)));
      items.push(item);
    }
  }
  return items;
}

async function scanCommandCode(roots: { cliHome?: string; nativeHome?: string }): Promise<RawItem[]> {
  const items: RawItem[] = [];

  const scanProjectsDir = async (projectsDir: string | undefined): Promise<void> => {
    if (!projectsDir) return;
    for (const projectDir of await safeReaddir(projectsDir)) {
      for (const fileName of await safeReaddir(path.join(projectsDir, projectDir))) {
        // Session transcripts are exactly <uuid>.jsonl; skip .checkpoints.jsonl etc.
        const base = fileName.replace(/\.jsonl$/, '');
        if (!fileName.endsWith('.jsonl') || !UUID_RE.test(base)) continue;
        const fullPath = path.join(projectsDir, projectDir, fileName);
        const item = await statItem('commandcode', fullPath);
        if (!item) continue;
        item.knownId = base;
        item.cwd = await verifyDecodedCwd(decodeProjectDir(projectDir));
        const { preview } = await previewFromCommandCodeJsonl(fullPath);
        item.preview = preview;
        items.push(item);
      }
    }
  };

  // Plain CLI sessions: <cliHome>/projects/<encoded-cwd>/<uuid>.jsonl
  if (roots.cliHome) await scanProjectsDir(path.join(roots.cliHome, 'projects'));
  // Server-spawned sessions: <nativeHome>/<internalId>/.commandcode/projects/<encoded-cwd>/<uuid>.jsonl
  if (roots.nativeHome) {
    for (const internalId of await safeReaddir(roots.nativeHome)) {
      await scanProjectsDir(path.join(roots.nativeHome, internalId, '.commandcode', 'projects'));
    }
  }
  return items;
}

interface OpencodeSessionJson {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  directory?: unknown;
  time?: { created?: unknown; updated?: unknown };
}

async function scanOpencode(root: string | undefined): Promise<RawItem[]> {
  if (!root) return [];
  const items: RawItem[] = [];
  const sessionRoot = path.join(root, 'session');
  for (const projectDir of await safeReaddir(sessionRoot)) {
    for (const fileName of await safeReaddir(path.join(sessionRoot, projectDir))) {
      if (!fileName.startsWith('ses_') || !fileName.endsWith('.json')) continue;
      const fullPath = path.join(sessionRoot, projectDir, fileName);
      const item = await statItem('opencode', fullPath);
      if (!item) continue;
      item.knownId = fileName.replace(/\.json$/, '');
      // The session JSON is small and self-describing; read it bounded.
      try {
        const handle = await fs.open(fullPath, 'r');
        try {
          const buffer = Buffer.alloc(PREVIEW_MAX_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, PREVIEW_MAX_BYTES, 0);
          const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf-8')) as OpencodeSessionJson;
          if (typeof parsed.title === 'string' && parsed.title.trim()) item.preview = parsed.title.trim();
          else if (typeof parsed.slug === 'string' && parsed.slug.trim()) item.preview = parsed.slug.trim();
          if (typeof parsed.directory === 'string' && parsed.directory.startsWith('/')) item.cwd = parsed.directory;
          const updated = typeof parsed.time?.updated === 'number' ? parsed.time.updated : undefined;
          const created = typeof parsed.time?.created === 'number' ? parsed.time.created : undefined;
          if (updated || created) item.mtimeMs = Math.max(updated ?? 0, created ?? 0);
        } finally {
          await handle.close();
        }
      } catch {
        // Keep the stat-only item when the JSON cannot be read.
      }
      items.push(item);
    }
  }
  return items;
}

async function scanAntigravity(root: string | undefined): Promise<RawItem[]> {
  if (!root) return [];
  const items: RawItem[] = [];
  for (const fileName of await safeReaddir(root)) {
    const base = fileName.replace(/\.db$/, '');
    if (!fileName.endsWith('.db') || !UUID_RE.test(base)) continue;
    const fullPath = path.join(root, fileName);
    const item = await statItem('antigravity', fullPath);
    if (!item) continue;
    item.knownId = base;
    items.push(item);
  }
  return items;
}

export async function scanNativeSessions(input: NativeScanInput): Promise<NativeScanResult> {
  const { runtimes, limit, since, roots, known } = input;
  const scannedRoots: NativeScanResult['scannedRoots'] = [];
  let raw: RawItem[] = [];

  const collect = async (runtime: NativeRuntime, root: string | undefined, scan: (root: string | undefined) => Promise<RawItem[]>): Promise<void> => {
    if (!runtimes.includes(runtime)) return;
    if (!root) return;
    const items = await scan(root);
    scannedRoots.push({ runtime, root, considered: items.length });
    raw = raw.concat(items);
  };

  await collect('claude', roots.claudeProjectsDir, scanClaude);
  await collect('commandcode', roots.commandCodeCliHomeDir ?? roots.commandCodeNativeHomeDir, () =>
    scanCommandCode({ cliHome: roots.commandCodeCliHomeDir, nativeHome: roots.commandCodeNativeHomeDir }));
  await collect('opencode', roots.opencodeStorageDir, scanOpencode);
  await collect('antigravity', roots.antigravityConversationsDir, scanAntigravity);

  raw.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (since) raw = raw.filter((item) => item.mtimeMs >= since.getTime());

  const truncated = raw.length > limit;
  const page = raw.slice(0, limit);

  const items: NativeSessionItem[] = page.map((item) => {
    const knownId = item.knownId ?? '';
    let knownInRegistry = false;
    let registrySessionId: string | undefined;
    if (item.runtime === 'claude' && known.claudeSessionIds.has(knownId)) {
      knownInRegistry = true;
      registrySessionId = known.claudeSessionIds.get(knownId);
    } else if (item.runtime === 'commandcode' && known.commandCodeNativeSessionIds.has(knownId)) {
      knownInRegistry = true;
      registrySessionId = known.commandCodeNativeSessionIds.get(knownId);
    } else if (item.runtime === 'opencode' && known.opencodeSessionIds.has(knownId)) {
      knownInRegistry = true;
      registrySessionId = known.opencodeSessionIds.get(knownId);
    } else if (item.runtime === 'antigravity' && known.antigravityConversationIds.has(knownId)) {
      knownInRegistry = true;
      registrySessionId = known.antigravityConversationIds.get(knownId);
    }
    return {
      runtime: item.runtime,
      nativePath: item.nativePath,
      mtime: new Date(item.mtimeMs).toISOString(),
      size: item.size,
      ...(item.cwd ? { cwd: item.cwd } : {}),
      knownInRegistry,
      ...(registrySessionId ? { registrySessionId } : {}),
      ...(item.preview ? { preview: item.preview } : {}),
    };
  });

  return { items, truncated, scannedRoots };
}
