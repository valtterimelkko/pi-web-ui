import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GoalPanel } from '../../../../src/components/Chat/GoalPanel';
import { useGoalStore } from '../../../../src/store/goalStore';
import { useUIStore } from '../../../../src/store/uiStore';

const WIDGET = [
  '🎯 Goal Status',
  'Status: ▶ Running',
  'Objective: Create three files in this workspace',
  'Started: 7/25/2026, 4:41:01 PM',
  'Agent runs: 1',
  'Max runs: 4',
  'Continuation interval: 30s (rung 1/4)',
  'Token spend: 38,287 / 5,000,000 billed input tokens',
  'USD spend: $0.06 / disabled',
  'Verification command: test -f a.txt',
  'Verification status: failed',
  '',
  'Plan:',
  '  ✓ Inspect workspace',
  '  ☐ Write the files',
];

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
}

function renderPanel(props: Partial<React.ComponentProps<typeof GoalPanel>> = {}) {
  return render(
    <GoalPanel
      sessionId="session-1"
      sdkType="pi"
      isStreaming={false}
      statusText={undefined}
      onControl={vi.fn()}
      {...props}
    />,
  );
}

describe('GoalPanel', () => {
  beforeEach(() => {
    useGoalStore.setState({ bySession: {} });
    useUIStore.setState({ goalPanelExpanded: {} } as Partial<ReturnType<typeof useUIStore.getState>>);
    setViewport(1440);
  });

  it('renders nothing when the session has no goal at all', () => {
    const { container } = renderPanel();
    expect(container.firstChild).toBeNull();
  });

  it('falls back to the status line when no widget payload has arrived', () => {
    renderPanel({ statusText: '🎯 ▶ Running — Run 2' });

    expect(screen.getByTestId('goal-tag').textContent).toContain('Goal');
    expect(screen.queryByTestId('goal-panel-body')).toBeNull();
  });

  describe('with a parsed goal widget', () => {
    beforeEach(() => {
      useGoalStore.getState().applyWidget('session-1', WIDGET);
    });

    it('summarises the goal in the collapsed header', () => {
      renderPanel({ isStreaming: true, statusText: '🎯 ▶ Running — Run 1' });

      const tag = screen.getByTestId('goal-tag');
      // Run 1 has finished, so the run in flight is 2 of 4 — not "Run 1".
      expect(tag.textContent).toContain('Run 2/4');
      const summary = screen.getByTestId('goal-panel-summary').textContent!;
      expect(summary).toContain('$0.06');
      // …and the header must not repeat it inside the summary.
      expect(summary).not.toContain('Run 2/4');
    });

    it('expands to structured detail and collapses again', () => {
      setViewport(390); // phone default is collapsed
      renderPanel();

      expect(screen.queryByTestId('goal-panel-body')).toBeNull();
      fireEvent.click(screen.getByTestId('goal-panel-toggle'));

      const body = screen.getByTestId('goal-panel-body');
      expect(body.textContent).toContain('Create three files in this workspace');
      expect(body.textContent).toContain('Write the files');
      expect(body.textContent).toContain('test -f a.txt');
      // The panel must never be able to eat the viewport again.
      expect(body.className).toContain('overflow-y-auto');
      expect(body.className).toMatch(/max-h-/);

      fireEvent.click(screen.getByTestId('goal-panel-toggle'));
      expect(screen.queryByTestId('goal-panel-body')).toBeNull();
    });

    it('starts collapsed on a phone-sized viewport and expanded on desktop', () => {
      setViewport(390);
      const phone = renderPanel();
      expect(screen.queryByTestId('goal-panel-body')).toBeNull();
      phone.unmount();

      setViewport(1440);
      renderPanel();
      expect(screen.getByTestId('goal-panel-body')).toBeTruthy();
    });

    it('remembers the operator choice per session', () => {
      setViewport(390);
      const first = renderPanel();
      fireEvent.click(screen.getByTestId('goal-panel-toggle'));
      expect(screen.getByTestId('goal-panel-body')).toBeTruthy();
      first.unmount();

      renderPanel();
      expect(screen.getByTestId('goal-panel-body')).toBeTruthy();
    });

    it('shows the continuation countdown between runs instead of a bare "running"', () => {
      vi.useFakeTimers();
      try {
        const updatedAt = useGoalStore.getState().getGoalView('session-1').current!.updatedAt;
        vi.setSystemTime(updatedAt + 10_000);
        renderPanel({ isStreaming: false });
        expect(screen.getByTestId('goal-tag').textContent).toContain('continuing in 20s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders Pi controls that route through the supplied handler', () => {
      const onControl = vi.fn();
      renderPanel({ onControl, isStreaming: true });

      fireEvent.click(screen.getByTestId('goal-pause'));
      expect(onControl).toHaveBeenCalledWith('pause');

      fireEvent.click(screen.getByTestId('goal-clear'));
      fireEvent.click(screen.getByTestId('goal-clear-confirm'));
      expect(onControl).toHaveBeenCalledWith('clear');
    });

    it('hides controls for runtimes without goal-control support', () => {
      renderPanel({ sdkType: 'claude' });
      expect(screen.getByTestId('goal-tag')).toBeTruthy();
      expect(screen.queryByTestId('goal-controls')).toBeNull();
    });
  });

  describe('after the goal finishes', () => {
    beforeEach(() => {
      const store = useGoalStore.getState();
      store.applyWidget('session-1', WIDGET);
      store.applyStatus('session-1', undefined);
      store.applyNotification('session-1', '🎯 Goal achieved in 2 agent runs: "Create three files…"');
    });

    it('keeps a summary of the last goal instead of disappearing', () => {
      renderPanel();

      const tag = screen.getByTestId('goal-tag');
      expect(tag.textContent).toContain('Last goal');
      expect(tag.textContent).toContain('achieved');
      expect(tag.textContent).toContain('2 runs');
    });

    it('expands the finished goal to its full detail', () => {
      setViewport(390);
      renderPanel();
      fireEvent.click(screen.getByTestId('goal-panel-toggle'));
      expect(screen.getByTestId('goal-panel-body').textContent).toContain('Create three files in this workspace');
    });

    it('lists earlier goals from the same session', () => {
      const store = useGoalStore.getState();
      store.applyWidget('session-1', [...WIDGET.slice(0, 2), 'Objective: An earlier objective', ...WIDGET.slice(3)]);
      store.applyStatus('session-1', undefined);

      setViewport(390);
      renderPanel();
      fireEvent.click(screen.getByTestId('goal-panel-toggle'));

      // The newest finished goal is the headline; older ones stay listed below.
      expect(screen.getByTestId('goal-tag').textContent).toContain('Last goal');
      expect(screen.getByTestId('goal-panel-body').textContent).toContain('An earlier objective');
      expect(screen.getByTestId('goal-history').textContent).toContain('Create three files in this workspace');
    });

    it('marks the last-known verification state as stale on a finished goal', () => {
      setViewport(390);
      renderPanel();
      fireEvent.click(screen.getByTestId('goal-panel-toggle'));

      // The header carries the real outcome; the body must not imply the
      // pre-completion verification line was the final word.
      expect(screen.getByTestId('goal-panel-body').textContent).toContain('Verification (last update)');
      expect(screen.getByTestId('goal-tag').textContent).toContain('achieved');
    });

    it('offers no live controls for a finished goal', () => {
      renderPanel();
      expect(screen.queryByTestId('goal-controls')).toBeNull();
    });
  });
});
