/**
 * Sidebar active-list hygiene (2026-08-21 fix + plan Phase 3: antigravity
 * background tasks & archive robustness).
 *
 * The default sidebar view keeps the list to RECENT sessions; an unbounded
 * list of hundreds of rows made manual archiving feel necessary. Sessions
 * discovered natively from disk (`origin: 'native-discovered'` — indexed by
 * the SessionWatcher or the Resume-CLI scan but never created in the Web UI)
 * obey a tighter 14-day recency cutoff: historical CLI sessions must not
 * flood the active list. The currently open session and "Show all" override.
 */

/** Recency window for sessions created in the Web UI (existing behaviour). */
export const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Tighter recency window for natively discovered CLI sessions. */
export const NATIVE_DISCOVERED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

interface SidebarSessionLike {
  id: string;
  lastActivity?: string;
  origin?: 'browser' | 'internal-api' | 'native-discovered';
}

interface FilterOptions {
  /** The session the user currently has open — always visible. */
  currentSessionId?: string | null;
  /** Bypass all recency cutoffs (the sidebar's "Show all" toggle). */
  showAll?: boolean;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Filter the active sessions down to the "recent" subset shown by default.
 * Pure: same input, same output.
 */
export function filterRecentActiveSessions<T extends SidebarSessionLike>(
  sessions: T[],
  opts: FilterOptions = {},
): T[] {
  if (opts.showAll) return sessions;
  const now = opts.now ?? Date.now();
  return sessions.filter((s) => {
    if (s.id === opts.currentSessionId) return true; // the open session is never hidden
    if (!s.lastActivity) return true; // unknown age stays visible (existing behaviour)
    const age = now - new Date(s.lastActivity).getTime();
    if (Number.isNaN(age)) return true;
    const window = s.origin === 'native-discovered' ? NATIVE_DISCOVERED_WINDOW_MS : RECENT_WINDOW_MS;
    return age <= window;
  });
}
