// Use relative URL in production (same origin), or VITE_API_URL in development
const API_URL = import.meta.env.VITE_API_URL || '';

export interface UploadedFile {
  path: string;
  name: string;
  savedName: string;
  size: number;
  mimeType: string;
}

export interface WebUIPreferences {
  version?: 2;
  /** v2 keyed source of truth (`${runtime}:${id}` → record). Present from the v2
   *  server; the client adopts it directly as sessionMeta. */
  sessions?: Record<string, {
    archived?: true;
    pinned?: true;
    displayName?: string;
    updatedAt?: number;
    legacyKey?: string;
  }>;
  // Derived legacy arrays/map (compat; also returned by the v2 server).
  archivedSessionPaths?: string[];
  pinnedSessionPaths?: string[];
  sessionDisplayNames?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiGet(endpoint: string): Promise<unknown> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    credentials: 'include', // Send cookies
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Export a session to HTML file.
 * Triggers a browser download of the exported HTML file.
 */
export async function exportSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/sessions/${sessionId}/export`, {
    credentials: 'include', // Send cookies
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  // Get the filename from Content-Disposition header or use default
  const contentDisposition = response.headers.get('Content-Disposition');
  const filenameMatch = contentDisposition?.match(/filename="([^"]+)"/);
  const filename = filenameMatch?.[1] || `session-${sessionId}.html`;

  // Get the HTML content as blob
  const blob = await response.blob();

  // Create a download link and trigger it
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Upload a file to the server. Returns the server-side path and metadata.
 */
export async function uploadFile(file: File): Promise<UploadedFile> {
  const response = await fetch(`${API_URL}/api/files/upload`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<UploadedFile>;
}

/**
 * Delete a session by ID.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/sessions/${sessionId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }
}

export const api = {
  get: apiGet,
  exportSession,
  uploadFile,
  deleteSession,
};

/**
 * Slash command definition from server.
 */
export interface SlashCommand {
  name: string;
  description: string;
  type: 'skill' | 'extension' | 'builtin';
}

/**
 * Fetch available slash commands from server (skills + extension commands).
 * Falls back to basic commands if the request fails.
 */
export async function getSlashCommands(): Promise<SlashCommand[]> {
  try {
    const response = await fetch(`${API_URL}/api/extensions/commands`, {
      credentials: 'include',
    });

    if (!response.ok) {
      // Try to parse as JSON error, otherwise throw with status
      let errorMsg = `HTTP ${response.status}`;
      try {
        const errorData = await response.json();
        errorMsg = errorData.error || errorMsg;
      } catch {
        // Response wasn't JSON - likely HTML error page
        errorMsg = `Server returned ${response.status} (not JSON)`;
      }
      throw new ApiError(response.status, errorMsg);
    }

    const result = await response.json();
    return result.commands as SlashCommand[];
  } catch (error) {
    // Re-throw ApiErrors
    if (error instanceof ApiError) {
      throw error;
    }
    // Wrap other errors
    throw new ApiError(0, error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Fetch web UI preferences from the server.
 */
export async function getPreferences(): Promise<WebUIPreferences> {
  return apiGet('/api/preferences') as Promise<WebUIPreferences>;
}

/**
 * Merge-patch web UI preferences on the server.
 * Only the supplied keys are updated; others are left unchanged.
 *
 * IMPORTANT: do NOT route archive/unarchive through here. This PATCH sends the
 * whole preferences object, and the browser *rejects* a `keepalive` fetch whose
 * combined in-flight body exceeds 64 KiB. With hundreds of archived sessions the
 * archivedSessionPaths array alone crosses that limit, so archive writes silently
 * failed to reach the server and reverted on reload. Archive mutations use the
 * per-path delta endpoints below instead. This helper is kept for the small,
 * bounded preferences (pins, display names) where the whole-object PATCH is safe.
 */
export async function patchPreferences(updates: Partial<WebUIPreferences>): Promise<WebUIPreferences> {
  const body = JSON.stringify(updates);
  const response = await fetch(`${API_URL}/api/preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body,
    // keepalive lets the browser complete this request even if the page unloads
    // (e.g. hard-refresh immediately after a change). Safe here because pins /
    // display names stay well under the 64 KiB keepalive quota.
    keepalive: true,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<WebUIPreferences>;
}

/**
 * Archive a single session (delta write). The body is one path — a few hundred
 * bytes — so `keepalive` stays far under the 64 KiB quota and survives an
 * immediate hard-refresh. The server merges atomically, so this is device-
 * agnostic and free of the last-write-wins races that plagued the whole-array
 * PATCH.
 */
export async function archiveSessionPref(sessionPath: string): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/archive', { sessionPath }, true);
}

/** Unarchive a single session (delta write). See archiveSessionPref. */
export async function unarchiveSessionPref(sessionPath: string): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/unarchive', { sessionPath }, true);
}

/**
 * Archive many sessions in one call. This is a deliberate foreground action
 * (never fires on page unload), so it uses a normal — non-keepalive — fetch;
 * the 64 KiB keepalive limit does not apply and the (potentially large) list of
 * paths is sent without issue.
 */
export async function archiveAllSessionsPref(sessionPaths: string[]): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/archive-all', { sessionPaths }, false);
}

/**
 * Pin a single session (delta write). One path → a few hundred bytes → keepalive
 * stays under the 64 KiB quota and survives an immediate hard-refresh. Part of
 * the unified per-item delta channel: pins, display names, and archive all write
 * the same way now, instead of pins/display-names riding the whole-object PATCH.
 */
export async function pinSessionPref(sessionPath: string): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/pin', { sessionPath }, true);
}

/** Unpin a single session (delta write). See pinSessionPref. */
export async function unpinSessionPref(sessionPath: string): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/unpin', { sessionPath }, true);
}

/**
 * Set one session's display name (delta write). The body is a single key/value,
 * so the (potentially large) rest of the display-name map is never re-sent —
 * this is the fix for the keepalive landmine that silently dropped renames once
 * the map grew past 64 KiB.
 */
export async function setDisplayNamePref(sessionPath: string, name: string): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/display-name', { sessionPath, name }, true);
}

/** Clear one session's display name (delta write; name: null deletes the key). */
export async function clearDisplayNamePref(sessionPath: string): Promise<WebUIPreferences> {
  return postPreferenceDelta('/api/preferences/display-name', { sessionPath, name: null }, true);
}

async function postPreferenceDelta(
  endpoint: string,
  body: Record<string, unknown>,
  keepalive: boolean,
): Promise<WebUIPreferences> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(keepalive ? { keepalive: true } : {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<WebUIPreferences>;
}

/**
 * Record token usage for a session.
 * Called automatically when session info is received.
 */
export async function recordUsage(data: {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  messageCount: number;
}): Promise<void> {
  try {
    await fetch(`${API_URL}/api/usage/record`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    // Fire-and-forget - don't wait for response or throw on error
  } catch {
    // Silently ignore usage recording errors
  }
}
