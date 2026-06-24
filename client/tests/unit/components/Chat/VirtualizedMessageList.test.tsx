import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VirtualizedMessageList } from '../../../../src/components/Chat/VirtualizedMessageList';
import type { LiveMessage } from '../../../../src/hooks/useSessionStream';
import React from 'react';

// Mock react-virtuoso
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent, atBottomStateChange }: {
    data: Array<{ message: LiveMessage; index: number }>;
    itemContent: (index: number, item: { message: LiveMessage; index: number }) => React.ReactNode;
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
  MessageBubble: ({ message, isLast }: { message: LiveMessage; isLast: boolean }) => (
    <div data-testid={`message-bubble-${message.id}`}>
      {message.role}: {Array.isArray(message.content) ? message.content.map(c => c.text || c.thinking || '').join('') : 'complex content'}
      {isLast && <span data-testid="is-last-indicator" />}
    </div>
  ),
}));

describe('VirtualizedMessageList', () => {
  const mockMessages: LiveMessage[] = [
    { id: '1', role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000, isComplete: true },
    { id: '2', role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }], timestamp: 2000, isComplete: true },
    { id: '3', role: 'user', content: [{ type: 'text', text: 'How are you?' }], timestamp: 3000, isComplete: true },
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
    const messagesWithArrayContent: LiveMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'thinking', thinking: 'Thinking...' },
        ],
        timestamp: 1000,
        isComplete: true,
      },
    ];

    render(<VirtualizedMessageList messages={messagesWithArrayContent} isStreaming={false} />);

    expect(screen.getByTestId('message-bubble-1')).toBeInTheDocument();
  });

  it('filters out unknown (non-visible) tool messages from visible list', () => {
    // Common tools (bash, web_search, …) are now shown as cards. Tools NOT in the
    // visible-tool allowlist (e.g. arbitrary MCP tools) are still filtered out.
    const unknownToolMessage: LiveMessage = {
      id: 'tool-1',
      role: 'tool',
      content: [],
      timestamp: 1000,
      isComplete: true,
      toolCall: {
        id: 'call-1',
        name: 'mcp__custom__do_thing',
        args: { foo: 'bar' },
      },
      toolResult: {
        output: 'total 0',
        isError: false,
      },
    };

    // Unknown tool messages should be filtered out
    render(<VirtualizedMessageList messages={[unknownToolMessage]} isStreaming={false} />);

    // Should show empty state since the only message is a non-visible tool message
    expect(screen.getByText(/Ready to help|Create a session/i)).toBeInTheDocument();
  });

  it('shows read tool messages for skill-loading visibility', () => {
    const readToolMessage: LiveMessage = {
      id: 'read-1',
      role: 'tool',
      content: [],
      timestamp: 1000,
      isComplete: true,
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
    const subagentMessage: LiveMessage = {
      id: 'subagent-1',
      role: 'tool',
      content: [{ type: 'text', text: JSON.stringify({
        mode: 'parallel',
        tasks: [
          { agent: 'coder', task: 'Refactor auth', result: 'Done' },
        ],
      }) }],
      timestamp: 1000,
      isComplete: true,
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

  it('shows assistant messages but filters tool messages in mixed list', () => {
    const mixedMessages: LiveMessage[] = [
      { id: '1', role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000, isComplete: true },
      { id: '2', role: 'assistant', content: [{ type: 'text', text: 'Processing...' }], timestamp: 2000, isComplete: true },
      {
        id: 'tool-1',
        role: 'tool',
        content: [],
        timestamp: 2500,
        isComplete: true,
        toolCall: { id: 'call-1', name: 'mcp__custom__do_thing', args: { query: 'test' } },
        toolResult: { output: 'results', isError: false },
      },
      { id: '3', role: 'assistant', content: [{ type: 'text', text: 'Here are the results' }], timestamp: 3000, isComplete: true },
    ];

    render(<VirtualizedMessageList messages={mixedMessages} isStreaming={false} />);

    // User and assistant messages visible
    expect(screen.getByTestId('message-bubble-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-2')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-3')).toBeInTheDocument();
    // Tool message should NOT be visible
    expect(screen.queryByTestId('message-bubble-tool-1')).not.toBeInTheDocument();
  });

  it('transforms skill content messages to brief placeholder', () => {
    // When using /skill:name command, the Pi SDK injects skill content as assistant message
    // Now we transform it to a brief placeholder instead of filtering entirely
    const skillContentMessage: LiveMessage = {
      id: 'skill-1',
      role: 'assistant',
      content: [{ type: 'text', text: '<skill name="lecture-website" location="/root/.pi/agent/skills/lecture-website/SKILL.md">\n# Lecture Website Builder\n\nTransform a simple idea...</skill>' }],
      timestamp: 1000,
      isComplete: true,
    };

    render(<VirtualizedMessageList messages={[skillContentMessage]} isStreaming={false} />);

    // Skill content message should be transformed to placeholder, NOT filtered out
    expect(screen.getByTestId('message-bubble-skill-1')).toBeInTheDocument();
  });

  it('transforms skill content and shows placeholder alongside regular messages', () => {
    const mixedMessages: LiveMessage[] = [
      { id: '1', role: 'user', content: [{ type: 'text', text: '/skill:lecture-website create a pinterest copy' }], timestamp: 1000, isComplete: true },
      {
        id: '2',
        role: 'assistant',
        content: [{ type: 'text', text: '<skill name="lecture-website" location="/root/.pi/agent/skills/lecture-website/SKILL.md">\n# Lecture Website Builder</skill>' }],
        timestamp: 2000,
        isComplete: true,
      },
      { id: '3', role: 'assistant', content: [{ type: 'text', text: 'I\'ll create a Pinterest copy for you!' }], timestamp: 3000, isComplete: true },
    ];

    render(<VirtualizedMessageList messages={mixedMessages} isStreaming={false} />);

    // All messages should be visible (skill content transformed to placeholder)
    expect(screen.getByTestId('message-bubble-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-2')).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-3')).toBeInTheDocument();
  });

  it('does not transform messages that just mention SKILL.md in file paths', () => {
    // Messages that mention SKILL.md but don't have full skill structure should pass through unchanged
    const regularMessage: LiveMessage = {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'I edited the file: /root/.skills/skill-name/SKILL.md' }],
      timestamp: 1000,
      isComplete: true,
    };

    render(<VirtualizedMessageList messages={[regularMessage]} isStreaming={false} />);

    // Message should be visible and NOT transformed
    expect(screen.getByTestId('message-bubble-msg-1')).toBeInTheDocument();
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
    const manyMessages: LiveMessage[] = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant' as const,
      content: [{ type: 'text' as const, text: `Message ${i}` }],
      timestamp: i * 1000,
      isComplete: true,
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
      { id: '4', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'New message' }], timestamp: 4000, isComplete: true },
    ];

    rerender(<VirtualizedMessageList messages={newMessages} isStreaming={false} />);

    expect(screen.getByTestId('message-bubble-4')).toBeInTheDocument();
  });

  it('handles empty messages array', () => {
    render(<VirtualizedMessageList messages={[]} isStreaming={false} />);

    // Component shows empty state with Ready to help text
    expect(screen.getByText(/Ready to help|Create a session/i)).toBeInTheDocument();
  });

  it('uses identity guards for scroll events', () => {
    const onAtBottomChange = vi.fn();
    const { rerender } = render(
      <VirtualizedMessageList {...defaultProps} onAtBottomChange={onAtBottomChange} />
    );

    // Should have called the callback on mount
    expect(onAtBottomChange).toHaveBeenCalledWith(true);

    // Change messages (simulating session switch)
    const newMessages: LiveMessage[] = [
      { id: 'new-1', role: 'user', content: [{ type: 'text', text: 'New session' }], timestamp: 5000, isComplete: true },
    ];

    rerender(
      <VirtualizedMessageList messages={newMessages} isStreaming={false} onAtBottomChange={onAtBottomChange} />
    );

    // Identity guard should have changed, preventing stale callbacks
    // The component should still work correctly
    expect(screen.getByTestId('message-bubble-new-1')).toBeInTheDocument();
  });
});
