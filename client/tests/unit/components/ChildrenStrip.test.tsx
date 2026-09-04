import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChildrenStrip } from '../../../src/components/Chat/ChildrenStrip';
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

describe('ChildrenStrip', () => {
  beforeEach(() => {
    useBackgroundChildrenStore.setState({ bySession: {} });
    useSessionStore.setState({ currentSessionId: 's1' });
  });

  it('renders nothing when no children are running', () => {
    const { container } = render(<ChildrenStrip sessionId="s1" />);
    expect(container.textContent).toBe('');
  });

  it('renders running children with labels and models', () => {
    useBackgroundChildrenStore.getState().applyChildren('s1', [
      child({ id: 'bg_1', label: 'web-researcher', model: 'openai-codex/gpt-5.6-luna' }),
      child({ id: 'c-9', kind: 'internal_api_child', label: 'pi child c-9', runtime: 'pi', model: 'zai/glm-5.3-flash' }),
      child({ id: 'bg_done', status: 'completed' }),
    ]);
    render(<ChildrenStrip sessionId="s1" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('2 children running');
    expect(text).toContain('web-researcher');
    expect(text).toContain('openai-codex/gpt-5.6-luna');
    expect(text).toContain('zai/glm-5.3-flash');
    // Completed children are not listed in the strip:
    expect(text).not.toContain('bg_done');
  });

  it('renders only the requested session', () => {
    useBackgroundChildrenStore.getState().applyChildren('other', [child()]);
    render(<ChildrenStrip sessionId="s1" />);
    expect(document.body.textContent).toBe('');
  });
});
