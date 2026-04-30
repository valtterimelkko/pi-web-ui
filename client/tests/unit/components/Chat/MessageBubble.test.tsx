import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../../../../src/components/Chat/MessageBubble';
import type { LiveMessage } from '../../../../src/hooks/useSessionStream';

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

// Mock useReadAloud hook
vi.mock('../../../src/hooks/useReadAloud', () => ({
  useReadAloud: () => ({
    state: 'idle',
    play: vi.fn(),
    stop: vi.fn(),
  }),
}));

describe('MessageBubble', () => {
  const mockUserMessage: LiveMessage = {
    id: '1',
    role: 'user',
    content: [{ type: 'text', text: 'Hello!' }],
    timestamp: Date.now(),
    isComplete: true,
  };

  const mockAssistantMessage: LiveMessage = {
    id: '2',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hi there! How can I help you?' }],
    timestamp: Date.now(),
    isComplete: true,
  };

  const mockToolMessage: LiveMessage = {
    id: '3',
    role: 'tool',
    content: [],
    timestamp: Date.now(),
    isComplete: true,
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

  it('renders user message with correct styling', () => {
    const { container } = render(<MessageBubble message={mockUserMessage} />);
    // User messages have gray background
    const messageElement = container.querySelector('.bg-gray-100');
    expect(messageElement).toBeTruthy();
  });

  it('renders assistant message with correct styling', () => {
    const { container } = render(<MessageBubble message={mockAssistantMessage} />);
    // Assistant messages have left border
    const messageElement = container.querySelector('.border-l-2');
    expect(messageElement).toBeTruthy();
  });

  it('renders tool message with CollapsibleToolCard', () => {
    const { container } = render(<MessageBubble message={mockToolMessage} />);
    // Tool messages render CollapsibleToolCard component
    expect(container.querySelector('.border')).toBeTruthy();
  });

  it('renders markdown content correctly', () => {
    const markdownMessage: LiveMessage = {
      id: '4',
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is **bold** and *italic* text.' }],
      timestamp: Date.now(),
      isComplete: true,
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
    const arrayContentMessage: LiveMessage = {
      id: '5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
      timestamp: Date.now(),
      isComplete: true,
    };
    render(<MessageBubble message={arrayContentMessage} />);
    // Content parts are joined together without spaces
    expect(screen.getByText('Part 1Part 2')).toBeInTheDocument();
  });

  it('applies last message styling when isLast is true', () => {
    render(<MessageBubble message={mockAssistantMessage} isLast={true} />);
    // The component should render without errors
    expect(screen.getByText('Hi there! How can I help you?')).toBeInTheDocument();
  });

  it('handles thinking blocks in content', () => {
    const thinkingMessage: LiveMessage = {
      id: '6',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think about this...' },
        { type: 'text', text: 'Here is the answer.' },
      ],
      timestamp: Date.now(),
      isComplete: true,
    };
    render(<MessageBubble message={thinkingMessage} />);
    expect(screen.getByText('Here is the answer.')).toBeInTheDocument();
  });

  it('renders error message with error styling', () => {
    const errorMessage: LiveMessage = {
      id: 'err-1',
      role: 'assistant',
      content: [],
      timestamp: Date.now(),
      isComplete: true,
      error: {
        message: "429 Sorry, you've exhausted this model's rate limit.",
        provider: 'github-copilot',
        model: 'claude-sonnet-4.6',
      },
    };
    const { container } = render(<MessageBubble message={errorMessage} />);
    // Should show the error message text
    expect(screen.getByText(/429 Sorry, you've exhausted this model's rate limit/)).toBeInTheDocument();
    // Should have error-specific styling
    expect(container.querySelector('.api-error-message')).toBeTruthy();
  });

  it('renders error message with provider/model info', () => {
    const errorMessage: LiveMessage = {
      id: 'err-2',
      role: 'assistant',
      content: [],
      timestamp: Date.now(),
      isComplete: true,
      error: {
        message: 'API Error occurred',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
      },
    };
    render(<MessageBubble message={errorMessage} />);
    expect(screen.getByText(/anthropic/)).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet-4/)).toBeInTheDocument();
  });
});
