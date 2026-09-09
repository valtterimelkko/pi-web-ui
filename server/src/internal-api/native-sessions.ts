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
  /** Exclusive upper bound on mtime (ISO or epoch ms) — the paging cursor for
   *  walking past the 200-item limit: pass the oldest mtime of the previous
   * page to fetch the next-older page without overlap. */
  before?: Date;
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

export async function previewFromClaudeStyleJsonl(filePath: string): Promise<{ preview?: string; cwd?: string }> {
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

export async function previewFromCommandCodeJsonl(filePath: string): Promise<{ preview?: string }> {
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

// ── Contract 1.40.0: native artefact resolution for adopt-native ────────────

export interface NativeArtifactResolution {
  runtime: NativeRuntime;
  nativePath: string;
  mtimeMs: number;
  size: number;
  /** Best-effort first user message (claude/commandcode/opencode). */
  preview?: string;
  /** Working directory when the artefact self-describes one (claude/opencode). */
  fileCwd?: string;
  /** Bounded JSONL line count (claude/commandcode); undefined when skipped. */
  messageCount?: number;
}

/** Encode a cwd into the project-directory name convention shared by the
 *  claude and commandcode CLI stores (path separators → dashes; lossy, so
 *  resolution also tries the leading-dash variant claude writes). */
export function encodeProjectDirName(cwd: string): string {
  return cwd.split(path.sep).filter(Boolean).join('-');
}

/** stat a candidate path only if it is strictly contained in root. */
async function containedStat(root: string, ...parts: string[]): Promise<{ nativePath: string; mtimeMs: number; size: number } | null> {
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, ...parts);
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) return null;
  try {
    const st = await fs.stat(candidate);
    if (!st.isFile()) return null;
    return { nativePath: candidate, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Bounded JSONL line count (≤5 MiB read); undefined when skipped or unreadable. */
async function boundedLineCount(filePath: string, size: number): Promise<number | undefined> {
  if (size > 5 * 1024 * 1024) return undefined;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

interface OpencodeMeta { preview?: string; fileCwd?: string; mtimeMs?: number }

/** Read the small self-describing opencode session JSON (shared by scan + adopt). */
async function readOpencodeMeta(filePath: string): Promise<OpencodeMeta> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(PREVIEW_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, PREVIEW_MAX_BYTES, 0);
      const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf-8')) as OpencodeSessionJson;
      const meta: OpencodeMeta = {};
      if (typeof parsed.title === 'string' && parsed.title.trim()) meta.preview = parsed.title.trim();
      else if (typeof parsed.slug === 'string' && parsed.slug.trim()) meta.preview = parsed.slug.trim();
      if (typeof parsed.directory === 'string' && parsed.directory.startsWith('/')) meta.fileCwd = parsed.directory;
      const updated = typeof parsed.time?.updated === 'number' ? parsed.time.updated : undefined;
      const created = typeof parsed.time?.created === 'number' ? parsed.time.created : undefined;
      if (updated || created) meta.mtimeMs = Math.max(updated ?? 0, created ?? 0);
      return meta;
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
}

/** Resolve one native session artefact on disk for adopt-native. Mirrors the
 *  discovery layouts above; every candidate is containment-checked against its
 *  runtime root before any read. Returns null when the artefact does not exist.
 *  `cwd` (when given) narrows claude/commandcode to that project directory,
 *  with a bounded cross-project fallback scan so a mismatched encoding still
 *  resolves exactly one artefact. */
export async function resolveNativeSessionArtifact(input: {
  runtime: NativeRuntime;
  nativeId: string;
  cwd?: string;
  roots: NativeScanRoots;
}): Promise<NativeArtifactResolution | null> {
  const { runtime, nativeId, cwd, roots } = input;

  const claudeStyle = async (
    projectsRoot: string | undefined,
    extraProjectsRoots: Array<() => Promise<string[]>> = [],
  ): Promise<NativeArtifactResolution | null> => {
    if (!projectsRoot) return null;
    const direct: Array<{ nativePath: string; mtimeMs: number; size: number }> = [];
    if (cwd) {
      const encoded = encodeProjectDirName(cwd);
      for (const dir of [encoded, `-${encoded}`]) {
        const hit = await containedStat(projectsRoot, dir, `${nativeId}.jsonl`);
        if (hit) { direct.push(hit); break; }
      }
    }
    let hit = direct[0] ?? null;
    if (!hit) {
      // Bounded fallback: scan project dirs for the exact file name.
      const projectDirs = await safeReaddir(projectsRoot);
      for (const dir of projectDirs) {
        const found = await containedStat(projectsRoot, dir, `${nativeId}.jsonl`);
        if (found) { hit = found; break; }
      }
    }
    if (!hit) {
      for (const more of extraProjectsRoots) {
        for (const projectsDir of await more()) {
          const projectDirs = await safeReaddir(projectsDir);
          for (const dir of projectDirs) {
            const found = await containedStat(projectsDir, dir, `${nativeId}.jsonl`);
            if (found) { hit = found; break; }
          }
          if (hit) break;
        }
        if (hit) break;
      }
    }
    if (!hit) return null;
    const { preview, cwd: fileCwd } = await previewFromClaudeStyleJsonl(hit.nativePath);
    return {
      runtime,
      nativePath: hit.nativePath,
      mtimeMs: hit.mtimeMs,
      size: hit.size,
      ...(preview ? { preview } : {}),
      ...(fileCwd ? { fileCwd } : {}),
      ...(runtime === 'claude' ? { messageCount: (await boundedLineCount(hit.nativePath, hit.size)) ?? undefined } : {}),
    };
  };

  switch (runtime) {
    case 'claude':
      return claudeStyle(roots.claudeProjectsDir);
    case 'commandcode': {
      if (!UUID_RE.test(nativeId)) return null;
      const nativeHomeProjects = async (): Promise<string[]> => {
        if (!roots.commandCodeNativeHomeDir) return [];
        const internalIds = await safeReaddir(roots.commandCodeNativeHomeDir);
        return internalIds.map((id) => path.join(roots.commandCodeNativeHomeDir!, id, '.commandcode', 'projects'));
      };
      const cliProjects = roots.commandCodeCliHomeDir ? path.join(roots.commandCodeCliHomeDir, 'projects') : undefined;
      const resolved = await claudeStyle(cliProjects, [nativeHomeProjects]);
      if (!resolved) return null;
      const { preview } = await previewFromCommandCodeJsonl(resolved.nativePath);
      const count = await boundedLineCount(resolved.nativePath, resolved.size);
      return { ...resolved, ...(preview ? { preview } : {}), messageCount: count };
    }
    case 'opencode': {
      if (!roots.opencodeStorageDir || !nativeId.startsWith('ses_')) return null;
      const sessionRoot = path.join(roots.opencodeStorageDir, 'session');
      let hit: { nativePath: string; mtimeMs: number; size: number } | null = null;
      if (cwd) {
        const encoded = encodeProjectDirName(cwd);
        for (const dir of [encoded, `-${encoded}`]) {
          const found = await containedStat(sessionRoot, dir, `${nativeId}.json`);
          if (found) { hit = found; break; }
        }
      }
      if (!hit) {
        for (const dir of await safeReaddir(sessionRoot)) {
          const found = await containedStat(sessionRoot, dir, `${nativeId}.json`);
          if (found) { hit = found; break; }
        }
      }
      if (!hit) return null;
      const meta = await readOpencodeMeta(hit.nativePath);
      return {
        runtime,
        nativePath: hit.nativePath,
        mtimeMs: meta.mtimeMs ?? hit.mtimeMs,
        size: hit.size,
        ...(meta.preview ? { preview: meta.preview } : {}),
        ...(meta.fileCwd ? { fileCwd: meta.fileCwd } : {}),
      };
    }
    case 'antigravity': {
      if (!UUID_RE.test(nativeId) || !roots.antigravityConversationsDir) return null;
      const hit = await containedStat(roots.antigravityConversationsDir, `${nativeId}.db`);
      if (!hit) return null;
      return { runtime, nativePath: hit.nativePath, mtimeMs: hit.mtimeMs, size: hit.size };
    }
  }
}

export async function scanNativeSessions(input: NativeScanInput): Promise<NativeScanResult> {
  const { runtimes, limit, since, before, roots, known } = input;
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
  if (before) raw = raw.filter((item) => item.mtimeMs < before.getTime());

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
