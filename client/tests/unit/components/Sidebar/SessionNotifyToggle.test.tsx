import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionNotifyToggle } from '../../../../src/components/Sidebar/SessionNotifyToggle.js';
import { useSessionStore, useUIStore } from '../../../../src/store';

vi.mock('../../../../src/store', () => ({
  useSessionStore: vi.fn(),
  useUIStore: vi.fn(),
}));

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

/** Configure the mocked sessionData[sessionId]?.status seen by the component. */
function mockSessionStatus(status: 'idle' | 'streaming' | 'busy' | 'error' | undefined) {
  const sessionData = status ? { s1: { status } } : {};
  (useSessionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: { sessionData: typeof sessionData }) => unknown) => selector({ sessionData }),
  );
}

describe('SessionNotifyToggle', () => {
  let addToast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    addToast = vi.fn();
    (useUIStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (state: { addToast: typeof addToast }) => unknown) => selector({ addToast }),
    );
    mockSessionStatus(undefined); // idle by default (no entry yet)
  });

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

  describe('idle-at-opt-in feedback (Q2 fix)', () => {
    it('shows an info toast when opting into a session that is currently idle', async () => {
      mockSessionStatus('idle');
      vi.stubGlobal('fetch', makeFetch(null));

      render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: /enable notifications/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
      );

      expect(addToast).toHaveBeenCalledTimes(1);
      const toast = addToast.mock.calls[0][0];
      expect(toast.type).toBe('info');
      expect(toast.message).toMatch(/idle/i);
      expect(toast.message).toMatch(/next/i);
    });

    it('shows the toast when the session has no live status yet (never streamed)', async () => {
      mockSessionStatus(undefined);
      vi.stubGlobal('fetch', makeFetch(null));

      render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: /enable notifications/i }));
      await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    });

    it('does not show a toast when opting into a session that is actively streaming', async () => {
      mockSessionStatus('streaming');
      vi.stubGlobal('fetch', makeFetch(null));

      render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: /enable notifications/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
      );
      expect(addToast).not.toHaveBeenCalled();
    });

    it('does not show a toast on opt-out', async () => {
      mockSessionStatus('idle');
      vi.stubGlobal('fetch', makeFetch({ runtime: 'pi' }));

      render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: /disable notifications/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );
      expect(addToast).not.toHaveBeenCalled();
    });
  });
});
