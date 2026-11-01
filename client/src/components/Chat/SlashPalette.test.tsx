import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SlashPalette } from './SlashPalette';
import { getSlashCommands, type SlashCommand } from '../../lib/api';

/**
 * B2: the composer's slash palette must offer only commands that really run
 * from the browser for the session's own runtime.
 *
 * - Pi 1.4.0 has no `/clear`, `/export` or `/help` reachable from the browser;
 *   the only built-in the composer intercepts is `/compact` (CompactModal).
 * - Skills and extension commands are Pi-only, so a non-pi session is offered
 *   nothing by this endpoint.
 */
describe('SlashPalette (B2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the server for the session runtime\u2019s own command list', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ commands: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SlashPalette filter="/" sdkType="antigravity" onSelect={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/extensions/commands');
    expect(String(fetchMock.mock.calls[0][0])).toContain('sdkType=antigravity');
  });

  it('falls back to only the built-in the browser really runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    render(<SlashPalette filter="/" sdkType="pi" onSelect={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('/compact')).toBeTruthy());
    for (const dead of ['/clear', '/export', '/help']) {
      expect(screen.queryByText(dead)).toBeNull();
    }
  });

  it('renders the pi built-in list it is given (one entry: /compact)', async () => {
    const commands: SlashCommand[] = [
      { name: '/compact', description: 'Summarize conversation to free context', type: 'builtin' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ commands }), { status: 200 })));

    render(<SlashPalette filter="/" sdkType="pi" onSelect={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('/compact')).toBeTruthy());
    for (const dead of ['/clear', '/export', '/help']) {
      expect(screen.queryByText(dead)).toBeNull();
    }
  });

  it('renders the server’s unavailable reason instead of an empty palette', async () => {
    // NOTE 2: a non-pi runtime gets `{commands: [], unavailable: "…"}`. The
    // reason is the honest answer; showing nothing looked like a broken palette.
    const reason = 'Pi Web UI cannot run slash commands from the browser for this runtime yet; only a Pi session has any.';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ commands: [], unavailable: reason }), { status: 200 })));

    render(<SlashPalette filter="/" sdkType="antigravity" onSelect={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('slash-unavailable')).toBeTruthy());
    expect(screen.getByTestId('slash-unavailable').textContent).toBe(reason);
    expect(screen.queryByText(/No commands found/)).toBeNull();
  });

  it('still lists commands when the payload carries commands and no reason', async () => {
    const commands: SlashCommand[] = [
      { name: '/compact', description: 'Summarize conversation to free context', type: 'builtin' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ commands }), { status: 200 })));

    render(<SlashPalette filter="/" sdkType="pi" onSelect={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('/compact')).toBeTruthy());
    expect(screen.queryByTestId('slash-unavailable')).toBeNull();
  });
});

describe('getSlashCommands (B2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the runtime in the request so the server can answer per runtime', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ commands: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getSlashCommands('claude');

    expect(String(fetchMock.mock.calls[0][0])).toContain('sdkType=claude');
  });

  it('omits the parameter when the runtime is unknown (server defaults to pi)', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ commands: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getSlashCommands();

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('sdkType=');
  });

  it('carries the server\u2019s unavailable reason through to the caller (NOTE 2)', async () => {
    const reason = 'Pi Web UI cannot run slash commands from the browser for this runtime yet; only a Pi session has any.';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ commands: [], unavailable: reason }), { status: 200 })));

    const result = await getSlashCommands('claude');

    expect(result.commands).toEqual([]);
    expect(result.unavailable).toBe(reason);
  });
});
