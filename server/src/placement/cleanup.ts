/**
 * D0 group lifecycle (01-answer.md amendment B): systemd does not reap delegated
 * subgroups (verified in the Phase A spike), so the server owns the lifecycle.
 * Per-session removal happens in the dispose funnel; ALL groups are killed and removed
 * at server startup (nothing in-process survives a restart to re-adopt) and on graceful
 * shutdown. Everything is best-effort and tolerant of missing groups.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlacementConfig } from './config.js';
import { groupPath, sessionGroupName } from './keys.js';

export interface CgroupIo {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  writeFileSync(p: string, s: string): void;
  rmSync(p: string): void;
  mkdirSync(p: string): void;
}

export const realCgroupIo: CgroupIo = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  writeFileSync: (p, s) => fs.writeFileSync(p, s),
  rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
  mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
};

/** Write `1` to the group's `cgroup.kill`; returns false when the group is gone. */
export function killGroup(io: CgroupIo, groupPathAbs: string): boolean {
  const killFile = path.join(groupPathAbs, 'cgroup.kill');
  if (!io.existsSync(killFile)) return false;
  try {
    io.writeFileSync(killFile, '1');
    return true;
  } catch {
    return false;
  }
}

/** Kill then remove the group directory. Returns true when the directory is gone. */
export function removeGroup(io: CgroupIo, groupPathAbs: string): boolean {
  killGroup(io, groupPathAbs);
  if (!io.existsSync(groupPathAbs)) return false;
  try {
    io.rmSync(groupPathAbs);
  } catch {
    return false; // still populated (e.g. a detached task); the sweep reaps later
  }
  return true;
}

/**
 * Kill and remove a Pi session's tools group. Deterministic key (recomputable at
 * dispose); best-effort and a no-op when placement is off.
 */
export function removeSessionGroup(cfg: PlacementConfig, sessionId: string): boolean {
  if (!cfg.enabled) return false;
  const p = groupPath(cfg, sessionGroupName('pi', undefined, sessionId));
  return p ? removeGroup(realCgroupIo, p) : false;
}

/**
 * Kill and remove every group directly under the tools root. Used at startup
 * (amendment B: remove ALL pre-existing groups — no in-process owner survives a
 * restart) and on graceful shutdown (children's commands must not outlive the server).
 * Returns the number of groups removed.
 */
export function sweepAllGroups(io: CgroupIo, cfg: PlacementConfig): number {
  if (!io.existsSync(cfg.toolsRoot)) return 0;
  let removed = 0;
  for (const name of io.readdirSync(cfg.toolsRoot)) {
    const p = path.join(cfg.toolsRoot, name);
    if (!io.existsSync(p)) continue;
    killGroup(io, p);
    try {
      io.rmSync(p);
      removed += 1;
    } catch {
      /* populated; retried by the next sweep */
    }
  }
  return removed;
}
