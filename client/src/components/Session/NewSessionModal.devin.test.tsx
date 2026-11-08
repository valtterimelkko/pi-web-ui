import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { NewSessionModal } from './NewSessionModal';
import { useSessionStore } from '../../store';

/**
 * Lane D3 (devin-parity): the New Session modal's Devin picker shows ONE
 * entry per model family (with a level dropdown when the family has several
 * levels) and the create request carries the RESOLVED variant id — never a
 * bare family id, never one selector per level (owner, 2026-11-08).
 */

const devinCatalogue = {
  models: [
    { id: 'swe-2-flash-medium', name: 'SWE-2 Flash Medium', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2-flash', familyName: 'SWE-2 Flash' },
    { id: 'swe-2-flash-high', name: 'SWE-2 Flash High', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2-flash', familyName: 'SWE-2 Flash' },
    { id: 'swe-2-flash-max', name: 'SWE-2 Flash Max', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2-flash', familyName: 'SWE-2 Flash' },
    { id: 'swe-2-medium', name: 'SWE-2 Medium', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2', familyName: 'SWE-2' },
    { id: 'swe-2-max', name: 'SWE-2 Max', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2', familyName: 'SWE-2' },
    { id: 'kimi-k2-6', name: 'Kimi K2.6', pricing: { free: false, raw: '$1 / 1M' }, thinkingLevels: [], family: 'kimi-k2-6', familyName: 'Kimi K2.6' },
  ],
};

function stubFetch() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes('/api/models')) {
      return new Response(JSON.stringify(devinCatalogue), { status: 200 });
    }
    if (target.includes('/api/files/browse')) {
      return new Response(JSON.stringify({ path: '/root', parent: null, items: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('NewSessionModal Devin family picker (lane D3)', () => {
  beforeEach(() => {
    useSessionStore.setState({ devinEnabled: true, devinAvailable: true, devinError: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.setState({ devinEnabled: false, devinAvailable: false, devinError: null });
  });

  it('shows one option per family (label + free badge), not one per variant', async () => {
    stubFetch();
    render(<NewSessionModal isOpen onClose={() => {}} onCreateSession={() => {}} />);

    await waitFor(() => expect((screen.getByRole("button", { name: /^Devin/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^Devin/ }));

    const select = await screen.findByTestId('devin-model-select');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(3));
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['SWE-2 Flash • free', 'SWE-2 • free', 'Kimi K2.6']);
  });

  it('shows a level dropdown defaulting to medium and sends the resolved variant id', async () => {
    stubFetch();
    const onCreateSession = vi.fn();
    render(<NewSessionModal isOpen onClose={() => {}} onCreateSession={onCreateSession} />);

    await waitFor(() => expect((screen.getByRole("button", { name: /^Devin/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^Devin/ }));

    // Default family is the first free one (SWE-2 Flash); the level dropdown
    // exists and defaults to medium.
    const levelSelect = await screen.findByTestId('devin-level-select');
    expect((levelSelect as HTMLSelectElement).value).toBe('medium');

    // Change family to SWE-2 and level to max: the create request must send
    // the resolved variant id swe-2-max.
    fireEvent.change(screen.getByTestId('devin-model-select'), { target: { value: 'swe-2' } });
    fireEvent.change(screen.getByTestId('devin-level-select'), { target: { value: 'max' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalled());
    const args = onCreateSession.mock.calls[0];
    expect(args[1]).toBe('devin');
    expect(args[2]).toBe('swe-2-max');
  });

  it('shows no level control for a single-variant family', async () => {
    stubFetch();
    render(<NewSessionModal isOpen onClose={() => {}} onCreateSession={() => {}} />);

    await waitFor(() => expect((screen.getByRole("button", { name: /^Devin/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^Devin/ }));
    await screen.findByTestId('devin-model-select');

    fireEvent.change(screen.getByTestId('devin-model-select'), { target: { value: 'kimi-k2-6' } });
    expect(screen.queryByTestId('devin-level-select')).toBeNull();
  });
});
