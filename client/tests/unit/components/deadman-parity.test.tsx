import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubagentToolCard } from '../../../src/components/Tools/SubagentToolCard';

/**
 * Contract 1.34.0 non-goal pin: a dead-man backstop is just a background
 * subagent. Its card must render identically to any other background child —
 * no special badge, no extra surface — regardless of the task text.
 */
describe('dead-man backstop parity', () => {
  const background = { taskId: 'bg_dead', runId: 'sa_dead', kind: 'bounded' };

  it('renders a dead-man backstop exactly like an ordinary background child', () => {
    const { container: ordinary } = render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'qa-validator', task: 'sleep 3000 then report', run_in_background: true }}
        result={{ output: 'Background subagent launched (detached).', isError: false }}
        background={background}
      />,
    );

    const { container: deadMan } = render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'qa-validator', task: 'DEAD-MAN TIMER: report if the parent has not checked in', run_in_background: true }}
        result={{ output: 'Background subagent launched (detached).', isError: false }}
        background={{ ...background, taskId: 'bg_dead2', runId: 'sa_dead2' }}
      />,
    );

    expect(screen.getAllByText('Child running')).toHaveLength(2);
    expect(screen.queryByText(/dead-man/i)).toBeNull();
    expect(screen.queryByText(/backstop/i)).toBeNull();

    // Same status structure: both show the running badge, no special markers.
    const ordinaryStatus = ordinary.querySelectorAll('[data-testid], .animate-pulse');
    const deadManStatus = deadMan.querySelectorAll('[data-testid], .animate-pulse');
    expect(ordinaryStatus.length).toBe(deadManStatus.length);
  });

  it('a settled dead-man card flips to completed like any other', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'qa-validator', task: 'DEAD-MAN TIMER', run_in_background: true }}
        result={{ output: 'Background subagent launched (detached).', isError: false }}
        background={{ ...background, taskId: 'bg_dead3' }}
        childState={{
          id: 'bg_dead3',
          kind: 'background_subagent',
          status: 'completed',
          label: 'qa-validator',
          startedAt: 1_000,
          endedAt: 61_000,
        }}
      />,
    );
    expect(screen.getByText('✓ completed')).toBeTruthy();
  });
});
