import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../../src/components/ErrorBoundary.js';
import { clearBrowserDiagnostics } from '../../../src/lib/browserDiagnostics.js';

function Broken(): React.JSX.Element {
  throw new Error('render failed');
}

describe('ErrorBoundary diagnostics', () => {
  beforeEach(() => {
    clearBrowserDiagnostics();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('offers a manual privacy-safe diagnostic copy action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: /copy diagnostics/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(writeText.mock.calls[0][0]);
    expect(copied.events.some((event: { kind: string }) => event.kind === 'ui_error')).toBe(true);
    expect(JSON.stringify(copied)).not.toContain('componentStack');
  });

  it('shows a safe fallback when clipboard access is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: /copy diagnostics/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/copy failed.*download/i);
  });
});
