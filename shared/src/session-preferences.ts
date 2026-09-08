/**
 * Shared pure derivation of legacy v1 preference arrays from v2 session-meta
 * records. Used by BOTH real consumers — the server's v1 compatibility window
 * (routes/session-meta.ts) and the client's optimistic projection
 * (store/sessionStore.ts) — so the two sides cannot drift. The legacy key
 * falls back to the v2 key's id (the segment after the first ':').
 */
export interface LegacySessionRecord {
  legacyKey?: string;
  archived?: boolean;
  pinned?: boolean;
  displayName?: string;
}

export function deriveLegacySessionArrays(sessions: Record<string, LegacySessionRecord>): {
  archivedSessionPaths: string[];
  pinnedSessionPaths: string[];
  sessionDisplayNames: Record<string, string>;
} {
  const archivedSessionPaths: string[] = [];
  const pinnedSessionPaths: string[] = [];
  const sessionDisplayNames: Record<string, string> = {};
  for (const [key, rec] of Object.entries(sessions)) {
    const legacy = rec.legacyKey ?? key.slice(key.indexOf(':') + 1);
    if (rec.archived) archivedSessionPaths.push(legacy);
    if (rec.pinned) pinnedSessionPaths.push(legacy);
    if (rec.displayName !== undefined) sessionDisplayNames[legacy] = rec.displayName;
  }
  return { archivedSessionPaths, pinnedSessionPaths, sessionDisplayNames };
}
