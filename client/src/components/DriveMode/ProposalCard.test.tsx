import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { VoiceCreatedProposal } from '@pi-web-ui/shared';
import { ProposalCard } from './ProposalCard';

function proposal(overrides: Partial<VoiceCreatedProposal> = {}): VoiceCreatedProposal {
  return {
    proposalId: 'prop-17',
    version: 4,
    sha256: 'a1b2c3d4e5f6'.padEnd(64, '0'),
    promotionRoute: 'directed',
    original: 'ask it whether the retry handler drops the token',
    tidied: 'ask whether the retry handler drops the token',
    presentedVariant: 'tidied',
    presentation: { completed: true },
    ...overrides,
  };
}

const noop = () => undefined;

describe('ProposalCard', () => {
  it('shows the identity the release is bound to', () => {
    render(
      <ProposalCard proposal={proposal()} status="presented" onConfirm={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('proposal-id').textContent).toContain('prop-17');
    expect(screen.getByTestId('proposal-version').textContent).toContain('4');
    expect(screen.getByTestId('proposal-sha').textContent).toContain('a1b2c3d4e5f6');
    expect(screen.getByTestId('proposal-route').textContent).toContain('directed');
  });

  it('shows both retained variants, switching what would be released', () => {
    render(
      <ProposalCard proposal={proposal()} status="presented" onConfirm={noop} onCancel={noop} />,
    );
    // Tidied is the presented variant by default.
    expect(screen.getByTestId('proposal-text').textContent).toBe(
      'ask whether the retry handler drops the token',
    );
    fireEvent.click(screen.getByTestId('proposal-variant-original'));
    expect(screen.getByTestId('proposal-text').textContent).toBe(
      'ask it whether the retry handler drops the token',
    );
  });

  it('confirms the variant the operator is looking at', () => {
    const onConfirm = vi.fn();
    render(
      <ProposalCard proposal={proposal()} status="presented" onConfirm={onConfirm} onCancel={noop} />,
    );
    fireEvent.click(screen.getByTestId('proposal-variant-original'));
    fireEvent.click(screen.getByTestId('proposal-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('original');
  });

  it('reports presented, pending and stale visibly, and blocks the wrong ones', () => {
    const { rerender } = render(
      <ProposalCard proposal={proposal()} status="presented" onConfirm={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('proposal-card').getAttribute('data-presentation-status')).toBe('presented');
    expect(screen.getByTestId('proposal-status').textContent).toContain('Read back in full');
    expect((screen.getByTestId('proposal-confirm') as HTMLButtonElement).disabled).toBe(false);

    rerender(
      <ProposalCard
        proposal={proposal({ presentation: { completed: false, stoppedAtChar: 12 } })}
        status="pending"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('proposal-status').textContent).toContain('Not read back in full');
    expect((screen.getByTestId('proposal-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('proposal-not-presented')).toBeTruthy();

    rerender(
      <ProposalCard
        proposal={proposal()}
        status="stale"
        staleDetail="a newer proposal replaced this one"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('proposal-status').textContent).toContain('Stale');
    expect(screen.getByTestId('proposal-status').textContent).toContain('a newer proposal replaced this one');
    expect((screen.getByTestId('proposal-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancels without sending anything itself', () => {
    const onCancel = vi.fn();
    render(
      <ProposalCard proposal={proposal()} status="presented" onConfirm={noop} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByTestId('proposal-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers a read-back which reports completion (and an interrupted stop point)', () => {
    const onReadBack = vi.fn();
    const onPresentationReport = vi.fn();
    render(
      <ProposalCard
        proposal={proposal({ presentedVariant: 'original' })}
        status="pending"
        onConfirm={noop}
        onCancel={noop}
        onReadBack={onReadBack}
        onPresentationReport={onPresentationReport}
      />,
    );
    fireEvent.click(screen.getByTestId('proposal-readback'));
    expect(onReadBack).toHaveBeenCalledWith('original');
    expect(onPresentationReport).toHaveBeenCalledWith(true);
  });

  it('marks a visible tidy rather than claiming it is the operator words exactly', () => {
    render(
      <ProposalCard proposal={proposal()} status="presented" onConfirm={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('proposal-tidy-note')).toBeTruthy();
    expect(screen.getByTestId('proposal-presented-variant').textContent).toContain('tidied');
  });

  it('does not cry wolf when nothing was tidied', () => {
    render(
      <ProposalCard
        proposal={proposal({ tidied: proposal().original })}
        status="presented"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.queryByTestId('proposal-tidy-note')).toBeNull();
  });
});
