import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VirtualizedMessageList } from '../../../../src/components/Chat/VirtualizedMessageList';
import type { Message } from '../../../../src/store';
import React from 'react';

// Mock react-virtuoso
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent, atBottomStateChange }: {
    data: Array<{ message: Message; index: number }>;
    itemContent: (index: number, item: { message: Message; index: number }) => React.ReactNode;
    atBottomStateChange?: (atBottom: boolean) => void;
  }) => {
    // Call atBottomStateChange on mount
    React.useEffect(() => {
      atBottomStateChange?.(true);
    }, [atBottomStateChange]);
    
    if (data.length === 0) {
      return <div data-testid="virtuoso-empty">No messages</div>;
    }
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={item.message.id} data-testid={`message-${item.index}`}>
            {itemContent(index, item)}
          </div>
        ))}
      </div>
    );
  },
}));

// Mock MessageBubble to avoid complex rendering
vi.mock('../../../../src/components/Chat/MessageBubble', () => ({
  MessageBubble: ({ message, isLast }: { message: Message; isLast: boolean }) => (
    <div data-testid={`message-bubble-${message.id}`}>
      {message.role}: {typeof message.content === 'string' ? message.content : 'complex content'}
      {isLast && <span data-testid="is-last-indicator" />}
    </div>
  ),
}));

