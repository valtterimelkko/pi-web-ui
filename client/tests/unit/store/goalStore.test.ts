import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGoalStore, GOAL_HISTORY_LIMIT } from '../../../src/store/goalStore';

const widget = (overrides: Partial<{ status: string; objective: string; runs: number }> = {}): string[] => [
  '🎯 Goal Status',
  `Status: ${overrides.status ?? '▶ Running'}`,
  `Objective: ${overrides.objective ?? 'Create three files'}`,
  'Started: 7/25/2026, 4:41:01 PM',
  `Agent runs: ${overrides.runs ?? 1}`,
  'Max runs: 4',
  'Continuation interval: 30s (rung 1/4)',
  'Token spend: 38,287 / 5,000,000 billed input tokens',
];

describe('goalStore', () => {
  beforeEach(() => {
    useGoalStore.setState({ bySession: {} });
    vi.useRealTimers();
  });

  describe('live goal tracking', () => {
    it('records the current goal when a widget arrives', () => {
      useGoalStore.getState().applyWidget('s1', widget());
      const view = useGoalStore.getState().getGoalView('s1');

      expect(view.current).not.toBeNull();
      expect(view.current!.model.objective).toBe('Create three files');
      expect(view.current!.widgetVisible).toBe(true);
      expect(view.history).toEqual([]);
    });

    it('refreshes the model and updatedAt on later widgets but keeps one record', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget({ runs: 1 }));
      const firstSeen = useGoalStore.getState().getGoalView('s1').current!.firstSeenAt;
      store.applyWidget('s1', widget({ runs: 2 }));

      const view = useGoalStore.getState().getGoalView('s1');
      expect(view.current!.model.runs).toBe(2);
      expect(view.current!.firstSeenAt).toBe(firstSeen);
      expect(view.history).toEqual([]);
    });

    it('keeps the run-boundary timestamp when the server replays the same payload', async () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget({ runs: 1 }));
      const firstUpdatedAt = useGoalStore.getState().getGoalView('s1').current!.updatedAt;

      await new Promise((resolve) => setTimeout(resolve, 5));
      store.applyWidget('s1', widget({ runs: 1 })); // replay on re-subscribe
      expect(useGoalStore.getState().getGoalView('s1').current!.updatedAt).toBe(firstUpdatedAt);

      store.applyWidget('s1', widget({ runs: 2 })); // real run boundary
      expect(useGoalStore.getState().getGoalView('s1').current!.updatedAt).toBeGreaterThan(firstUpdatedAt);
    });

    it('ignores widget payloads that are not goal-engine content', () => {
      useGoalStore.getState().applyWidget('s1', ['some other widget']);
      expect(useGoalStore.getState().getGoalView('s1').current).toBeNull();
    });

    it('keeps sessions isolated', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget({ objective: 'A' }));
      store.applyWidget('s2', widget({ objective: 'B' }));

      expect(useGoalStore.getState().getGoalView('s1').current!.model.objective).toBe('A');
      expect(useGoalStore.getState().getGoalView('s2').current!.model.objective).toBe('B');
    });
  });

  describe('widget visibility vs goal end', () => {
    it('treats a bare widget_cleared as "hidden", not as the goal ending', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.clearWidget('s1');

      const view = useGoalStore.getState().getGoalView('s1');
      expect(view.current).not.toBeNull();
      expect(view.current!.widgetVisible).toBe(false);
      expect(view.history).toEqual([]);
    });

    it('re-shows the widget when the extension sends content again', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.clearWidget('s1');
      store.applyWidget('s1', widget());

      expect(useGoalStore.getState().getGoalView('s1').current!.widgetVisible).toBe(true);
    });

    it('archives the goal when the status is cleared (the real end signal)', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.clearWidget('s1');
      store.applyStatus('s1', undefined);

      const view = useGoalStore.getState().getGoalView('s1');
      expect(view.current).toBeNull();
      expect(view.history).toHaveLength(1);
      expect(view.history[0].endedAt).toBeGreaterThan(0);
      expect(view.history[0].model.objective).toBe('Create three files');
    });

    it('does not archive anything when no goal was running', () => {
      useGoalStore.getState().applyStatus('s1', undefined);
      const view = useGoalStore.getState().getGoalView('s1');
      expect(view.current).toBeNull();
      expect(view.history).toEqual([]);
    });

    it('keeps the current goal when the status is still present', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.applyStatus('s1', '🎯 ▶ Running — Run 2');

      const view = useGoalStore.getState().getGoalView('s1');
      expect(view.current).not.toBeNull();
      expect(view.current!.statusText).toBe('🎯 ▶ Running — Run 2');
      expect(view.history).toEqual([]);
    });
  });

  describe('outcome from the completion notification', () => {
    it('labels the archived goal as achieved and records the run count', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.applyStatus('s1', undefined);
      store.applyNotification('s1', '🎯 Goal achieved in 2 agent runs: "Create three files…"');

      const [record] = useGoalStore.getState().getGoalView('s1').history;
      expect(record.outcome).toBe('achieved');
      expect(record.outcomeRuns).toBe(2);
    });

    it('labels a cleared goal', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.applyStatus('s1', undefined);
      store.applyNotification('s1', '🗑 Goal cleared.');

      expect(useGoalStore.getState().getGoalView('s1').history[0].outcome).toBe('cleared');
    });

    it('ignores unrelated notifications and stale ones', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.applyStatus('s1', undefined);
      store.applyNotification('s1', '⏳ Continuation slowed to 30s');

      const [record] = useGoalStore.getState().getGoalView('s1').history;
      expect(record.outcome).toBe('ended');
    });

    it('does not retro-label an old record long after it ended', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.applyStatus('s1', undefined);
      const stale = Date.now() - 10 * 60 * 1000;
      useGoalStore.setState((state) => ({
        bySession: {
          ...state.bySession,
          s1: { ...state.bySession.s1, history: [{ ...state.bySession.s1.history[0], endedAt: stale }] },
        },
      }));
      store.applyNotification('s1', '🎯 Goal achieved in 9 agent runs: "x"');

      expect(useGoalStore.getState().getGoalView('s1').history[0].outcome).toBe('ended');
    });
  });

  describe('history bounds', () => {
    it('keeps the most recent goals only, newest first', () => {
      const store = useGoalStore.getState();
      for (let i = 1; i <= GOAL_HISTORY_LIMIT + 2; i++) {
        store.applyWidget('s1', widget({ objective: `goal ${i}` }));
        store.applyStatus('s1', undefined);
      }

      const { history } = useGoalStore.getState().getGoalView('s1');
      expect(history).toHaveLength(GOAL_HISTORY_LIMIT);
      expect(history[0].model.objective).toBe(`goal ${GOAL_HISTORY_LIMIT + 2}`);
      expect(history[history.length - 1].model.objective).toBe('goal 3');
    });

    it('drops all state for a forgotten session', () => {
      const store = useGoalStore.getState();
      store.applyWidget('s1', widget());
      store.forgetSession('s1');
      expect(useGoalStore.getState().getGoalView('s1')).toEqual({ current: null, history: [] });
    });
  });
});
