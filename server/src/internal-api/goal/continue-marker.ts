/**
 * Wave K (contract 1.59.0) — durable once-marker store (R3).
 *
 * Server-owned: the markers live under the server's own data root beside the
 * run receipts (`<receipts-root>/goal-continue/markers/`), never inside
 * pi-enhancement's `~/.pi/agent/goal-engine/`. A marker is keyed by sessionId
 * plus the goal fingerprint (sha256 of objective + startedAt), so a NEW goal
 * start on the same session never inherits an old marker, and the auto-continue
 * happens at most once per goal instance — surviving restarts, because the
 * marker is a file.
 *
 * Lifecycle (crash-safe, at-most-once):
 *   reserve()  — count 0, written BEFORE the continue dispatch;
 *   commit()   — count 1 + continuedAt, after the dispatch is accepted;
 *   rollback() — file removed when the dispatch is refused (admission),
 *                so a refused continue does not consume the once.
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
  /** 0 = reserved (dispatch in flight), 1 = continue dispatched and accepted. */
  count: number;
  reservedAt: number;
  continuedAt?: number;
}

export interface ContinueMarkerStore {
  reserve(sessionId: string, fingerprint: string, cause: TransientCause, source: InterruptionSource): Promise<ContinueMarker>;
  commit(sessionId: string, fingerprint: string): Promise<void>;
  rollback(sessionId: string, fingerprint: string): Promise<void>;
  get(sessionId: string, fingerprint: string): Promise<ContinueMarker | null>;
  /** True when the session has a committed (count ≥ 1) continue marker. */
  hasActiveContinue(sessionId: string): Promise<boolean>;
  /** True when ANY marker exists for the session (reserved or committed). */
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

export function createContinueMarkerStore(dir: string): ContinueMarkerStore {
  return {
    async reserve(sessionId, fingerprint, cause, source) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = markerPath(dir, sessionId, fingerprint);
      const existing = await readMarker(file);
      if (existing) return existing; // idempotent: never reset a marker
      const marker: ContinueMarker = { sessionId, fingerprint, cause, source, count: 0, reservedAt: Date.now() };
      await fs.writeFile(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
      return marker;
    },

    async commit(sessionId, fingerprint) {
      const file = markerPath(dir, sessionId, fingerprint);
      const marker = await readMarker(file);
      if (!marker) return;
      marker.count = Math.max(marker.count, 1);
      marker.continuedAt = marker.continuedAt ?? Date.now();
      await fs.writeFile(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
    },

    async rollback(sessionId, fingerprint) {
      await fs.rm(markerPath(dir, sessionId, fingerprint), { force: true });
    },

    async get(sessionId, fingerprint) {
      return readMarker(markerPath(dir, sessionId, fingerprint));
    },

    async hasActiveContinue(sessionId) {
      const committed = await this.listCommitted();
      return committed.some((m) => m.sessionId === sessionId);
    },

    async hasMarker(sessionId) {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        return false;
      }
      const prefix = `${safeName(sessionId)}.`;
      const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
      return matches.length > 0;
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
