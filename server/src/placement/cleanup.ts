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
import { getActivePlacementConfig } from './apply-startup.js';

export interface CgroupIo {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  /** cgroupfs semantics: reading controller files works; unlinking them does not. */
  readFileSync(p: string): string;
  writeFileSync(p: string, s: string): void;
  /** cgroupfs semantics: unlinking a controller file throws (EPERM) — never used on files. */
  rmSync(p: string): void;
  /** rmdir a (now-empty) child cgroup directory. */
  rmdirSync(p: string): void;
  mkdirSync(p: string): void;
}

export const realCgroupIo: CgroupIo = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, s) => fs.writeFileSync(p, s),
  rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
  rmdirSync: (p) => fs.rmdirSync(p),
  mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
};

export interface CgroupRemovalResult {
  removed: boolean;
  /** Health-visible count of failed kill/wait/rmdir steps. */
  failures: number;
}

function sleepSync(ms: number): void {
  // Atomics.wait on the agent's own thread: a real (event-loop-blocking) sleep of a
  // few 10s of ms while the kernel reaps the killed group — bounded by the caller.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

function procsEmpty(io: CgroupIo, groupPathAbs: string): boolean {
  try {
    return io.readFileSync(path.join(groupPathAbs, 'cgroup.procs')).trim() === '';
  } catch {
    return true; // file gone = group gone
  }
}

/**
 * Depth-first rmdir of CHILD CGROUP DIRECTORIES only. Controller files are virtual
 * and cannot be unlinked (correction-06 finding 2) — they are never touched; a child
 * directory is anything containing `cgroup.procs`.
 */
function rmdirChildCgroups(io: CgroupIo, dir: string, failures: { n: number }): void {
  let entries: string[] = [];
  try {
    entries = io.readdirSync(dir);
  } catch {
    return; // gone
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (io.existsSync(path.join(full, 'cgroup.procs'))) {
      rmdirChildCgroups(io, full, failures);
    }
  }
  try {
    io.rmdirSync(dir);
  } catch {
    failures.n += 1;
  }
}

/**
 * Correction-06 finding 2 (major): cgroup-aware removal. `cgroup.kill`, then wait
 * (bounded) for `cgroup.procs` to empty, then depth-first rmdir of child cgroup
 * directories — never a recursive unlink of cgroupfs, where controller files cannot
 * be removed and the errors would be swallowed (stale groups piled up).
 */
export async function removeGroup(io: CgroupIo, groupPathAbs: string, timeoutMs = 2000): Promise<CgroupRemovalResult> {
  let failures = 0;
  if (!killGroup(io, groupPathAbs)) {
    if (!io.existsSync(groupPathAbs)) return { removed: false, failures };
    failures += 1;
  }
  const deadline = Date.now() + timeoutMs;
  while (!procsEmpty(io, groupPathAbs) && Date.now() < deadline) {
    sleepSync(25);
  }
  const populated = !procsEmpty(io, groupPathAbs);
  if (populated) {
    // One failure per group: the kill did not empty it in time; do not attempt
    // (and do not double-count) the rmdir of a populated group.
    failures += 1;
    return { removed: false, failures };
  }
  rmdirChildCgroups(io, groupPathAbs, { n: failures });
  // rmdirChildCgroups removes the group directory itself (it IS a cgroup dir)
  const removed = !io.existsSync(groupPathAbs);
  if (!removed) failures += 1;
  return { removed, failures };
}

/**
 * Kill and remove a Pi session's tools group. Deterministic key (recomputable at
 * dispose); best-effort and a no-op when placement is off.
 */
export async function removeSessionGroup(cfg: PlacementConfig | null, sessionId: string, io: CgroupIo = realCgroupIo): Promise<CgroupRemovalResult> {
  // Correction-06 finding 1 / correction-08 finding 1: consumers read the APPLIED
  // (resolved + verified) config — a slice NAME in the raw env config never yields
  // a root, so spawn/consumer paths must not re-resolve.
  const rc = getActivePlacementConfig() ?? cfg;
  if (!rc || !rc.enabled || !rc.toolsRoot) return { removed: false, failures: 0 };
  const p = groupPath(rc, sessionGroupName('pi', undefined, sessionId));
  return p ? removeGroup(io, p) : { removed: false, failures: 0 };
}

/**
 * Kill and remove every group directly under the tools root. Used at startup
 * (amendment B: remove ALL pre-existing groups — no in-process owner survives a
 * restart) and on graceful shutdown (children's commands must not outlive the server).
 * Returns the number of groups removed and the health-visible failure count.
 */
export async function sweepAllGroups(io: CgroupIo, cfg: PlacementConfig): Promise<{ removed: number; failures: number }> {
  const root = cfg.toolsRoot;
  if (!root || !io.existsSync(root)) return { removed: 0, failures: 0 };
  let removed = 0;
  let failures = 0;
  for (const name of io.readdirSync(root)) {
    const p = path.join(root, name);
    // Only CHILD CGROUP entries are groups: a child cgroup directory contains
    // `cgroup.procs`; the root's kernel control files are skipped entirely (they
    // must never be counted as stale groups — correction-06 review round 2).
    if (!io.existsSync(p) || !io.existsSync(path.join(p, 'cgroup.procs'))) continue;
    const r = await removeGroup(io, p);
    if (r.removed) removed += 1;
    failures += r.failures;
  }
  return { removed, failures };
}
