import { open } from 'fs/promises';

/**
 * Read the cwd for a single Pi session from its file header WITHOUT scanning
 * all on-disk sessions.
 *
 * A Pi session's first JSONL line is a `type: "session"` header carrying the
 * authoritative `cwd`. This reads only that header line and returns immediately,
 * even for multi-MB files (readLines is lazy and we stop after the first line).
 *
 * Replaces `SessionManager.listAll()` scans that JSON-parsed every on-disk
 * session (~4s for ~800 sessions) just to look up one cwd. Call sites:
 *   - server/src/websocket/connection.ts (handleSwitchSession — browser switch)
 *   - server/src/pi/session-pool.ts      (switchClientSession — extension switch)
 *
 * Why the file header and not the directory name: the SDK encodes the cwd into
 * the session directory name by replacing "/", "\", ":" with "-", which is
 * LOSSY — a cwd containing a literal dash (e.g. /root/pi-web-ui) cannot be
 * recovered from the dir name. The header is the only correct source.
 *
 * Returns undefined if the file is missing, unreadable, or has no cwd header.
 */
export async function readSessionCwd(sessionPath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(sessionPath, 'r');
  } catch {
    return undefined;
  }
  try {
    for await (const line of handle.readLines()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // The first non-empty line must be the session header. If it isn't, this
      // isn't a valid Pi session file — bail (matches the SDK's buildSessionInfo,
      // which returns null when the first entry is not type:"session").
      try {
        const entry = JSON.parse(trimmed) as { type?: unknown; cwd?: unknown };
        if (entry.type === 'session') {
          return typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : undefined;
        }
      } catch {
        // first line isn't valid JSON → not a session header
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