describe('VirtualizedMessageList', () => {
  const mockMessages: Message[] = [
    { id: '1', role: 'user', content: 'Hello', timestamp: 1000 },
    { id: '2', role: 'assistant', content: 'Hi there!', timestamp: 2000 },
    { id: '3', role: 'user', content: 'How are you?', timestamp: 3000 },
  ];

  const defaultProps = {
    messages: mockMessages,
    isStreaming: false,
  };

  it('renders messages using virtualization', () => {
    render(<VirtualizedMessageList {...defaultProps} />);
    
    expect(screen.getByTestId('virtuoso-mock')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-2')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-3')).toBeInTheDocument();
  });

  it('shows empty state when no messages', () => {
    render(<VirtualizedMessageList messages={[]} isStreaming={false} />);
    
    // Component renders EmptyState component (not virtuoso)
    expect(screen.getByText(/Ready to help|Create a session/i)).toBeInTheDocument();
  });

  it('marks last message with isLast prop', () => {
    render(<VirtualizedMessageList {...defaultProps} />);
    
    // Only the last message should have the is-last indicator
    const lastMessage = screen.getByTestId('message-bubble-3');
    expect(lastMessage.querySelector('[data-testid="is-last-indicator"]')).toBeInTheDocument();
  });

  it('calls onAtBottomChange callback', () => {
    const onAtBottomChange = vi.fn();
    render(<VirtualizedMessageList {...defaultProps} onAtBottomChange={onAtBottomChange} />);
    
    expect(onAtBottomChange).toHaveBeenCalledWith(true);
  });

  it('handles streaming state', () => {
    render(<VirtualizedMessageList {...defaultProps} isStreaming={true} />);
    
    // Should render without errors during streaming
    expect(screen.getByTestId('virtuoso-mock')).toBeInTheDocument();
  });

  it('handles messages with array content', () => {
    const messagesWithArrayContent: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'thinking', thinking: 'Thinking...' },
        ],
        timestamp: 1000,
      },
    ];
    
    render(<VirtualizedMessageList messages={messagesWithArrayContent} isStreaming={false} />);
    
    expect(screen.getByTestId('message-bubble-1')).toBeInTheDocument();
  });

  it('filters out non-read tool messages from visible list', () => {
    const bashToolMessage: Message = {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 1000,
      toolCall: {
        id: 'call-1',
        name: 'bash',
        args: { command: 'ls -la' },
      },
      toolResult: {
        output: 'total 0',
        isError: false,
      },
    };
    
    // Non-read tool messages should be filtered out
    render(<VirtualizedMessageList messages={[bashToolMessage]} isStreaming={false} />);
    
    // Should show empty state since the only message is a non-read tool message
    expect(screen.getByText(/Ready to help|Create a session/i)).toBeInTheDocument();
  });

  it('shows read tool messages for skill-loading visibility', () => {
    const readToolMessage: Message = {
      id: 'read-1',
      role: 'tool',
      content: '',
      timestamp: 1000,
      toolCall: {
        id: 'call-1',
        name: 'read',
        args: { path: '/root/.claude/skills/lecture-website/SKILL.md' },
      },
      toolResult: {
        output: 'Skill file content here',
        isError: false,
      },
    };
    
    // Read tool messages should be visible (for skill-loading visibility like Kimi)
    render(<VirtualizedMessageList messages={[readToolMessage]} isStreaming={false} />);
    
    // Should show the read tool message (not empty state)
    expect(screen.getByTestId('message-bubble-read-1')).toBeInTheDocument();
  });

  it('shows subagent tool messages (unlike other tool messages)', () => {
    const subagentMessage: Message = {
      id: 'subagent-1',
      role: 'tool',
      content: JSON.stringify({
        mode: 'parallel',
        tasks: [
          { agent: 'coder', task: 'Refactor auth', result: 'Done' },
        ],
      }),
      timestamp: 1000,
      toolCall: {
        id: 'call-1',
        name: 'subagent',
        args: { tasks: [{ agent: 'coder', task: 'Refactor auth' }] },
      },
      toolResult: {
        output: JSON.stringify({ mode: 'parallel', tasks: [{ agent: 'coder', task: 'Refactor auth', result: 'Done' }] }),
        isError: false,
      },
    };
    
    // Subagent tool messages should be visible (unlike other tool messages)
    render(<VirtualizedMessageList messages={[subagentMessage]} isStreaming={false} />);
    
    // Should show the subagent message (not empty state)
    expect(screen.getByTestId('message-bubble-subagent-1')).toBeInTheDocument();
  });

  it('filters out toolResult messages from visible list', () => {
    // Pi SDK sends message_start with role='toolResult' containing massive raw content
    const toolResultMessage: Message = {
      id: 'toolresult-1',
      role: 'toolResult' as Message['role'],
      content: [{ type: 'text', text: 'Web search results for: "AI trends"...' + 'x'.repeat(5000) }],
      timestamp: 1500,
    };
    
    render(<VirtualizedMessageList messages={[toolResultMessage]} isStreaming={false} />);
    expect(screen.getByText(/Ready to help|Create a session/i)).toBeInTheDocument();
  });

  it('shows assistant messages but filters tool and toolResult messages in mixed list', () => {
    const mixedMessages: Message[] = [
      { id: '1', role: 'user', content: 'Hello', timestamp: 1000 },
      { id: '2', role: 'assistant', content: 'Processing...', timestamp: 2000 },
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        timestamp: 2500,
        toolCall: { id: 'call-1', name: 'web_search', args: { query: 'test' } },
        toolResult: { output: 'results', isError: false },
      },
      {
        id: 'toolresult-1',
        role: 'toolResult' as Message['role'],
        content: [{ type: 'text', text: 'Web search results for: "test"...' + 'x'.repeat(5000) }],
        timestamp: 2600,
      },
      { id: '3', role: 'assistant', content: 'Here are the results', timestamp: 3000 },
    ];
    
    render(<VirtualizedMessageList messages={mixedMessages} isStreaming={false} />);
    
    // User and assistant messages visible
    expect(screen.getByTestId('message-bubble-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-2')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-3')).toBeInTheDocument();
    // Tool message should NOT be visible
    expect(screen.queryByTestId('message-bubble-tool-1')).not.toBeInTheDocument();
    // toolResult message should NOT be visible
    expect(screen.queryByTestId('message-bubble-toolresult-1')).not.toBeInTheDocument();
  });

  it('exposes scrollToIndex method via ref', () => {
    const ref = React.createRef<{ scrollToIndex: (index: number, behavior?: 'auto' | 'smooth') => void; scrollToBottom: () => void }>();
    render(<VirtualizedMessageList {...defaultProps} ref={ref} />);
    
    // Method should exist
    expect(ref.current?.scrollToIndex).toBeDefined();
    expect(typeof ref.current?.scrollToIndex).toBe('function');
  });

  it('exposes scrollToBottom method via ref', () => {
    const ref = React.createRef<{ scrollToIndex: (index: number, behavior?: 'auto' | 'smooth') => void; scrollToBottom: () => void }>();
    render(<VirtualizedMessageList {...defaultProps} ref={ref} />);
    
    // Method should exist
    expect(ref.current?.scrollToBottom).toBeDefined();
    expect(typeof ref.current?.scrollToBottom).toBe('function');
  });

  it('handles large number of messages efficiently', () => {
    // Generate 100 messages
    const manyMessages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant' as const,
      content: `Message ${i}`,
      timestamp: i * 1000,
    }));
    
    render(<VirtualizedMessageList messages={manyMessages} isStreaming={false} />);
    
    // Should render without performance issues
    expect(screen.getByTestId('virtuoso-mock')).toBeInTheDocument();
  });

  it('updates when messages change', () => {
    const { rerender } = render(<VirtualizedMessageList {...defaultProps} />);
    
    expect(screen.getByTestId('message-bubble-3')).toBeInTheDocument();
    
    // Add a new message
    const newMessages = [
      ...mockMessages,
      { id: '4', role: 'assistant' as const, content: 'New message', timestamp: 4000 },
    ];
    
    rerender(<VirtualizedMessageList messages={newMessages} isStreaming={false} />);
    
    expect(screen.getByTestId('message-bubble-4')).toBeInTheDocument();
  });

  it('handles empty messages array', () => {
    render(<VirtualizedMessageList messages={[]} isStreaming={false} />);
    
    // Component shows empty state with Ready to help text
    expect(screen.getByText(/Ready to help|Create a session/i)).toBeInTheDocument();
  });
});
