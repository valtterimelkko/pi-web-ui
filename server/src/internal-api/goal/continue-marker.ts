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
 *               before acceptance); never touches a consumed marker.
 *   confirm() — the distinct VERIFIED state (correction 03 C4): written only
 *               after the continue's verification succeeded; R5 suppression
 *               requires it.
 *
 * Correction 03 C1: a count-0 claim found later (any age) is NEVER replayed —
 * claim() reports it as consumed (count 1). A corrupt marker file is likewise
 * reported consumed, never silent. There is no takeover.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InterruptionSource, TransientCause } from './transient-cause.js';

export type ContinueMarkerState = 'claimed' | 'delivered' | 'confirmed';

export interface ContinueMarker {
  sessionId: string;
  fingerprint: string;
  cause: TransientCause;
  source: InterruptionSource;
  /** 0 = claimed (dispatch in flight), 1 = dispatched (delivered/confirmed/consumed). */
  count: number;
  claimedAt: number;
  continuedAt?: number;
  /** C4: 'confirmed' only after the continue's verification succeeded. */
  state?: ContinueMarkerState;
  /** Set when the marker file was corrupt on disk (treated as consumed). */
  corrupt?: boolean;
}

export interface ContinueMarkerStore {
  /** Exclusive atomic claim. `claimed: false` carries the existing marker — a found count-0 claim (any age) or a corrupt file is reported CONSUMED (count 1), never replayed. */
  claim(sessionId: string, fingerprint: string, cause: TransientCause, source: InterruptionSource): Promise<{ claimed: true; marker: ContinueMarker } | { claimed: false; existing: ContinueMarker }>;
  /** Claim holder: mark the continue DELIVERED (accepted or ambiguous; idempotent; continuedAt stable). */
  commit(sessionId: string, fingerprint: string): Promise<void>;
  /** C4: mark the delivered continue VERIFIED (idempotent). */
  confirm(sessionId: string, fingerprint: string): Promise<void>;
  /** True when the session+goal has a CONFIRMED continue (C4). */
  hasConfirmedContinue(sessionId: string, fingerprint: string): Promise<boolean>;
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
        // Correction 03 C1: a found claim (any age) is never replayed — report
        // it consumed so the sweep makes the stop visible instead.
        return { claimed: false, existing: existing.count >= 1 ? existing : { ...existing, count: 1 } };
      }
      const marker: ContinueMarker = { sessionId, fingerprint, cause, source, count: 0, claimedAt: now(), state: 'claimed' };
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
          // A corrupt file (unreadable) counts as consumed, never silent.
          const reread = await readMarker(file);
          if (reread) return { claimed: false, existing: reread.count >= 1 ? reread : { ...reread, count: 1 } };
          return { claimed: false, existing: { sessionId, fingerprint, cause, source, count: 1, claimedAt: now(), corrupt: true } };
        }
        throw error;
      }
    },

    async commit(sessionId, fingerprint) {
      const file = markerPath(dir, sessionId, fingerprint);
      const marker = await readMarker(file);
      if (!marker) return;
      if (marker.count >= 1 && marker.state === 'delivered') return; // idempotent
      marker.count = 1;
      marker.continuedAt = marker.continuedAt ?? now();
      marker.state = 'delivered';
      await fs.writeFile(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
    },

    async confirm(sessionId, fingerprint) {
      const file = markerPath(dir, sessionId, fingerprint);
      const marker = await readMarker(file);
      if (!marker) return;
      if (marker.state === 'confirmed') return;
      marker.count = Math.max(marker.count, 1);
      marker.continuedAt = marker.continuedAt ?? now();
      marker.state = 'confirmed';
      await fs.writeFile(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
    },

    async hasConfirmedContinue(sessionId, fingerprint) {
      const marker = await readMarker(markerPath(dir, sessionId, fingerprint));
      return marker !== null && marker.state === 'confirmed';
    },

    async release(sessionId, fingerprint) {
      const file = markerPath(dir, sessionId, fingerprint);
      const marker = await readMarker(file);
      if (!marker || marker.count >= 1 || marker.state === 'confirmed') return; // never undo a consumed/confirmed once
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
