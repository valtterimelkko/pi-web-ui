/**
 * D0 group keying (01-answer.md amendment C): a session-bound spawn gets its session's
 * group; a spawn that is not session-bound gets a group of its own, never a group shared
 * by unrelated children. Names are deterministic per session (sanitised id + short hash
 * of the raw id, so ids that sanitise to the same string still get different groups) and
 * recomputable at dispose time without server state.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { PlacementConfig } from './config.js';

const MAX_SANITISED = 48;

export type GroupKind = 'pi' | 'rt' | 'own';

/** Keep only cgroup-directory-safe characters; collapse separators and dot-runs. */
export function sanitiseId(raw: string, maxLen = MAX_SANITISED): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned.slice(0, maxLen) || 'x';
}

function shortHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
}

/** Deterministic group name for a session-bound group; recomputable at dispose. */
export function sessionGroupName(kind: 'pi' | 'rt', runtime: string | undefined, rawId: string): string {
  const prefix = kind === 'pi' ? 'pi' : `rt-${sanitiseId(runtime ?? 'x', 16)}`;
  return `${prefix}-${sanitiseId(rawId)}-${shortHash(rawId)}`;
}

/**
 * Correction 09: the ONLY group-name shapes the server ever creates under the
 * tools root (`pi-…`, `rt-…`, `own-…`). The startup sweep must never touch any
 * other cgroup a slice may legitimately hold — e.g. systemd's own `*.service`
 * directories (killing the slice holder tears the slice down and empties its
 * `cgroup.subtree_control`, which is exactly the correction-09 live-check failure).
 */
export function isManagedGroupName(name: string): boolean {
  return /^(pi-|rt-|own-)/.test(name);
}

/** Fresh group for a spawn that is not session-bound (unique per call). */
export function ownGroupName(random: (n: number) => Buffer = randomBytes): string {
  return `own-${random(6).toString('hex')}`;
}

/**
 * Absolute cgroup path for a group name, or `undefined` when the name would place the
 * group outside the tools root (containment: the resolved path must stay inside the
 * resolved root, and the name must be a single path segment).
 */
export function groupPath(cfg: PlacementConfig, name: string): string | undefined {
  const root = cfg.toolsRoot;
  if (!root || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return undefined;
  const resolvedRoot = path.resolve(root);
  const joined = path.resolve(resolvedRoot, name);
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) return undefined;
  return joined;
}
