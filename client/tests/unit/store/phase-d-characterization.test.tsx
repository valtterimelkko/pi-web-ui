import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useSessionStore } from '../../../src/store/sessionStore';

/**
 * F1 characterization: components subscribe via NARROW field selectors, so an
 * unrelated store update must NOT rerender a component that only reads a
 * different field. (All F1 targets were audited to use field selectors — no
 * whole-store subscriptions, no composite selectors without shallow equality.)
 */
describe('F1: narrow selectors isolate rerenders', () => {
  function Track({ onChange }: { onChange: () => void }) {
    const id = useSessionStore((s) => s.currentSessionId);
    onChange(); // count renders
    return <div data-testid="tracked">{id ?? 'none'}</div>;
  }

  it('does not rerender when an unrelated field updates', () => {
    const renders = vi.fn();
    render(<Track onChange={renders} />);
    const before = renders.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    // An unrelated persisted field changes (the component only reads currentSessionId).
    act(() => {
      useSessionStore.setState({ archivedSessionPaths: ['/tmp/unrelated.jsonl'] });
    });
    expect(renders.mock.calls.length).toBe(before); // no rerender
  });

  it('rerenders when the subscribed field updates', () => {
    const renders = vi.fn();
    render(<Track onChange={renders} />);
    const before = renders.mock.calls.length;
    act(() => {
      useSessionStore.setState({ currentSessionId: 'session-f1-related' });
    });
    expect(renders.mock.calls.length).toBe(before + 1); // rerendered
    expect(screen.getByTestId('tracked').textContent).toBe('session-f1-related');
  });
});
