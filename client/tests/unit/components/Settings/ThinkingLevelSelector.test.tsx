import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingLevelSelector } from '../../../../src/components/Settings/ThinkingLevelSelector';

describe('ThinkingLevelSelector', () => {
  it('renders all seven thinking levels by default, including Max', () => {
    render(<ThinkingLevelSelector value="medium" onChange={() => {}} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Minimal')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Extra High')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
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

  it('only renders model-supported thinking levels when supplied', () => {
    render(
      <ThinkingLevelSelector
        value="high"
        availableLevels={['off', 'low', 'high']}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.queryByText('Minimal')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    expect(screen.queryByText('Extra High')).not.toBeInTheDocument();
    expect(screen.queryByText('Max')).not.toBeInTheDocument();
  });

  it('renders no Off option for Gemini 3.x flash models whose thinking cannot be disabled', () => {
    // google/gemini-3.5-flash-lite & 3.8-flash advertise [minimal,low,medium,high]:
    // their thinkingLevelMap is {off:null} — thinking is always on.
    render(
      <ThinkingLevelSelector
        value="medium"
        availableLevels={['minimal', 'low', 'medium', 'high']}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByText('Off')).not.toBeInTheDocument();
    expect(screen.getByText('Minimal')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.queryByText('Extra High')).not.toBeInTheDocument();
    expect(screen.queryByText('Max')).not.toBeInTheDocument();
  });

  it('does not highlight non-selected levels', () => {
    render(<ThinkingLevelSelector value="off" onChange={() => {}} />);
    const mediumButton = screen.getByText('Medium').closest('button');
    expect(mediumButton?.className).not.toContain('bg-blue-50');
  });
});
