/**
 * Wave K (contract 1.59.0) — durable once-marker store (R3; correction 02 F1).
 *
 * Server-owned: the markers live under the server's own data root beside the
 * run receipts (`<receipts-root>/goal-continue/markers/`), never inside
 * pi-enhancement's `~/.pi/agent/goal-engine/`. A marker is keyed by sessionId
 * plus the goal fingerprint (sha256 of objective + startedAt), so a NEW goal
 * start on the same session never inherits an old marker.
 *
 * Exactly-once is enforced ATOMICALLY (correction 02 F1):
 *   claim()   — exclusive create (`open` with `wx`): two overlapping sweeps or
 *               the live path cannot both hold the per-goal claim. A stale
 *               count-0 claim (older than the takeover age — its dispatch can
 *               no longer be in flight) is taken over atomically.
 *   commit()  — count 0 → 1 + continuedAt, by the claim holder. Ambiguous
 *               delivery (accepted / timed out / unknown) is committed: the
 *               once is consumed, never rolled back after a possible acceptance.
 *   release() — removes a count-0 claim after a DEFINITE refusal (4xx/429/503
 *               before acceptance); never touches a committed marker.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InterruptionSource, TransientCause } from './transient-cause.js';

export interface ContinueMarker {
  sessionId: string;
  fingerprint: string;
  cause: TransientCause;
  source: InterruptionSource;
  /** 0 = claimed (dispatch in flight), 1 = continue dispatched and accepted (or ambiguous → consumed). */
  count: number;
  claimedAt: number;
  continuedAt?: number;
}

export interface ContinueMarkerStore {
  /** Exclusive atomic claim. `claimed: false` carries the existing marker. */
  claim(sessionId: string, fingerprint: string, cause: TransientCause, source: InterruptionSource): Promise<{ claimed: true; marker: ContinueMarker } | { claimed: false; existing: ContinueMarker }>;
  /** Claim holder: mark the continue consumed (idempotent; continuedAt stable). */
  commit(sessionId: string, fingerprint: string): Promise<void>;
  /** Definite refusal: drop a count-0 claim. A committed marker is never removed. */
  release(sessionId: string, fingerprint: string): Promise<void>;
  get(sessionId: string, fingerprint: string): Promise<ContinueMarker | null>;
  /** All marker files for a session (any fingerprint) — for pruning. */
  listForSession(sessionId: string): Promise<ContinueMarker[]>;
  /** Remove another-goal markers for the session (stale fingerprints). */
  pruneOtherFingerprints(sessionId: string, currentFingerprint: string): Promise<number>;
  /** True when the session has a committed (count ≥ 1) marker. */
  hasActiveContinue(sessionId: string): Promise<boolean>;
  /** True when ANY marker file exists for the session (any fingerprint). */
  hasMarker(sessionId: string): Promise<boolean>;
  /** All committed continue markers (boot sweep / diagnostics). */
  listCommitted(): Promise<ContinueMarker[]>;
}

/** Goal-instance fingerprint: a new start (new objective or startedAt) never matches. */
export function goalFingerprint(objective: string | undefined, startedAt: number | null | undefined): string {
  return createHash('sha256').update(`${objective ?? ''}\n${startedAt ?? ''}`).digest('hex');
}

/** A count-0 claim older than this is abandoned (its dispatch can no longer be in flight). */
export const CLAIM_TAKEOVER_MS = 15 * 60_000;

function safeName(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function markerPath(dir: string, sessionId: string, fingerprint: string): string {
  return path.join(dir, `${safeName(sessionId)}.${fingerprint.slice(0, 16)}.json`);
}

async function readMarker(file: string): Promise<ContinueMarker | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as ContinueMarker;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.count !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ContinueMarkerStoreOptions {
  now?: () => number;
}

export function createContinueMarkerStore(dir: string, options: ContinueMarkerStoreOptions = {}): ContinueMarkerStore {
  const now = options.now ?? Date.now;
  return {
    async claim(sessionId, fingerprint, cause, source) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = markerPath(dir, sessionId, fingerprint);
      const existing = await readMarker(file);
      if (existing) {
        // A fresh count-0 claim belongs to an in-flight dispatch: never take it.
        // A stale count-0 claim (holder crashed long before any acceptance) is
        // replaced ATOMICALLY (rename over the path).
        if (existing.count === 0 && now() - existing.claimedAt > CLAIM_TAKEOVER_MS) {
          const replacement: ContinueMarker = { sessionId, fingerprint, cause, source, count: 0, claimedAt: now() };
          const tmp = `${file}.takeover-${process.pid}-${Math.random().toString(36).slice(2)}`;
          await fs.writeFile(tmp, JSON.stringify(replacement, null, 2), { mode: 0o600 });
          try {
            await fs.rename(tmp, file);
            return { claimed: true, marker: replacement };
          } catch {
            await fs.rm(tmp, { force: true });
            const reread = await readMarker(file);
            return reread
              ? { claimed: false, existing: reread }
              : { claimed: false, existing };
          }
        }
        return { claimed: false, existing };
      }
      const marker: ContinueMarker = { sessionId, fingerprint, cause, source, count: 0, claimedAt: now() };
      try {
        // Exclusive create: the atomic exactly-once primitive.
        const handle = await fs.open(file, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(marker, null, 2), 'utf8');
        } finally {
          await handle.close();
        }
        return { claimed: true, marker };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const reread = await readMarker(file);
          if (reread) return { claimed: false, existing: reread };
        }
        throw error;
      }
    },

    async commit(sessionId, fingerprint) {
      const file = markerPath(dir, sessionId, fingerprint);
      const marker = await readMarker(file);
      if (!marker) return;
      if (marker.count >= 1) return; // idempotent: continuedAt stable
      marker.count = 1;
      marker.continuedAt = marker.continuedAt ?? now();
      await fs.writeFile(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
    },

    async release(sessionId, fingerprint) {
      const file = markerPath(dir, sessionId, fingerprint);
      const marker = await readMarker(file);
      if (!marker || marker.count >= 1) return; // never undo a consumed once
      await fs.rm(file, { force: true });
    },

    async get(sessionId, fingerprint) {
      return readMarker(markerPath(dir, sessionId, fingerprint));
    },

    async listForSession(sessionId) {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        return [];
      }
      const prefix = `${safeName(sessionId)}.`;
      const markers = await Promise.all(
        files.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => readMarker(path.join(dir, f))),
      );
      return markers.filter((m): m is ContinueMarker => m !== null);
    },

    async pruneOtherFingerprints(sessionId, currentFingerprint) {
      const others = (await this.listForSession(sessionId)).filter((m) => m.fingerprint !== currentFingerprint);
      await Promise.all(others.map((m) => fs.rm(markerPath(dir, sessionId, m.fingerprint), { force: true })));
      return others.length;
    },

    async hasActiveContinue(sessionId) {
      const committed = await this.listCommitted();
      return committed.some((m) => m.sessionId === sessionId);
    },

    async hasMarker(sessionId) {
      return (await this.listForSession(sessionId)).length > 0;
    },

    async listCommitted() {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        return [];
      }
      const markers = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => readMarker(path.join(dir, f))));
      return markers.filter((m): m is ContinueMarker => m !== null && m.count >= 1);
    },
  };
}
