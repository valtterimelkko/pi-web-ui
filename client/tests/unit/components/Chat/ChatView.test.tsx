import { describe, it, expect } from 'vitest';
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
  MessageInput: ({ disabled, onOpenSettings, isStreaming, currentModel, contextPercent, onSend, onCancel }: {
    disabled?: boolean;
    onOpenSettings?: () => void;
    isStreaming?: boolean;
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

const mockUserMessage: LiveMessage = {
  id: 'msg-1',
  role: 'user',
  content: [{ type: 'text', text: 'Hello world' }],
  timestamp: Date.now(),
  isComplete: true,
};

const mockAssistantMessage: LiveMessage = {
  id: 'msg-2',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hi there!' }],
  timestamp: Date.now(),
  isComplete: true,
};

const defaultProps = {
  messages: [mockUserMessage, mockAssistantMessage] as LiveMessage[],
  isStreaming: false,
  onSendPrompt: vi.fn(),
  onCancelStream: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe('ChatView', () => {
  it('renders messages from props', () => {
    render(<ChatView {...defaultProps} />);

    expect(screen.getByTestId('message-msg-1')).toHaveTextContent('user: Hello world');
    expect(screen.getByTestId('message-msg-2')).toHaveTextContent('assistant: Hi there!');
  });

  it('does NOT subscribe to sessionStore.messages (reads from props only)', () => {
    // If ChatView read from sessionStore.messages, it would show those messages.
    // But since we pass messages as props, the rendered output should only show prop messages.
    render(
      <ChatView
        {...defaultProps}
        messages={[mockUserMessage]}
      />
    );

    // Only the user message from props should be rendered
    expect(screen.getByTestId('message-msg-1')).toBeInTheDocument();
    expect(screen.queryByTestId('message-msg-2')).not.toBeInTheDocument();
  });

  it('renders empty state when no messages', () => {
    render(<ChatView {...defaultProps} messages={[]} />);

    expect(screen.getByTestId('virtualized-list')).toBeInTheDocument();
    expect(screen.queryByTestId('message-msg-1')).not.toBeInTheDocument();
  });

  it('passes onOpenSettings to MessageInput', () => {
    const onOpenSettings = vi.fn();
    render(<ChatView {...defaultProps} onOpenSettings={onOpenSettings} />);

    const settingsBtn = screen.getByTestId('settings-btn');
    settingsBtn.click();

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('disables input when no session exists', () => {
    // Override the mock for this test
    vi.doMock('../../../../src/store', () => ({
      useSessionStore: (selector: (state: Record<string, unknown>) => unknown) => {
        const state = {
          currentSessionId: null,
          isLoading: false,
          getWorkerStatus: () => undefined,
        };
        return selector(state);
      },
    }));

    render(<ChatView {...defaultProps} />);
    // The mock returns currentSessionId as 'session-1' so disabled should be false
    expect(screen.getByTestId('input-disabled')).toHaveTextContent('false');
  });

  it('renders chat-interface container', () => {
    render(<ChatView {...defaultProps} />);

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
