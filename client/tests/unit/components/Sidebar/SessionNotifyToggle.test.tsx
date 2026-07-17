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

  it('disables toggling until the initial server state is known', async () => {
    let resolveGet!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveGet = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
    const button = screen.getByRole('button', { name: /enable notifications/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveGet({ ok: true, json: async () => ({ optIn: null }) } as Response);
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('surfaces initial state lookup failures without breaking the toggle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/load notification/i),
    })));
  });

  it('surfaces opt-in write failures and leaves the state unchanged', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ optIn: null }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    render(<SessionNotifyToggle sessionId="s1" sdkType="pi" sessionPath="/p/s1" />);
    const button = await screen.findByRole('button', { name: /enable notifications/i });
    fireEvent.click(button);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/update notification/i),
    })));
    expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
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

  describe('Pi canonical opt-in id (desync fix)', () => {
    // Real prod-derived Pi dual-id shapes (plan §2): the live sidebar shows the
    // basename; after reload it shows the bare uuid. Both must key the same URL.
    const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
    const BASENAME = `2026-07-02T17-16-54-733Z_${UUID}`;
    const PATH = `/root/.pi/agent/sessions/--root-pi-web-ui--/${BASENAME}.jsonl`;

    it('keys every fetch on the bare uuid when the sidebar shows the live basename', async () => {
      const fetchMock = makeFetch(null);
      vi.stubGlobal('fetch', fetchMock);

      render(<SessionNotifyToggle sessionId={BASENAME} sdkType="pi" sessionPath={PATH} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: /enable notifications/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: /disable notifications/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );

      // Every fetch URL must be keyed on the bare uuid, NOT the basename
      // (the basename contains the uuid as a substring, so check the path segment).
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls.length).toBeGreaterThanOrEqual(3); // GET + POST + DELETE
      for (const url of urls) {
        expect(url.startsWith(`/api/sessions/${UUID}/`)).toBe(true);
      }
      // The POST body still carries the real sessionPath (needed for the Pi observer key).
      const postCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
        runtime: 'pi',
        sessionPath: PATH,
      });
    });

    it('is idempotent: the reloaded bare-uuid id maps to the same url', async () => {
      const fetchMock = makeFetch({ runtime: 'pi' });
      vi.stubGlobal('fetch', fetchMock);

      render(<SessionNotifyToggle sessionId={UUID} sdkType="pi" sessionPath={PATH} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /disable notifications/i })).toBeInTheDocument(),
      );
      expect(fetchMock.mock.calls[0][0]).toBe(`/api/sessions/${UUID}/notifications`);
    });

    it('leaves non-Pi ids unchanged in the url', async () => {
      const fetchMock = makeFetch(null);
      vi.stubGlobal('fetch', fetchMock);
      render(<SessionNotifyToggle sessionId="c1" sdkType="claude" sessionPath="c1" />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument(),
      );
      expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/c1/notifications');
    });
  });
});
