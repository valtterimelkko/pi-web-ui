import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/App', () => ({
  default: () => {
    throw new Error('forced render failure');
  },
}));

describe('application root error boundary', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders the manual diagnostic recovery surface for root render failures', async () => {
    await import('../../src/main.js');
    expect(await screen.findByRole('button', { name: /copy diagnostics/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download diagnostics/i })).toBeInTheDocument();
  });
});
