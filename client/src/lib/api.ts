// Use relative URL in production (same origin), or VITE_API_URL in development
const API_URL = import.meta.env.VITE_API_URL || '';

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

export const api = {
  get: apiGet,
};
