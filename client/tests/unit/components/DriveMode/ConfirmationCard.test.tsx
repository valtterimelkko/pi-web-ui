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

describe('ConfirmationCard P26 — the card tells the truth about what will be sent', () => {
  // What the operator actually SAID (rambling), and what the harness's
  // mechanical transform leaves after removing the noise.
  const RAW = 'okay um ask the worker if it has enough materials to start';
  const TIDIED = 'if it has enough materials to start';
  const REMOVED = 'okay, um, ask the worker';

  let onConfirm: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;
  let onSubmitText: ReturnType<typeof vi.fn>;

  // Own mock setup — this suite must NOT inherit the outer describe's
  // beforeEach render, or every test here starts with a second card mounted.
  beforeEach(() => {
    onConfirm = vi.fn();
    onCancel = vi.fn();
    onSubmitText = vi.fn();
  });

  const renderCard = (props: { cleaned?: boolean; removed?: string }) =>
    render(
      <ConfirmationCard
        proposalText={TIDIED}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onSubmitText={onSubmitText}
        {...props}
      />
    );

  const renderPlain = () =>
    render(
      <ConfirmationCard
        proposalText={RAW}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onSubmitText={onSubmitText}
      />
    );

  it('an UNCLEANED utterance keeps the exact-words claim and shows no disclosure — no crying wolf', () => {
    renderPlain();
    expect(screen.getByText('Ready to send — your words, exactly:')).toBeTruthy();
    expect(screen.queryByTestId('relay-tidied-note')).toBeNull();
    expect(screen.queryByTestId('relay-removed-text')).toBeNull();
  });

  it('cleaned=false behaves exactly like an old server: the exact-words claim stands', () => {
    renderCard({ cleaned: false });
    expect(screen.getByText('Ready to send — your words, exactly:')).toBeTruthy();
    expect(screen.queryByTestId('relay-tidied-note')).toBeNull();
  });

  it('a CLEANED utterance says tidied, shows the exact outgoing text, and shows what was removed', () => {
    renderCard({ cleaned: true, removed: REMOVED });
    // The claim changes to match reality — an untrue safety claim is worse
    // than no claim.
    expect(screen.getByText('Ready to send — your words, tidied:')).toBeTruthy();
    expect(screen.queryByText('Ready to send — your words, exactly:')).toBeNull();
    // The exact text that will go, compared not eyeballed (P25 invariant).
    expect(screen.getByTestId('pending-proposal-text').textContent).toBe(TIDIED);
    // What was removed is on the card, not hidden behind a click.
    expect(screen.getByTestId('relay-removed-text').textContent).toBe(REMOVED);
  });

  it('cleaned=true with no removed detail still says tidied and invents no removal', () => {
    renderCard({ cleaned: true });
    expect(screen.getByText('Ready to send — your words, tidied:')).toBeTruthy();
    expect(screen.getByTestId('pending-proposal-text').textContent).toBe(TIDIED);
    expect(screen.queryByTestId('relay-removed-text')).toBeNull();
  });

  it('the three responses still work on a cleaned card — the transform changes nothing about consent', () => {
    renderCard({ cleaned: true, removed: REMOVED });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText(/type a reply/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'send the shorter one instead' } });
    fireEvent.click(screen.getByRole('button', { name: /^send reply$/i }));
    expect(onSubmitText).toHaveBeenCalledWith('send the shorter one instead');
  });
});
