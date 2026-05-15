import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingLevelSelector } from '../../../../src/components/Settings/ThinkingLevelSelector';

describe('ThinkingLevelSelector', () => {
  it('renders all six thinking levels', () => {
    render(<ThinkingLevelSelector value="medium" onChange={() => {}} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Minimal')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Extra High')).toBeInTheDocument();
  });

  it('highlights the selected level', () => {
    render(<ThinkingLevelSelector value="high" onChange={() => {}} />);
    const highButton = screen.getByText('High').closest('button');
    expect(highButton?.className).toContain('bg-blue-50');
  });

  it('calls onChange when a level is clicked', () => {
    const onChange = vi.fn();
    render(<ThinkingLevelSelector value="medium" onChange={onChange} />);

    fireEvent.click(screen.getByText('Extra High'));
    expect(onChange).toHaveBeenCalledWith('xhigh');
  });

  it('does not highlight non-selected levels', () => {
    render(<ThinkingLevelSelector value="off" onChange={() => {}} />);
    const mediumButton = screen.getByText('Medium').closest('button');
    expect(mediumButton?.className).not.toContain('bg-blue-50');
  });
});
