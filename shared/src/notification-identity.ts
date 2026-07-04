/**
 * Canonical notification opt-in identity.
 *
 * Pi sessions carry two identifiers — the file basename
 * (`2026-07-02T17-16-54-733Z_<uuid>`, the live sidebar id while a session is
 * streaming) and the bare UUID (`<uuid>`, the `type:"session"` header id, which
 * is also the reloaded sidebar id). Keying a notification opt-in on whichever id
 * the sidebar happened to show at click time desyncs on reload: the bell flips
 * off and can't be turned off, while the path-keyed observer keeps firing.
 *
 * The fix keys every opt-in on the same stable bare UUID the v2 session-metadata
 * layer standardized on (`pi:<uuid>`). This module is the single source of truth
 * for that derivation, shared by client + server so both entry points agree.
 *
 * See docs/NOTIFICATION-OPTIN-IDENTITY-FIX-PLAN.md and docs/SESSION-METADATA.md.
 */

/** Runtimes that carry notification opt-ins. */
export type NotificationOptInRuntime = 'pi' | 'claude' | 'opencode' | 'antigravity';

/**
 * Matches the trailing `<uuid>.jsonl` of a Pi session file. The uuid in the
 * filename equals the `type:"session"` header id, so deriving from the filename
 * avoids reading every file. Kept in sync with `server/src/routes/session-meta.ts`
 * via re-export — do not duplicate.
 */
export const PI_UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Extract the Pi session id (uuid) from a Pi `.jsonl` path. Returns null for
 * non-Pi paths, bare uuids without `.jsonl`, or basenames without `.jsonl`.
 */
export function piSessionIdFromPath(sessionPath: string): string | null {
  const m = sessionPath.match(PI_UUID_RE);
  return m ? m[1] : null;
}

/**
 * Stable opt-in identity used as the notification key across browser + internal
 * API. Pi: the bare UUID derived from the path (falls back to the given id when
 * the path has no `<uuid>.jsonl` match, e.g. test fixtures or non-file ids). All
 * other runtimes: the id unchanged — their id already equals their path.
 */
export function canonicalOptInId(
  runtime: NotificationOptInRuntime,
  sessionId: string,
  sessionPath: string,
): string {
  if (runtime === 'pi') {
    return piSessionIdFromPath(sessionPath) ?? sessionId;
  }
  return sessionId;
}
