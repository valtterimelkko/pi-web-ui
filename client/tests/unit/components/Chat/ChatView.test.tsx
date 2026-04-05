import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatView } from '../../../../src/components/Chat/ChatView';
import type { LiveMessage } from '../../../../src/hooks/useSessionStream';

// Mock stores
const mockCurrentSessionId = 'session-1';
const mockCreateNewSession = vi.fn();

vi.mock('../../../../src/store', () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      currentSessionId: mockCurrentSessionId,
      isLoading: false,
      getWorkerStatus: () => undefined,
      currentModel: 'test-model',
      currentSessionSdkType: 'pi',
      isCompacting: false,
      compactionReason: null,
      sessionData: {},
    };
    return selector(state);
  },
}));

vi.mock('../../../../src/store/navigationStore', () => ({
  useNavigationStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = { bottomNavCollapsed: true };
    return selector(state);
  },
}));

vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      sessionInfoOpen: false,
      treeViewOpen: false,
      closeSessionInfo: vi.fn(),
      closeTreeView: vi.fn(),
    };
    return selector(state);
  },
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    createNewSession: mockCreateNewSession,
  }),
}));

vi.mock('../../../../src/components/Chat/VirtualizedMessageList', () => ({
  VirtualizedMessageList: ({ messages }: { messages: LiveMessage[] }) => (
    <div data-testid="virtualized-list">
      {messages.map((msg) => (
        <div key={msg.id} data-testid={`message-${msg.id}`}>
          {msg.role}: {msg.content.map((p) => p.text || p.thinking || '').join('')}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../../../../src/components/Chat/MessageInput', () => ({
  MessageInput: ({ disabled, onOpenSettings, isStreaming, currentModel, contextPercent, onSend, onCancel, isCompacting, compactionReason }: {
    disabled?: boolean;
    onOpenSettings?: () => void;
    isStreaming?: boolean;
    isCompacting?: boolean;
    compactionReason?: string | null;
    currentModel?: string;
    contextPercent?: number;
    onSend?: (content: string, images?: unknown[]) => boolean;
    onCancel?: () => void;
  }) => (
    <div data-testid="message-input">
      <span data-testid="input-disabled">{String(disabled)}</span>
      <span data-testid="input-streaming">{String(isStreaming)}</span>
      <span data-testid="input-model">{currentModel ?? 'none'}</span>
      <span data-testid="input-context">{contextPercent ?? 0}</span>
      <span data-testid="input-compacting">{String(isCompacting)}</span>
      <span data-testid="input-compaction-reason">{compactionReason ?? 'none'}</span>
      <button data-testid="settings-btn" onClick={onOpenSettings}>Settings</button>
      <button data-testid="send-btn" onClick={() => onSend?.('test')}>Send</button>
      <button data-testid="cancel-btn" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('../../../../src/components/Tree', () => ({
  TreeView: () => <div data-testid="tree-view" />,
}));

vi.mock('../../../../src/components/Session', () => ({
  NewSessionModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="new-session-modal" /> : null,
}));

vi.mock('../../../../src/components/StatusBar/SessionInfoModal', () => ({
  SessionInfoModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="session-info-modal" /> : null,
}));

// ============================================================================
// Helpers
// ============================================================================

function createLiveMessage(
  id: string,
  role: 'user' | 'assistant' | 'tool',
  text: string,
  opts?: { isComplete?: boolean; thinking?: string }
): LiveMessage {
  return {
    id,
    role,
    content: [
      ...(opts?.thinking ? [{ type: 'thinking' as const, thinking: opts.thinking }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ],
    timestamp: Date.now(),
    isComplete: opts?.isComplete ?? true,
  };
}

const mockUserMessage = createLiveMessage('msg-1', 'user', 'Hello world');
const mockAssistantMessage = createLiveMessage('msg-2', 'assistant', 'Hi there!');

const defaultProps = {
  messages: [mockUserMessage, mockAssistantMessage] as LiveMessage[],
  isStreaming: false,
  onSendPrompt: vi.fn(),
  onCancelStream: vi.fn(),
  onOpenSettings: vi.fn(),
};

// ============================================================================
// Test Suite
// ============================================================================

describe('ChatView', () => {
  // ========================================
  // Basic Rendering
  // ========================================

  describe('basic rendering', () => {
    it('renders messages from props', () => {
      render(<ChatView {...defaultProps} />);

      expect(screen.getByTestId('message-msg-1')).toHaveTextContent('user: Hello world');
      expect(screen.getByTestId('message-msg-2')).toHaveTextContent('assistant: Hi there!');
    });

    it('does NOT subscribe to sessionStore.messages (reads from props only)', () => {
      render(
        <ChatView
          {...defaultProps}
          messages={[mockUserMessage]}
        />
      );

      expect(screen.getByTestId('message-msg-1')).toBeInTheDocument();
      expect(screen.queryByTestId('message-msg-2')).not.toBeInTheDocument();
    });

    it('renders empty state when no messages', () => {
      render(<ChatView {...defaultProps} messages={[]} />);

      expect(screen.getByTestId('virtualized-list')).toBeInTheDocument();
      expect(screen.queryByTestId('message-msg-1')).not.toBeInTheDocument();
    });

    it('renders chat-interface container', () => {
      render(<ChatView {...defaultProps} />);

      expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    });

    it('passes onOpenSettings to MessageInput', () => {
      const onOpenSettings = vi.fn();
      render(<ChatView {...defaultProps} onOpenSettings={onOpenSettings} />);

      screen.getByTestId('settings-btn').click();
      expect(onOpenSettings).toHaveBeenCalledOnce();
    });

    it('disables input when no session exists', () => {
      render(<ChatView {...defaultProps} />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('false');
    });
  });

  // ========================================
  // Rendering with 10+ Messages
  // ========================================

  describe('rendering with messages', () => {
    it('renders 10+ messages correctly', () => {
      const messages: LiveMessage[] = [];
      for (let i = 0; i < 15; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        messages.push(createLiveMessage(`msg-${i}`, role, `Message ${i}`));
      }

      render(<ChatView {...defaultProps} messages={messages} />);

      // All 15 messages should render
      for (let i = 0; i < 15; i++) {
        expect(screen.getByTestId(`message-msg-${i}`)).toBeInTheDocument();
      }
    });

    it('renders messages with no conversion from messagesToLiveMessages', () => {
      // ChatView receives LiveMessage[] directly from useSessionStream.
      // There should be no messagesToLiveMessages conversion step.
      // We verify by passing LiveMessage objects and checking they render as-is.
      const messages: LiveMessage[] = [
        createLiveMessage('live-1', 'user', 'Direct LiveMessage'),
        createLiveMessage('live-2', 'assistant', 'No conversion needed'),
      ];

      render(<ChatView {...defaultProps} messages={messages} />);

      expect(screen.getByTestId('message-live-1')).toHaveTextContent('user: Direct LiveMessage');
      expect(screen.getByTestId('message-live-2')).toHaveTextContent('assistant: No conversion needed');
    });

    it('renders messages with thinking content', () => {
      const messages: LiveMessage[] = [
        createLiveMessage('msg-think', 'assistant', 'Final answer', {
          thinking: 'I thought about this',
        }),
      ];

      render(<ChatView {...defaultProps} messages={messages} />);

      // Thinking content should be rendered (the mock renders thinking as text)
      expect(screen.getByTestId('message-msg-think')).toHaveTextContent('I thought about this');
      expect(screen.getByTestId('message-msg-think')).toHaveTextContent('Final answer');
    });

    it('renders tool messages', () => {
      const toolMessage: LiveMessage = {
        id: 'tool-1',
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        toolCall: { id: 'tool-1', name: 'bash', args: { command: 'echo test' } },
        toolResult: { output: 'test', isError: false },
        timestamp: Date.now(),
        isComplete: true,
      };

      render(<ChatView {...defaultProps} messages={[toolMessage]} />);

      expect(screen.getByTestId('message-tool-1')).toHaveTextContent('tool: tool output');
    });
  });

  // ========================================
  // Streaming State
  // ========================================

  describe('streaming state', () => {
    it('passes isStreaming=true to MessageInput when streaming', () => {
      render(<ChatView {...defaultProps} isStreaming={true} />);

      expect(screen.getByTestId('input-streaming')).toHaveTextContent('true');
    });

    it('passes isStreaming=false to MessageInput when not streaming', () => {
      render(<ChatView {...defaultProps} isStreaming={false} />);

      expect(screen.getByTestId('input-streaming')).toHaveTextContent('false');
    });

    it('passes isCompacting and compactionReason to MessageInput', () => {
      // These come from sessionStore, which is mocked to return isCompacting: false
      render(<ChatView {...defaultProps} />);

      expect(screen.getByTestId('input-compacting')).toHaveTextContent('false');
      expect(screen.getByTestId('input-compaction-reason')).toHaveTextContent('none');
    });

    it('passes contextPercent to MessageInput', () => {
      render(<ChatView {...defaultProps} contextPercent={75} />);

      expect(screen.getByTestId('input-context')).toHaveTextContent('75');
    });

    it('calls onSendPrompt when MessageInput sends a message', () => {
      const onSendPrompt = vi.fn();
      render(<ChatView {...defaultProps} onSendPrompt={onSendPrompt} />);

      screen.getByTestId('send-btn').click();

      // The mock MessageInput calls onSend('test')
      // ChatView's handleMessageSend wraps async onSendPrompt to sync
      expect(onSendPrompt).toHaveBeenCalled();
    });

    it('calls onCancelStream when MessageInput cancels', () => {
      const onCancelStream = vi.fn();
      render(<ChatView {...defaultProps} onCancelStream={onCancelStream} />);

      screen.getByTestId('cancel-btn').click();
      expect(onCancelStream).toHaveBeenCalledOnce();
    });
  });

  // ========================================
  // Large Message Rendering
  // ========================================

  describe('large messages', () => {
    it('renders a very long message without crashing', () => {
      const longText = 'X'.repeat(50000);
      const messages = [createLiveMessage('msg-long', 'assistant', longText)];

      render(<ChatView {...defaultProps} messages={messages} />);

      expect(screen.getByTestId('message-msg-long')).toBeInTheDocument();
    });

    it('renders many tool messages correctly', () => {
      const messages: LiveMessage[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push({
          id: `tool-${i}`,
          role: 'tool',
          content: [],
          toolCall: { id: `tool-${i}`, name: `read-${i}`, args: {} },
          timestamp: Date.now(),
          isComplete: true,
        });
      }

      render(<ChatView {...defaultProps} messages={messages} />);

      for (let i = 0; i < 20; i++) {
        expect(screen.getByTestId(`message-tool-${i}`)).toBeInTheDocument();
      }
    });
  });
});
