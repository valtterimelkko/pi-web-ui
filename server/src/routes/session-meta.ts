// ── v2 session-metadata model (pure, no I/O) ────────────────────────────────
//
// v2 replaces the three parallel v1 structures — `archivedSessionPaths`,
// `pinnedSessionPaths`, `sessionDisplayNames` — with a single `sessions` map
// keyed by a STABLE session identity `${runtime}:${sessionId}`.
//
//   - Pi sessions are keyed `pi:<uuid>` (the uuid in the .jsonl filename, which
//     equals the session header id), so metadata survives Pi renaming the file.
//   - Non-Pi sessions are keyed `<runtime>:<id>` (their path already IS the id).
//
// Each record carries:
//   - `updatedAt` (epoch-ms) for last-writer-wins conflict resolution across
//     devices (a briefly-offline device's newer write is no longer lost), and
//   - `legacyKey` preserving the original v1 key so the compatibility window
//     can re-derive the exact legacy arrays — a lossless round-trip.
//
// This module is pure on purpose: every function is trivially unit-testable and
// free of fs/express/registry concerns. Runtime resolution is INJECTED
// (`resolveRuntime`) so the migration stays deterministic in tests.

export type SessionRuntime = 'pi' | 'claude' | 'opencode' | 'antigravity' | 'unknown';

export interface SessionMeta {
  /** Present only when the session is archived. */
  archived?: true;
  /** Present only when the session is pinned. */
  pinned?: true;
  /** Present only when a custom display name is set. */
  displayName?: string;
  /** Epoch-ms of the last write to this record (last-writer-wins). */
  updatedAt?: number;
  /** Original v1 key (Pi path or bare id) — for lossless compat derivation. */
  legacyKey?: string;
}

export interface PreferencesV2 {
  version: 2;
  sessions: Record<string, SessionMeta>;
}

export interface V1Preferences {
  archivedSessionPaths?: string[];
  pinnedSessionPaths?: string[];
  sessionDisplayNames?: Record<string, string>;
}

/** A runtime resolver: given an id/path, return its runtime or null if unknown. */
export type RuntimeResolver = (id: string, path: string) => SessionRuntime | null;

const PI_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Extract the Pi session id (uuid) from a Pi `.jsonl` path. The uuid in the
 * filename equals the `type:"session"` header id (verified against real files),
 * so deriving from the filename avoids reading every file during migration.
 * Returns null for non-Pi keys.
 */
export function piSessionIdFromPath(sessionPath: string): string | null {
  const m = sessionPath.match(PI_UUID_RE);
  return m ? m[1] : null;
}

/**
 * Resolve a v1 key (Pi path or bare id) to a stable v2 key `${runtime}:${id}`.
 * Unresolvable bare ids land under `unknown:<id>`: they are preserved (lossless)
 * but never match a sidebar session (which always has a concrete runtime), so
 * their exact runtime is irrelevant for display.
 */
export function toV2Key(
  legacyKey: string,
  resolveRuntime: RuntimeResolver,
): { key: string; runtime: SessionRuntime; id: string } {
  const piId = piSessionIdFromPath(legacyKey);
  if (piId) return { key: `pi:${piId}`, runtime: 'pi', id: piId };
  const rt = resolveRuntime(legacyKey, legacyKey);
  if (rt && rt !== 'unknown') return { key: `${rt}:${legacyKey}`, runtime: rt, id: legacyKey };
  return { key: `unknown:${legacyKey}`, runtime: 'unknown', id: legacyKey };
}

/** Parse a v2 key back into its runtime + id. */
export function parseV2Key(key: string): { runtime: SessionRuntime; id: string } {
  const idx = key.indexOf(':');
  if (idx < 0) return { runtime: 'unknown', id: key };
  const rt = key.slice(0, idx) as SessionRuntime;
  return { runtime: rt, id: key.slice(idx + 1) };
}

