/**
 * Wave K (contract 1.59.0) — R4 interruption overlay.
 *
 * A stop that does not auto-continue must be visible at once and must not
 * invent a new top-level canonical status: the projection reads
 * `status: "paused"`, `pausedReason: "interrupted"`, with the additive
 * `interruption` object (cause, source, detectedAt, continueCount,
 * continueNote, inFlightToolCall). Every existing parent watch already
 * carries a `goal_state` `dataMatch {status:"paused"}` condition, so parents
 * are woken with no watch changes.
 *
 * The overlay record is durable (under the server's data root, R3's
 * `goal-continue/overlay/`), survives restarts, and clears when the goal file
 * changes — resume, clear, a new start, or the goal engine's own write — so a
 * parent's ordinary `POST /goal {"action":"resume"}` keeps working and the
 * projection returns to disk truth as soon as the engine speaks again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionGoalProjection } from './types.js';
import type { GoalInterruptionCause, InterruptionSource } from './transient-cause.js';
import type { InFlightToolCall } from './continue-note.js';

export interface GoalFileIdentity {
  mtimeMs: number;
  size: number;
}

export interface InterruptionOverlayRecord {
  sessionId: string;
  /** sha256(objective + startedAt); diagnostics + marker correspondence. */
  fingerprint: string;
  cause: GoalInterruptionCause;
  source: InterruptionSource;
  detectedAt: number;
  /** 0 = not continued (visible interruption), 1 = auto-continued once. */
  continueCount?: number;
  /**
   * Explicit: this overlay records an auto-continue (status stays running) —
   * never inferred from continueCount, which a second-transient overlay also
   * carries (the PAST continue count).
   */
  autoContinued?: boolean;
  continueNote?: string;
  inFlightToolCall?: InFlightToolCall | null;
  goalFile: GoalFileIdentity;
}

export interface InterruptionOverlayStore {
  set(record: InterruptionOverlayRecord): Promise<void>;
  get(sessionId: string): Promise<InterruptionOverlayRecord | null>;
  clear(sessionId: string): Promise<void>;
  list(): Promise<InterruptionOverlayRecord[]>;
}

function safeName(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

export function createInterruptionOverlayStore(dir: string): InterruptionOverlayStore {
  const fileFor = (sessionId: string): string => path.join(dir, `${safeName(sessionId)}.json`);
  return {
    async set(record) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(fileFor(record.sessionId), JSON.stringify(record, null, 2), { mode: 0o600 });
    },
    async get(sessionId) {
      try {
        const raw = await fs.readFile(fileFor(sessionId), 'utf8');
        const parsed = JSON.parse(raw) as InterruptionOverlayRecord;
        if (!parsed || typeof parsed !== 'object' || !parsed.goalFile) return null;
        return parsed;
      } catch {
        return null;
      }
    },
    async clear(sessionId) {
      await fs.rm(fileFor(sessionId), { force: true });
    },
    async list() {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        return [];
      }
      const records = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => fs.readFile(path.join(dir, f), 'utf8').then((raw) => JSON.parse(raw) as InterruptionOverlayRecord).catch(() => null)));
      return records.filter((r): r is InterruptionOverlayRecord => r !== null);
    },
  };
}

function sameIdentity(a: GoalFileIdentity, b: GoalFileIdentity): boolean {
  return Math.abs(a.mtimeMs - b.mtimeMs) < 1 && a.size === b.size;
}

export interface AutoContinueAnnotation {
  autoContinued: boolean;
}

/**
 * Pure applier. The overlay only speaks while the goal file is byte-identical
 * (mtime+size) to what was observed at detection — any engine write ends it.
 * A goal already `paused` on disk keeps its status; the overlay annotates it
 * so the interrupted cause is visible either way. An auto-continued goal stays
 * `running` (R4) and carries `interruption.autoContinued: true`.
 */
export function applyInterruptionOverlay(
  projection: SessionGoalProjection,
  overlay: InterruptionOverlayRecord,
  currentGoalFile: GoalFileIdentity | null,
  annotation?: AutoContinueAnnotation,
): SessionGoalProjection {
  if (!currentGoalFile || !sameIdentity(currentGoalFile, overlay.goalFile)) {
    return projection; // the engine has spoken since; disk truth wins
  }
  const interruption = {
    cause: overlay.cause,
    source: overlay.source,
    detectedAt: overlay.detectedAt,
    continueCount: overlay.continueCount ?? 0,
    autoContinued: annotation?.autoContinued ?? overlay.autoContinued === true,
    continueNote: overlay.continueNote,
    inFlightToolCall: overlay.inFlightToolCall ?? null,
  };
  if (interruption.autoContinued) {
    // The child was continued: its own status stands (running, achieved, …);
    // the annotation says the server carried it across the stop.
    return { ...projection, interruption };
  }
  // Not continued: surface the interruption as a pause (R4). A goal already
  // paused on disk (restore pause) gets the interrupted reason instead.
  return { ...projection, status: 'paused', pausedReason: 'interrupted', interruption };
}

// ─── Process-wide overlay wiring ────────────────────────────────────────────
// Configured once at boot (server.ts owns the data-root resolution); a plain
// projection read path without configuration behaves exactly as before.

let activeStore: InterruptionOverlayStore | null = null;

/** Boot wiring: point the overlay at the server-owned data root. */
export function configureInterruptionOverlay(store: InterruptionOverlayStore): void {
  activeStore = store;
}

/** Test wiring: build a store over a temp directory. */
export function configureInterruptionOverlayForTests(dir: string): void {
  activeStore = createInterruptionOverlayStore(path.join(dir, 'overlay'));
}

export function resetInterruptionOverlayForTests(): void {
  activeStore = null;
}

export function getInterruptionOverlayStore(): InterruptionOverlayStore | null {
  return activeStore;
}

export async function readGoalFileIdentity(goalStatePath: string): Promise<GoalFileIdentity | null> {
  try {
    const stat = await fs.stat(goalStatePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}
