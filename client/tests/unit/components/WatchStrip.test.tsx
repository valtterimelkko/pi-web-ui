import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useWatchSurfacingStore } from '../../../src/store/watchSurfacingStore';
import { useSessionStore } from '../../../src/store/sessionStore';
import { WatchStrip } from '../../../src/components/Chat/WatchStrip';
import type { WatchCardProjection } from '@pi-web-ui/shared';

const watch = (overrides: Partial<WatchCardProjection> = {}): WatchCardProjection => ({
  watchId: 'watch-child-9',
  targetSessionId: 'child-9',
  status: 'active',
  conditions: [{ type: 'event_type', description: 'event agent_end' }],
  ...overrides,
});

describe('watchSurfacingStore', () => {
  beforeEach(() => {
    useWatchSurfacingStore.setState({ bySession: {} });
  });

  it('upserts a watch card on watch_registered', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'watch_registered',
      sessionId: 'parent-1',
      watch: watch({ label: 'msb13-fxa-agent_end' }),
    } as never);
    expect(useWatchSurfacingStore.getState().getWatch('parent-1', 'watch-child-9')?.label).toBe('msb13-fxa-agent_end');
  });

  it('marks fired with delivery kind on watch_fired', () => {
    useWatchSurfacingStore.getState().upsert('parent-1', watch());
    useSessionStore.getState().handleServerMessage({
      type: 'watch_fired',
      sessionId: 'parent-1',
      watchId: 'watch-child-9',
      targetSessionId: 'child-9',
      conditionId: 'c0',
      deliveryKind: 'steer',
    } as never);
    const w = useWatchSurfacingStore.getState().getWatch('parent-1', 'watch-child-9');
    expect(w?.status).toBe('fired');
    expect(w?.deliveryKind).toBe('steer');
  });

  it('replaces the card when the same watch re-registers', () => {
    useWatchSurfacingStore.getState().upsert('parent-1', watch({ status: 'fired' }));
    useSessionStore.getState().handleServerMessage({
      type: 'watch_registered',
      sessionId: 'parent-1',
      watch: watch({ status: 'active' }),
    } as never);
    expect(useWatchSurfacingStore.getState().getWatch('parent-1', 'watch-child-9')?.status).toBe('active');
  });
});

describe('WatchStrip', () => {
  beforeEach(() => {
    useWatchSurfacingStore.setState({ bySession: {} });
    useSessionStore.setState({ currentSessionId: 's1' });
  });

  it('renders nothing without watches', () => {
    const { container } = render(<WatchStrip sessionId="s1" />);
    expect(container.textContent).toBe('');
  });

  it('renders armed and fired watches with condition descriptions', () => {
    useWatchSurfacingStore.getState().upsert('s1', watch({ label: 'msb13-fxa-agent_end' }));
    useWatchSurfacingStore.getState().upsert('s1', watch({ watchId: 'w2', label: 'g-fxb', status: 'fired', deliveryKind: 'steer' }));
    render(<WatchStrip sessionId="s1" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('msb13-fxa-agent_end');
    expect(text).toContain('event agent_end');
    expect(text).toContain('g-fxb');
    expect(text).toContain('steer');
  });
});