/**
 * Migrate a v1 preferences object to the v2 `sessions` map. Pure & lossless:
 * every v1 entry becomes a record keyed by its stable identity, each carrying
 * its original `legacyKey`. Records merge when the same session had several
 * kinds of metadata (e.g. archived AND a display name). `updatedAt` defaults to
 * the migration timestamp so later LWW writes always win.
 */
export function migrateV1ToV2(
  v1: V1Preferences,
  resolveRuntime: RuntimeResolver,
  now: number,
): PreferencesV2 {
  const sessions: Record<string, SessionMeta> = {};
  const touch = (legacyKey: string, apply: (rec: SessionMeta) => void): void => {
    const { key } = toV2Key(legacyKey, resolveRuntime);
    const rec = sessions[key] ?? (sessions[key] = {});
    apply(rec);
    rec.legacyKey = legacyKey;
    if (rec.updatedAt === undefined) rec.updatedAt = now;
  };
  for (const p of v1.archivedSessionPaths ?? []) touch(p, (r) => { r.archived = true; });
  for (const p of v1.pinnedSessionPaths ?? []) touch(p, (r) => { r.pinned = true; });
  for (const [p, name] of Object.entries(v1.sessionDisplayNames ?? {})) {
    touch(p, (r) => { r.displayName = name; });
  }
  return { version: 2, sessions };
}

/** Type guard: is a parsed prefs object already v2? */
export function isV2(prefs: unknown): prefs is PreferencesV2 {
  return (
    typeof prefs === 'object' &&
    prefs !== null &&
    (prefs as { version?: unknown }).version === 2 &&
    typeof (prefs as { sessions?: unknown }).sessions === 'object'
  );
}

/**
 * Derive the v1 legacy arrays/map from a v2 `sessions` map. Used by the GET
 * endpoint's compatibility window (older client bundles still expect the v1
 * shape) and to prove the migration is lossless (round-trip == original).
 * Records without a `legacyKey` (created by new key-based writes during the
 * compat window) are derived from their v2 key id.
 */
export function deriveLegacyArrays(v2: PreferencesV2): {
  archivedSessionPaths: string[];
  pinnedSessionPaths: string[];
  sessionDisplayNames: Record<string, string>;
} {
  const archivedSessionPaths: string[] = [];
  const pinnedSessionPaths: string[] = [];
  const sessionDisplayNames: Record<string, string> = {};
  for (const [key, rec] of Object.entries(v2.sessions)) {
    const legacy = rec.legacyKey ?? parseV2Key(key).id;
    if (rec.archived) archivedSessionPaths.push(legacy);
    if (rec.pinned) pinnedSessionPaths.push(legacy);
    if (rec.displayName !== undefined) sessionDisplayNames[legacy] = rec.displayName;
  }
  return { archivedSessionPaths, pinnedSessionPaths, sessionDisplayNames };
}

/**
 * Last-writer-wins merge of an incoming record into a stored record. The
 * incoming field set is applied only when `incoming.updatedAt >= stored.updatedAt`
 * (per field granularity is not needed: a mutation always bumps the whole
 * record's `updatedAt`). Returns the merged record and whether anything changed.
 */
export function applyLWW(
  stored: SessionMeta | undefined,
  incoming: SessionMeta,
): { record: SessionMeta; changed: boolean } {
  const base = stored ?? {};
  if (incoming.updatedAt !== undefined && base.updatedAt !== undefined && incoming.updatedAt < base.updatedAt) {
    return { record: base, changed: false }; // stale incoming — reject
  }
  const merged: SessionMeta = { ...base };
  let changed = false;
  for (const f of ['archived', 'pinned', 'displayName', 'legacyKey'] as const) {
    if (incoming[f] !== undefined && incoming[f] !== base[f]) {
      merged[f] = incoming[f] as never;
      changed = true;
    }
  }
  if (incoming.updatedAt !== undefined) {
    merged.updatedAt = incoming.updatedAt;
    changed = true;
  }
  return { record: merged, changed };
}
