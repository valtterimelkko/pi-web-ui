import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmationCard } from '../../../../src/components/DriveMode/ConfirmationCard';

describe('ConfirmationCard — explicit, quoted, ambiguous-does-nothing', () => {
  const PROPOSAL = 'rebase the auth branch onto main and rerun the smoke tests';
  let onConfirm: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;
  let onSubmitText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onConfirm = vi.fn();
    onCancel = vi.fn();
    onSubmitText = vi.fn();
    render(
      <ConfirmationCard
        proposalText={PROPOSAL}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onSubmitText={onSubmitText}
      />
    );
  });

  it('quotes the pending proposal verbatim — compared, not eyeballed', () => {
    const quoted = screen.getByTestId('pending-proposal-text');
    expect(quoted.textContent).toBe(PROPOSAL);
  });

  it('the confirm gesture fires only from the explicit Confirm button', () => {
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmitText).not.toHaveBeenCalled();
  });

  it('the cancel gesture fires from the Cancel button', () => {
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('an ambiguous typed response is passed verbatim and acts on nothing', () => {
    const input = screen.getByLabelText(/type a reply/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'maybe, not sure yet' } });
    fireEvent.click(screen.getByRole('button', { name: /^send reply$/i }));
    // Verbatim: exactly the operator's typed words, never rewritten into a
    // confirm/cancel gesture by the surface.
    expect(onSubmitText).toHaveBeenCalledTimes(1);
    expect(onSubmitText).toHaveBeenCalledWith('maybe, not sure yet');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('an empty reply submits nothing', () => {
    const input = screen.getByLabelText(/type a reply/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^send reply$/i }));
    expect(onSubmitText).not.toHaveBeenCalled();
  });
});
