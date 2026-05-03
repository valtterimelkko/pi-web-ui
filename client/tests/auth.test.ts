import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkAuthStatus, useAuth } from '../src/hooks/useAuth';

describe('checkAuthStatus', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuth.setState({ isAuthenticated: false, csrfToken: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the fresh CSRF token returned by the authenticated /me response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'default-user' }, csrfToken: 'fresh-csrf-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const authenticated = await checkAuthStatus();

    expect(authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', { credentials: 'include' });
    expect(useAuth.getState().isAuthenticated).toBe(true);
    expect(useAuth.getState().csrfToken).toBe('fresh-csrf-token');
  });
});
