import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageBubble } from '../src/MessageBubble';
import { ChildrenStrip } from '../src/ChildrenStrip';
import { SessionViewProvider, staticSessionView } from '../src/SessionView';
import type { LiveMessage } from '@pi-web-ui/session-core/model';

const assistant: LiveMessage = {
  id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Hello from an invented session.' }],
  timestamp: 0, isComplete: true,
};

describe('session-ui without a host store', () => {
  it('renders a bubble with inert defaults and no read-aloud button', () => {
    render(<MessageBubble message={assistant} isLast />);
    expect(screen.getByText('Hello from an invented session.')).toBeTruthy();
    expect(screen.queryByLabelText(/read aloud/i)).toBeNull();
  });

  it('copies through the host-supplied copy()', async () => {
    const copy = vi.fn(async () => true);
    render(
      <SessionViewProvider value={staticSessionView({ copy })}>
        <MessageBubble message={assistant} isLast />
      </SessionViewProvider>,
    );
    fireEvent.click(screen.getAllByLabelText('Copy message to clipboard')[0]);
    await waitFor(() => expect(copy).toHaveBeenCalledWith('Hello from an invented session.', 'Message copied to clipboard'));
  });

  it('renders exactly ONE copy affordance per message at every width (census: two on phones)', () => {
    // The bubble used to draw two action rows (a top-right overlay and a
    // bottom row), each with its own copy button. Below Tailwind's sm
    // breakpoint (640px) neither is hover-hidden, so phones showed both at
    // once — the command centre had to hide one with local CSS. The shared
    // package now renders a single copy affordance structurally, so every
    // width has exactly one.
    render(
      <SessionViewProvider value={staticSessionView({})}>
        <MessageBubble message={assistant} isLast />
      </SessionViewProvider>,
    );
    expect(screen.getAllByLabelText(/Copy message to clipboard|Copied to clipboard/)).toHaveLength(1);
  });

  it('routes tool rows to the tool card', () => {
    render(
      <MessageBubble
        message={{
          id: 't1', role: 'tool', content: [], timestamp: 0, isComplete: true,
          toolCall: { id: 't1', name: 'bash', args: { command: 'echo sample' } },
          toolResult: { output: 'sample', isError: false },
        }}
      />,
    );
    expect(screen.getByText('echo sample')).toBeTruthy();
  });

  it('renders strips from props', () => {
    render(<ChildrenStrip childCards={[{ id: 'c1', kind: 'background_subagent', status: 'running', label: 'sample-child' }]} />);
    expect(screen.getByTestId('children-strip').textContent).toContain('sample-child');
  });
});
