import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThinkingLevelSelector } from '../../../src/components/Settings/ThinkingLevelSelector';

describe('ThinkingLevelSelector — model-scoped availability', () => {
  it('renders exactly the model-supplied levels for zai/glm-5.3-flash (low/high/max)', () => {
    const onChange = vi.fn();
    render(
      <ThinkingLevelSelector
        value="max"
        availableLevels={['low', 'high', 'max']}
        onChange={onChange}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'LowQuick thinking',
      'HighDeep analysis',
      'MaxAbsolute maximum reasoning',
    ]);

    // Off/Minimal/Medium/Extra High must be absent: glm-5.3-flash maps them
    // to null in its thinkingLevelMap, so they are not selectable.
    for (const absent of ['Off', 'Minimal', 'Medium', 'Extra High']) {
      expect(screen.queryByText(absent)).not.toBeInTheDocument();
    }
  });

  it('does not silently broaden to all levels when the model narrows them', () => {
    render(
      <ThinkingLevelSelector value="low" availableLevels={['low', 'high', 'max']} onChange={vi.fn()} />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});
