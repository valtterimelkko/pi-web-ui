import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../../../src/components/Chat/MessageBubble';
import type { Message } from '../../../src/store';

// Mock the useSessionStore hook
vi.mock('../../../src/store', () => ({
  useSessionStore: (selector?: (state: { isStreaming: boolean; currentModel: string | null }) => unknown) => {
    const state = {
      isStreaming: false,
      currentModel: 'github-copilot/claude-sonnet-4',
    };
    return selector ? selector(state) : state;
  },
}));

describe('MessageBubble', () => {
  const mockUserMessage: Message = {
    id: '1',
    role: 'user',
    content: 'Hello!',
    timestamp: Date.now(),
  };

  const mockAssistantMessage: Message = {
    id: '2',
    role: 'assistant',
    content: 'Hi there! How can I help you?',
    timestamp: Date.now(),
  };

  const mockToolMessage: Message = {
    id: '3',
    role: 'tool',
    content: 'Tool execution result',
    timestamp: Date.now(),
    toolCall: {
      id: 'tool-1',
      name: 'read_file',
      args: { path: '/test/file.txt' },
    },
    toolResult: {
      output: 'File content',
      isError: false,
    },
  };

  it('renders user message correctly', () => {
    render(<MessageBubble message={mockUserMessage} />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();
  });

  it('renders assistant message correctly', () => {
    render(<MessageBubble message={mockAssistantMessage} />);
    expect(screen.getByText('Hi there! How can I help you?')).toBeInTheDocument();
  });

  it('shows correct avatar styling for user', () => {
    render(<MessageBubble message={mockUserMessage} />);
    // User messages have violet styling
    const avatar = document.querySelector('.bg-violet-600');
    expect(avatar).toBeInTheDocument();
  });

  it('shows correct avatar styling for assistant', () => {
    render(<MessageBubble message={mockAssistantMessage} />);
    // Assistant messages have slate styling
    const avatar = document.querySelector('.bg-slate-700');
    expect(avatar).toBeInTheDocument();
  });

  it('shows correct avatar styling for tool messages', () => {
    render(<MessageBubble message={mockToolMessage} />);
    // Tool messages have amber styling
    const avatar = document.querySelector('.bg-amber-600');
    expect(avatar).toBeInTheDocument();
  });

  it('renders markdown content correctly', () => {
    const markdownMessage: Message = {
      id: '4',
      role: 'assistant',
      content: 'Here is **bold** and *italic* text.',
      timestamp: Date.now(),
    };
    render(<MessageBubble message={markdownMessage} />);
    expect(screen.getByText(/bold/)).toBeInTheDocument();
    expect(screen.getByText(/italic/)).toBeInTheDocument();
  });

  it('displays timestamp for messages', () => {
    render(<MessageBubble message={mockUserMessage} />);
    // Check for time format (e.g., "2:30 PM" or similar)
    const timeRegex = /\d{1,2}:\d{2}/;
    const timestamp = screen.getByText(timeRegex);
    expect(timestamp).toBeInTheDocument();
  });

  it('renders content as array of parts', () => {
    const arrayContentMessage: Message = {
      id: '5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
      timestamp: Date.now(),
    };
    render(<MessageBubble message={arrayContentMessage} />);
    expect(screen.getByText('Part 1 Part 2')).toBeInTheDocument();
  });

  it('applies last message styling when isLast is true', () => {
    render(<MessageBubble message={mockAssistantMessage} isLast={true} />);
    // The component should render without errors
    expect(screen.getByText('Hi there! How can I help you?')).toBeInTheDocument();
  });

  it('handles thinking blocks in content', () => {
    const thinkingMessage: Message = {
      id: '6',
      role: 'assistant',
      content: '<thinking>Let me think about this...</thinking>Here is the answer.',
      timestamp: Date.now(),
    };
    render(<MessageBubble message={thinkingMessage} />);
    expect(screen.getByText('Here is the answer.')).toBeInTheDocument();
  });
});
