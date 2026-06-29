import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionNotifyToggle } from '../../../../src/components/Sidebar/SessionNotifyToggle.js';

/** Controllable fetch mock: GET returns the current opt-in state; POST/DELETE ack. */
function makeFetch(initialOptIn: unknown) {
  let optedIn = initialOptIn;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/notifications') && method === 'GET') {
      return { ok: true, json: async () => ({ optIn: optedIn }) } as Response;
    }
    // POST opt-in / DELETE opt-in
    if (method === 'POST') optedIn = { runtime: 'pi' };
    if (method === 'DELETE') optedIn = null;
    return { ok: true, json: async () => ({ status: 'ok' }) } as Response;
  });
}

describe('SessionNotifyToggle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reflects an opted-in session and toggles off via DELETE', async () => {
    const fetchMock = makeFetch({ runtime: 'pi' });
    vi.stubGlobal('fetch', fetchMock);

    render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/notifications',
      expect.objectContaining({ credentials: 'include' }),
    );

    fireEvent.click(screen.getByRole('button', { name: /disable notifications/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/notifications/opt-in',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('opts in via POST when the session is not opted in', async () => {
    const fetchMock = makeFetch(null);
    vi.stubGlobal('fetch', fetchMock);

    render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /enable notifications/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/notifications/opt-in',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ runtime: 'pi', sessionPath: '/p/s1' }),
      }),
    );
  });
});
