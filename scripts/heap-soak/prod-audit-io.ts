/**
 * Production-write audit I/O: uses `find -newer` (a single fast syscall-level
 * scan) rather than a Node.js recursive stat walk — the guarded roots
 * (~/.pi/agent: 726MB/324 dirs; ~/.pi-web-ui: 1.3GB; board-store: 98MB/22k
 * files) are far too large to walk file-by-file in JS on every gate run.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findNeedleMatches, type NeedleMatch } from '../../server/src/live-validation/heap-soak/prod-audit.js';

const execFile = promisify(execFileCb);

export const PROD_AUDIT_ROOTS = [
  path.join(homedir(), '.pi', 'agent'),
  path.join(homedir(), '.pi-web-ui'),
  '/root/agent-os/board-store',
  '/root/agent-os/memory-vault',
].filter((root) => existsSync(root));

const EXCLUDE_PATH_GLOB = '*/validation/heap-soak/*'; // our own artefacts are expected to change; not a leak signal
const MAX_FILE_BYTES_TO_GREP = 5_000_000; // skip anything bigger — binary/huge files are not soak-referencing text anyway

export interface AuditMarker {
  markerPath: string;
}

/** Touch a marker file whose mtime is the audit's "before" instant. */
export function createAuditMarker(runDir: string): AuditMarker {
  const markerPath = path.join(runDir, '.prod-audit-marker');
  writeFileSync(markerPath, '');
  return { markerPath };
}

/** `find <roots> -newer <marker> -type f`, excluding our own run-dir tree. */
export async function findChangedFilesSince(marker: AuditMarker, roots: readonly string[] = PROD_AUDIT_ROOTS): Promise<string[]> {
  if (roots.length === 0) return [];
  try {
    const { stdout } = await execFile('find', [
      ...roots,
      '-not', '-path', EXCLUDE_PATH_GLOB,
      '-type', 'f',
      '-newer', marker.markerPath,
      '-print',
    ], { maxBuffer: 50_000_000, timeout: 60_000 });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    // `find` returns non-zero if a root vanished mid-scan (e.g. a real
    // production cleanup) — still usable if stdout was captured.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === 'string') return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    throw error;
  }
}

function readBoundedFile(filePath: string): string | undefined {
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES_TO_GREP) return undefined;
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined; // gone, permission-denied, or binary — not something we can/should text-match
  }
}

/** Full audit: find files changed since the marker, then check their content for the given needles. */
export async function runProductionWriteAudit(
  marker: AuditMarker,
  needles: readonly string[],
  roots: readonly string[] = PROD_AUDIT_ROOTS,
): Promise<{ changedFileCount: number; matches: NeedleMatch[] }> {
  const changed = await findChangedFilesSince(marker, roots);
  const withContent = changed
    .map((p) => ({ path: p, content: readBoundedFile(p) }))
    .filter((f): f is { path: string; content: string } => f.content !== undefined);
  const matches = findNeedleMatches(withContent, needles);
  return { changedFileCount: changed.length, matches };
}
