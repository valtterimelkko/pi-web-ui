import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReadingLevelControl } from '../../../../src/components/DriveMode/ReadingLevelControl';

/**
 * P17 package A — the control, and the indicator that stops the operator
 * wondering whether they heard everything.
 *
 * The one dangerous failure of summarisation is not knowing whether you heard
 * all of it, so the active level is permanently visible AND the surface says
 * which form the current answer is being read in.
 */

const renderControl = (over: Partial<React.ComponentProps<typeof ReadingLevelControl>> = {}) => {
  const onSelect = vi.fn();
  render(
    <ReadingLevelControl level="summary" onSelect={onSelect} spokenKind="summary" {...over} />
  );
  return { onSelect };
};

describe('ReadingLevelControl', () => {
  it('offers exactly the three levels, with the active one marked', () => {
    renderControl({ level: 'summary', spokenKind: null });
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Verbatim', 'Summary', 'Headlines']);
    expect(screen.getByTestId('reading-level-summary')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('reading-level-verbatim')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('reading-level-headlines')).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the operator’s choice (the surface persists it)', () => {
    const { onSelect } = renderControl();
    fireEvent.click(screen.getByTestId('reading-level-headlines'));
    expect(onSelect).toHaveBeenCalledWith('headlines');
  });

  it('the indicator always names the level in effect', () => {
    renderControl({ level: 'verbatim', spokenKind: null });
    expect(screen.getByTestId('reading-level-indicator')).toHaveTextContent(
      'Reading level: Verbatim'
    );

    renderControl({ level: 'headlines', spokenKind: null });
    expect(screen.getAllByTestId('reading-level-indicator')[1]).toHaveTextContent(
      'Reading level: Headlines'
    );
  });

  it('the indicator says when the answer in flight is a condensed one', () => {
    renderControl({ level: 'summary', spokenKind: 'summary' });
    expect(screen.getByTestId('reading-level-indicator')).toHaveTextContent('hearing a summary');
  });

  it('says plainly when the answer is being read verbatim', () => {
    renderControl({ level: 'verbatim', spokenKind: 'verbatim' });
    expect(screen.getByTestId('reading-level-indicator')).toHaveTextContent('hearing it verbatim');
  });

  it('keeps the transcript as the channel of record, in the operator’s view', () => {
    renderControl();
    expect(screen.getByTestId('reading-level-hint')).toHaveTextContent(/transcript has the full text/i);
  });

  it('tells the operator honestly when a digest fell back to the full text', () => {
    renderControl({ fallbackNote: 'Could not summarise — read in full.' });
    expect(screen.getByTestId('reading-level-fallback')).toHaveTextContent(
      'Could not summarise — read in full.'
    );
  });

  it('shows no fallback note when there was none', () => {
    renderControl({ fallbackNote: null });
    expect(screen.queryByTestId('reading-level-fallback')).not.toBeInTheDocument();
  });
});
