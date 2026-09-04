import { describe, it, expect, beforeEach } from 'vitest';
import { useBackgroundChildrenStore } from '../../../src/store/backgroundChildrenStore';
import { useSessionStore } from '../../../src/store/sessionStore';
import type { ChildCardProjection } from '@pi-web-ui/shared';

const child = (overrides: Partial<ChildCardProjection> = {}): ChildCardProjection => ({
  id: 'bg_1',
  kind: 'background_subagent',
  status: 'running',
  label: 'web-researcher',
  ...overrides,
});

describe('backgroundChildrenStore', () => {
  beforeEach(() => {
    useBackgroundChildrenStore.setState({ bySession: {} });
  });

  it('stores and replaces the child list per session', () => {
    const store = useBackgroundChildrenStore.getState();
    store.applyChildren('s1', [child()]);
    store.applyChildren('s1', [child({ id: 'bg_2' })]);
    store.applyChildren('s2', [child({ id: 'bg_3' })]);

    expect(useBackgroundChildrenStore.getState().bySession['s1']).toHaveLength(1);
    expect(useBackgroundChildrenStore.getState().bySession['s1']![0].id).toBe('bg_2');
    expect(useBackgroundChildrenStore.getState().bySession['s2']).toHaveLength(1);
  });

  it('looks up a single child by id within a session', () => {
    useBackgroundChildrenStore.getState().applyChildren('s1', [child({ id: 'bg_9', status: 'completed' })]);
    expect(useBackgroundChildrenStore.getState().getChild('s1', 'bg_9')?.status).toBe('completed');
    expect(useBackgroundChildrenStore.getState().getChild('s1', 'missing')).toBeUndefined();
    expect(useBackgroundChildrenStore.getState().getChild('other', 'bg_9')).toBeUndefined();
  });

  it('keeps a settled child visible when a later push omits it (prune-protected lookup)', () => {
    useBackgroundChildrenStore.getState().applyChildren('s1', [child({ id: 'bg_9', status: 'completed' })]);
    // Extension prunes settled tasks from the snapshot; the card still resolves.
    useBackgroundChildrenStore.getState().applyChildren('s1', []);
    expect(useBackgroundChildrenStore.getState().getChild('s1', 'bg_9')).toBeUndefined();
  });
});

describe('sessionStore routes background_child_state into the child store', () => {
  beforeEach(() => {
    useBackgroundChildrenStore.setState({ bySession: {} });
  });

  it('handles the top-level broadcast message', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'background_child_state',
      sessionId: 'sess-7',
      children: [child({ id: 'bg_k1', status: 'completed' })],
    } as never);

    expect(useBackgroundChildrenStore.getState().getChild('sess-7', 'bg_k1')?.status).toBe('completed');
  });

  it('handles the event wrapped in a session_event envelope', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'session_event',
      sessionId: 'sess-8',
      event: { type: 'background_child_state', sessionId: 'sess-8', children: [child({ id: 'bg_k2' })] },
    } as never);

    expect(useBackgroundChildrenStore.getState().getChild('sess-8', 'bg_k2')?.status).toBe('running');
  });
});

describe('internal-api child events (contract 1.34.0 Track B)', () => {
  beforeEach(() => {
    useBackgroundChildrenStore.setState({ bySession: {} });
  });

  it('upserts a child on child_dispatched (top-level)', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'child_dispatched',
      sessionId: 'parent-1',
      child: { id: 'child-9', kind: 'internal_api_child', status: 'dispatched', label: 'pi child child-9', runtime: 'pi', model: 'zai/glm-5.3-flash', parentSessionId: 'parent-1' },
    } as never);
    expect(useBackgroundChildrenStore.getState().getChild('parent-1', 'child-9')?.status).toBe('dispatched');
  });

  it('marks the child completed on child_turn_ended', () => {
    useBackgroundChildrenStore.getState().applyChildren('parent-1', [
      { id: 'child-9', kind: 'internal_api_child', status: 'running', label: 'x', parentSessionId: 'parent-1' },
    ]);
    useSessionStore.getState().handleServerMessage({
      type: 'child_turn_ended',
      sessionId: 'parent-1',
      child: { id: 'child-9', kind: 'internal_api_child', status: 'completed', label: 'x', parentSessionId: 'parent-1', endedAt: 123 },
    } as never);
    expect(useBackgroundChildrenStore.getState().getChild('parent-1', 'child-9')?.status).toBe('completed');
  });

  it('handles the wrapped envelope form', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'session_event',
      sessionId: 'parent-1',
      event: { type: 'child_dispatched', sessionId: 'parent-1', child: { id: 'c-2', kind: 'internal_api_child', status: 'dispatched', label: 'y', parentSessionId: 'parent-1' } },
    } as never);
    expect(useBackgroundChildrenStore.getState().getChild('parent-1', 'c-2')?.status).toBe('dispatched');
  });
});
