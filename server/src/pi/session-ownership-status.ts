/**
 * Pi session ownership status reader (contract 1.45.0, silent no-op plan
 * Phase 4b).
 *
 * Reads the read-only ownership snapshot published by the auto-compact-75
 * extension (pi-enhancement `ownership-status.mjs`):
 *
 *   globalThis[Symbol.for("auto-compact-75:ownership-status")]
 *     → Map<canonicalSessionPath, { status, reason, ownerPid, ownerMode, updatedAt }>
 *
 * and combines it with the on-disk session lease (same path algorithm as
 * pi-enhancement `session-ownership.mjs` — a deliberate duplicated constant,
 * the established pattern from pi-goal.ts) to decide, per plan §Phase 4b and
 * owner correction C1:
 *
 *   - owned / unmanaged / unknown snapshot → proceed (unknown never gates);
 *   - conflict / uncertain with a LIVE owner (process alive AND recorded
 *     process-start identity matching — a recycled pid is a DEAD owner), or a
 *     handing-off lease → refuse with SESSION_OWNED_BY_OTHER_RUNTIME;
 *   - fenced with a dead or absent owner → attempt dispose→rehydrate recovery;
 *   - any UNCERTAIN liveness evidence fails CLOSED with a refusal.
 *
 * This module never mutates session or lease state; it only reads and decides.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const OWNERSHIP_STATUS_SYMBOL = Symbol.for('auto-compact-75:ownership-status');

export type PiOwnershipStatus = 'unknown' | 'unmanaged' | 'owned' | 'conflict' | 'uncertain';

export interface PiOwnershipSnapshot {
  status: PiOwnershipStatus;
  reason?: string;
  ownerPid?: number;
  ownerMode?: string;
  updatedAt?: number;
}

export interface PiLeaseRecord {
  pid?: number;
  pidStartIdentity?: string | null;
  state?: string;
  mode?: string;
}

export type OwnerLiveness = 'alive' | 'dead' | 'pid_reused' | 'absent' | 'uncertain';

export interface PiOwnershipGateDecision {
  action: 'proceed' | 'recover' | 'refuse_live';
  status: PiOwnershipStatus;
  reason?: string;
  ownerPid?: number;
  ownerMode?: string;
  /** The lease is in (or was last seen in) the handing_off state. */
  handoffAvailable?: boolean;
  /** Liveness evidence was ambiguous — the decision failed closed. */
  uncertain?: boolean;
}

export interface OwnershipProbes {
  processIsAlive(pid: number): boolean;
  processStartIdentity(pid: number): string | null;
}

export const defaultOwnershipProbes: OwnershipProbes = {
  processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  },
  /** Linux process start ticks (field 20 of /proc/<pid>/stat; 19 after the comm field). */
  processStartIdentity(pid: number): string | null {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fieldsFromState = stat.slice(closeParen + 2).trim().split(/\s+/u);
      return fieldsFromState[19] ?? null;
    } catch {
      return null;
    }
  },
};

function canonicalSessionPath(sessionFile: string): string {
  const absolute = path.resolve(sessionFile);
  try {
    return fs.realpathSync(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

function leaseDir(): string {
  return process.env.PI_SESSION_LEASE_DIR || path.join(os.homedir(), '.pi', 'agent', 'session-leases');
}

/** Lease path algorithm — MUST stay byte-identical with session-ownership.mjs `leasePathForSession`. */
export function piLeasePathForSession(sessionFile: string): string {
  const canonical = canonicalSessionPath(sessionFile);
  const identity = createHash('sha256').update(canonical).digest('hex');
  return path.join(leaseDir(), `${identity}.lease.json`);
}

/** Read the on-disk lease for a session; null when absent/unreadable-as-lease. */
export function readPiLeaseRecord(sessionFile: string): PiLeaseRecord | null {
  try {
    const raw = fs.readFileSync(piLeasePathForSession(sessionFile), 'utf8');
    const parsed = JSON.parse(raw) as PiLeaseRecord;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The published snapshot for a session; `unknown` when nothing is published. */
export function readPiOwnershipStatus(sessionFile: string): PiOwnershipSnapshot {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[OWNERSHIP_STATUS_SYMBOL];
  if (!(existing instanceof Map)) return { status: 'unknown' };
  const snapshot = existing.get(canonicalSessionPath(sessionFile)) as PiOwnershipSnapshot | undefined;
  if (!snapshot || typeof snapshot.status !== 'string') return { status: 'unknown' };
  return { ...snapshot, status: snapshot.status as PiOwnershipStatus };
}

/**
 * Owner correction C1: liveness is NOT `process.kill(pid, 0)` alone. A pid
 * whose recorded process-start identity no longer matches was recycled and
 * counts as DEAD. Ambiguous evidence (identity unreadable on a live-looking
 * pid, lease missing its identity) is UNCERTAIN and callers must fail closed.
 */
export function evaluateOwnerLiveness(
  lease: PiLeaseRecord | null,
  probes: OwnershipProbes = defaultOwnershipProbes,
): OwnerLiveness {
  const pid = lease?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'absent';
  const recordedIdentity = lease?.pidStartIdentity;
  if (!probes.processIsAlive(pid)) return 'dead';
  if (typeof recordedIdentity !== 'string' || recordedIdentity.length === 0) return 'uncertain';
  const current = probes.processStartIdentity(pid);
  if (current === null) return 'uncertain';
  return current === recordedIdentity ? 'alive' : 'pid_reused';
}

/**
 * Decide what a Pi ownership-aware action (prompt / goal / control) may do
 * right now. Never throws; never mutates anything.
 */
export function decidePiOwnershipAction(
  snapshot: PiOwnershipSnapshot,
  lease: PiLeaseRecord | null,
  probes: OwnershipProbes = defaultOwnershipProbes,
): PiOwnershipGateDecision {
  // The extension is not loaded / has not published: never gate (plan §Phase 4b).
  if (snapshot.status === 'unknown' || snapshot.status === 'unmanaged' || snapshot.status === 'owned') {
    return { action: 'proceed', status: snapshot.status };
  }

  const handingOff = lease?.state === 'handing_off';
  const liveness = handingOff ? 'alive' : evaluateOwnerLiveness(lease, probes);
  const base = {
    status: snapshot.status,
    reason: snapshot.reason,
    ownerPid: lease?.pid ?? snapshot.ownerPid,
    ownerMode: lease?.mode ?? snapshot.ownerMode,
    handoffAvailable: handingOff || undefined,
  };

  if (handingOff) {
    return { action: 'refuse_live', ...base, reason: snapshot.reason ?? 'session lease is offered for handoff to this runtime' };
  }
  if (liveness === 'alive') {
    return { action: 'refuse_live', ...base };
  }
  if (liveness === 'uncertain') {
    // Owner correction C1: fail closed when liveness cannot be proven either way.
    return { action: 'refuse_live', ...base, uncertain: true, reason: snapshot.reason ?? 'owner liveness could not be verified; failing closed' };
  }
  // dead, pid_reused (a recycled pid is a dead owner), or absent owner.
  return { action: 'recover', ...base };
}
