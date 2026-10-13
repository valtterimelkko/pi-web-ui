/**
 * Contract 1.62.0 (PARENT-ORCHESTRATION-MACHINERY-PLAN W2-a) — stable goalId.
 *
 * A parent that re-uses a child for a second goal was woken by the FIRST goal's
 * clear: `goal_end` carried no identity. Every goal_state / goal_end now carries
 * a top-level `goalId` (watch `dataMatch` is shallow), minted once per goal
 * start, runtime-neutral, and persisted so it survives restarts.
 *
 * The id is minted from observations of the canonical projection rather than
 * inside each runtime adapter, so all five runtimes share one rule:
 *  - an ACTIVE projection (running/paused/wrapping_up) whose fingerprint
 *    (objective + startedAt) differs from the recorded goal — or that follows an
 *    explicit `rotate()` from a start handler — is a NEW goal and mints a new id;
 *  - a TERMINAL projection (achieved/failed/cleared) and an idle one belong to
 *    the recorded goal and carry ITS id (the clear of an old goal carries the
 *    old id), unless the recorded goal was rotated away or the terminal
 *    projection's startedAt proves it is a different goal;
 *  - `unknown`/`suggested`/unsupported projections never mint.
 * Keys are broker keys (Pi: sessionPath; other runtimes: the registry id).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionGoalProjection } from './types.js';

export interface GoalIdRecord {
  goalId: string;
  fingerprint: string;
  startedAt?: number | null;
  /** True after rotate(): the next active/terminal observation is a new goal. */
  rotated?: boolean;
  mintedAt: number;
}

export interface GoalIdStore {
  /** Returns the projection with `goalId` stamped (a copy; the input is never mutated). */
  stamp<T extends SessionGoalProjection>(key: string, projection: T): T;
  /** A goal start is about to happen: the next observed goal is a new one. */
  rotate(key: string): void;
  get(key: string): GoalIdRecord | undefined;
}

export interface GoalIdStoreOptions {
  /** Persist records under this directory (sync, tiny files). In-memory when omitted. */
  dir?: string;
  now?: () => number;
}

const ACTIVE = new Set(['running', 'paused', 'wrapping_up']);
const TERMINAL = new Set(['achieved', 'failed', 'cleared']);

function safeName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)}.${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

function fingerprintOf(p: SessionGoalProjection): string {
  return createHash('sha256').update(`${p.objective ?? ''}\n${p.startedAt ?? ''}`).digest('hex');
}

function mintId(): string {
  return `goal_${randomBytes(8).toString('hex')}`;
}

export function createGoalIdStore(options: GoalIdStoreOptions = {}): GoalIdStore {
  const now = options.now ?? Date.now;
  const cache = new Map<string, GoalIdRecord>();
  const fileFor = (key: string): string | undefined => (options.dir ? path.join(options.dir, `${safeName(key)}.json`) : undefined);

  function load(key: string): GoalIdRecord | undefined {
    const hit = cache.get(key);
    if (hit) return hit;
    const file = fileFor(key);
    if (!file) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as GoalIdRecord;
      if (parsed && typeof parsed.goalId === 'string' && typeof parsed.fingerprint === 'string') {
        cache.set(key, parsed);
        return parsed;
      }
    } catch { /* missing/corrupt: treated as no record */ }
    return undefined;
  }

  function save(key: string, record: GoalIdRecord): void {
    cache.set(key, record);
    const file = fileFor(key);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* persistence is best-effort; the in-memory id still holds */ }
  }

  function mint(key: string, p: SessionGoalProjection): GoalIdRecord {
    const record: GoalIdRecord = { goalId: mintId(), fingerprint: fingerprintOf(p), startedAt: p.startedAt ?? null, mintedAt: now() };
    save(key, record);
    return record;
  }

  return {
    stamp(key, projection) {
      if (!projection.supported) return projection;
      const record = load(key);
      let use: GoalIdRecord | undefined = record;
      if (ACTIVE.has(projection.status)) {
        if (!record || record.rotated || record.fingerprint !== fingerprintOf(projection)) use = mint(key, projection);
      } else if (TERMINAL.has(projection.status)) {
        const differentGoal = record
          && typeof projection.startedAt === 'number'
          && typeof record.startedAt === 'number'
          && projection.startedAt !== record.startedAt;
        if (!record || record.rotated || differentGoal) use = mint(key, projection);
      }
      // idle / unknown / suggested: carry the recorded goal's id when one exists.
      if (!use) return projection;
      return { ...projection, goalId: use.goalId };
    },
    rotate(key) {
      const record = load(key);
      if (record && !record.rotated) save(key, { ...record, rotated: true });
    },
    get: load,
  };
}

// ─── Process-wide wiring (same pattern as the interruption overlay) ──────────
// Always on (in-memory) so unconfigured callers/tests still stamp; boot wiring
// swaps in a persisted store under the server-owned data root.

let activeStore: GoalIdStore = createGoalIdStore();

export function configureGoalIdStore(store: GoalIdStore): void {
  activeStore = store;
}

export function resetGoalIdStoreForTests(): void {
  activeStore = createGoalIdStore();
}

export function getGoalIdStore(): GoalIdStore {
  return activeStore;
}

/** Stamp the goalId into a goal_state / goal_end event's `data` (non-objects pass through). */
export function stampGoalEventData(store: GoalIdStore, key: string, _eventType: string, data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const projection = data as SessionGoalProjection;
  if (typeof projection.status !== 'string' || typeof projection.supported !== 'boolean') return data;
  return store.stamp(key, projection);
}
