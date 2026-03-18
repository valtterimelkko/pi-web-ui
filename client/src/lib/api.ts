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
  archivedSessionPaths?: string[];
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

export const api = {
  get: apiGet,
  exportSession,
  uploadFile,
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
 */
export async function patchPreferences(updates: Partial<WebUIPreferences>): Promise<WebUIPreferences> {
  const response = await fetch(`${API_URL}/api/preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<WebUIPreferences>;
}
