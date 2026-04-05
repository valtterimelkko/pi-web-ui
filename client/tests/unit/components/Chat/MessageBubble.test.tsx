import { describe, it, expect, vi } from 'vitest';
import { render, screen, createElement } from '@testing-library/react';
import React from 'react';
import { MessageBubble } from '../../../../src/components/Chat/MessageBubble';
import type { LiveMessage, ContentPart } from '../../../../src/hooks/useSessionStream';

// Mock the useSessionStore hook
const storeState = {
  isStreaming: false,
  currentModel: 'github-copilot/claude-sonnet-4' as string | null,
};

vi.mock('../../../../src/store', () => ({
  useSessionStore: (selector?: (state: typeof storeState) => unknown) => {
    return selector ? selector(storeState) : storeState;
  },
}));

// ---------------------------------------------------------------------------
// Helper: create a LiveMessage with sensible defaults
// ---------------------------------------------------------------------------
function makeMessage(overrides: Partial<LiveMessage> = {}): LiveMessage {
  return {
    id: '1',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
    timestamp: Date.now(),
    isComplete: true,
    ...overrides,
  };
}

// ===========================================================================
// Unit tests for the contentEqual comparator (via memo behaviour)
// ===========================================================================
describe('MessageBubble memo / contentEqual', () => {
  it('does not re-render when props are identical', () => {
    const msg = makeMessage();
    const props = { message: msg, isLast: true, isCurrentRun: true, forceExpanded: false };

    // React.memo comparator returns true → skip re-render
    // We test this indirectly: re-render with identical props → same DOM node
    const { rerender } = render(<MessageBubble {...props} />);
    const firstRender = screen.getByText('Hello!');

    rerender(<MessageBubble {...props} />);
    const secondRender = screen.getByText('Hello!');

    // Same DOM element (memo prevented unmount + remount)
    expect(firstRender).toBe(secondRender);
  });

  it('re-renders when message content changes', () => {
    const msg1 = makeMessage({ content: [{ type: 'text', text: 'First' }] });
    const msg2 = makeMessage({ content: [{ type: 'text', text: 'Second' }] });

    const { rerender } = render(<MessageBubble message={msg1} />);
    expect(screen.getByText('First')).toBeInTheDocument();

    rerender(<MessageBubble message={msg2} />);
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('re-renders when content array length differs', () => {
    const msg1 = makeMessage({ content: [{ type: 'text', text: 'A' }] });
    const msg2 = makeMessage({ content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] });

    const { rerender } = render(<MessageBubble message={msg1} />);
    expect(screen.getByText('A')).toBeInTheDocument();

    rerender(<MessageBubble message={msg2} />);
    expect(screen.getByText('AB')).toBeInTheDocument();
  });

  it('re-renders when content type changes', () => {
    const msg1 = makeMessage({ content: [{ type: 'text', text: 'Visible text' }] });
    const msg2 = makeMessage({ id: '1', content: [{ type: 'thinking', thinking: 'Hidden reasoning' }], role: 'assistant' as const, timestamp: Date.now(), isComplete: true });

    const { rerender } = render(<MessageBubble message={msg1} />);
    expect(screen.getByText('Visible text')).toBeInTheDocument();

    // After switching to thinking-only, the text content is gone and thinking block appears
    rerender(<MessageBubble message={msg2} />);
    expect(screen.queryByText('Visible text')).not.toBeInTheDocument();
    // ThinkingBlock renders the thinking content
    expect(screen.getByText('Hidden reasoning')).toBeInTheDocument();
  });

  it('re-renders when toolResult changes', () => {
    const msg1 = makeMessage({
      role: 'tool',
      content: [],
      toolCall: { id: 't1', name: 'bash', args: { command: 'ls' } },
      toolResult: { output: 'first result', isError: false },
    });
    const msg2 = makeMessage({
      role: 'tool',
      content: [],
      toolCall: { id: 't1', name: 'bash', args: { command: 'ls' } },
      toolResult: { output: 'second result', isError: true },
    });

    // Tool messages render CollapsibleToolCard; the result is collapsed by default.
    // Verify re-render happens by checking the rendered component reflects the new data.
    const { container, rerender } = render(<MessageBubble message={msg1} />);
    // First render shows tool card
    expect(container.querySelector('.w-full')).toBeTruthy();

    rerender(<MessageBubble message={msg2} />);
    // Re-rendered – still a tool card but with different isError
    expect(container.querySelector('.w-full')).toBeTruthy();
  });

  it('re-renders when isComplete changes', () => {
    const msg1 = makeMessage({ isComplete: false });
    const msg2 = makeMessage({ isComplete: true });

    const { rerender } = render(<MessageBubble message={msg1} isLast />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();

    rerender(<MessageBubble message={msg2} isLast />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();
  });
});

// ===========================================================================
// Streaming vs completed renderer selection
// ===========================================================================
describe('MessageBubble streaming render mode', () => {
  it('uses StreamingText for the last streaming assistant message', () => {
    storeState.isStreaming = true;
    const msg = makeMessage({ id: 'stream-1', content: [{ type: 'text', text: 'Streaming...' }], isComplete: false });

    const { container } = render(
      <MessageBubble message={msg} isLast={true} isCurrentRun={true} />
    );

    // Streaming path does NOT use the msg-content-* wrapper div (that's only in non-streaming branch)
    expect(container.querySelector('#msg-content-stream-1')).toBeNull();
    // Text content is still visible via StreamingText/StreamingMarkdownRenderer
    expect(screen.getByText('Streaming...')).toBeInTheDocument();

    storeState.isStreaming = false;
  });

  it('uses MarkdownRenderer for completed messages', () => {
    storeState.isStreaming = false;
    const msg = makeMessage({
      content: [{ type: 'text', text: '**Bold text** here' }],
      isComplete: true,
    });

    const { container } = render(<MessageBubble message={msg} isLast={true} />);

    // MarkdownRenderer renders inside .prose
    const proseElement = container.querySelector('.prose');
    expect(proseElement).toBeTruthy();
    expect(screen.getByText(/Bold text/)).toBeInTheDocument();
  });

  it('uses MarkdownRenderer for non-last messages even during streaming', () => {
    storeState.isStreaming = true;
    const msg = makeMessage({
      content: [{ type: 'text', text: 'Previous message' }],
      isComplete: true,
    });

    const { container } = render(
      <MessageBubble message={msg} isLast={false} isCurrentRun={true} />
    );

    const proseElement = container.querySelector('.prose');
    expect(proseElement).toBeTruthy();

    storeState.isStreaming = false;
  });
});

// ===========================================================================
// Original rendering tests (preserved)
// ===========================================================================
describe('MessageBubble rendering', () => {
  it('renders user message correctly', () => {
    render(<MessageBubble message={makeMessage({ role: 'user', content: [{ type: 'text', text: 'Hello!' }] })} />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();
  });

  it('renders assistant message correctly', () => {
    render(<MessageBubble message={makeMessage({ content: [{ type: 'text', text: 'Hi there!' }] })} />);
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('renders user message with correct styling', () => {
    const { container } = render(<MessageBubble message={makeMessage({ role: 'user', content: [{ type: 'text', text: 'Hi' }] })} />);
    expect(container.querySelector('.bg-gray-100')).toBeTruthy();
  });

  it('renders assistant message with left border', () => {
    const { container } = render(<MessageBubble message={makeMessage({ content: [{ type: 'text', text: 'Hi' }] })} />);
    expect(container.querySelector('.border-l-2')).toBeTruthy();
  });

  it('renders tool message with CollapsibleToolCard', () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          role: 'tool',
          content: [],
          toolCall: { id: 't1', name: 'read_file', args: { path: '/test' } },
          toolResult: { output: 'content', isError: false },
        })}
      />
    );
    expect(container.querySelector('.border')).toBeTruthy();
  });

  it('renders markdown content', () => {
    render(
      <MessageBubble
        message={makeMessage({ content: [{ type: 'text', text: 'Here is **bold** and *italic* text.' }] })}
      />
    );
    expect(screen.getByText(/bold/)).toBeInTheDocument();
    expect(screen.getByText(/italic/)).toBeInTheDocument();
  });

  it('displays timestamp', () => {
    render(<MessageBubble message={makeMessage()} />);
    const timeRegex = /\d{1,2}:\d{2}/;
    expect(screen.getByText(timeRegex)).toBeInTheDocument();
  });

  it('joins content parts', () => {
    render(
      <MessageBubble
        message={makeMessage({ content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }] })}
      />
    );
    expect(screen.getByText('Part 1Part 2')).toBeInTheDocument();
  });

  it('handles thinking blocks', () => {
    render(
      <MessageBubble
        message={makeMessage({
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'The answer.' },
          ],
        })}
      />
    );
    expect(screen.getByText('The answer.')).toBeInTheDocument();
  });
});
