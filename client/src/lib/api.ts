// Use relative URL in production (same origin), or VITE_API_URL in development
const API_URL = import.meta.env.VITE_API_URL || '';

export interface UploadedFile {
  path: string;
  name: string;
  savedName: string;
  size: number;
  mimeType: string;
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
