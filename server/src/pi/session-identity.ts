/**
 * Canonical Pi session identity from a session file name.
 *
 * Pi names session files `timestamp_<sessionId>.jsonl`; the segment after the
 * final underscore is the canonical session id, and `assertPiSessionFileIdentity`
 * in `pi-service.ts` rejects any file whose JSONL header id differs from it.
 *
 * Shared (extracted from pi-service.ts) so the session watcher and the Pi
 * service agree on exactly one parser — the watcher needs it for files it first
 * sees on `unlink` (with `ignoreInitial: true` a pre-existing file never emits an
 * `add`, so no header was ever captured).
 */
export function piSessionIdFromFilename(sessionPath: string): string | undefined {
  const filename = sessionPath.split(/[\\/]/).pop();
  const match = filename?.match(/_([^_]+)\.jsonl$/);
  return match?.[1];
}

/**
 * Strict variant: only a real Pi session file name supplies an id — the Pi
 * timestamp prefix (`YYYY-MM-DDTHH-MM-SS-mmmZ`) followed by a UUID suffix
 * (8-4-4-4-12 hex) and `.jsonl`. Used by the session watcher's unlink fallback
 * (correction 05), so a malformed name can never be misrouted to another
 * session's id. `pi-service`'s identity preflight keeps the lenient parse above.
 */
const STRICT_PI_SESSION_FILENAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function strictPiSessionIdFromFilename(sessionPath: string): string | undefined {
  const filename = sessionPath.split(/[\\/]/).pop();
  return filename?.match(STRICT_PI_SESSION_FILENAME)?.[1];
}
