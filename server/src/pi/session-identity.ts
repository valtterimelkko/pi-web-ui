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
