import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageInput } from '../../../../src/components/Chat/MessageInput';

// Mock draft store — getState() used in callbacks, no subscriptions
const mockGetDraft = vi.fn().mockReturnValue('');
const mockSetDraft = vi.fn();
const mockClearDraft = vi.fn();

vi.mock('../../../../src/store', () => ({
  useDraftStore: {
    getState: () => ({
      getDraft: mockGetDraft,
      setDraft: mockSetDraft,
      clearDraft: mockClearDraft,
    }),
  },
}));

// Mock UI store for error toasts
const mockAddToast = vi.fn();
vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: {
    getState: () => ({
      addToast: mockAddToast,
    }),
  },
}));

// Mock API upload
vi.mock('../../../../src/lib/api', () => ({
  uploadFile: vi.fn().mockResolvedValue({ path: '/uploads/test.txt', name: 'test.txt', savedName: 'test.txt', size: 100, mimeType: 'text/plain' }),
}));

// Mock sub-components
vi.mock('../../../../src/components/Chat/CompactModal', () => ({
  CompactModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="compact-modal" /> : null,
}));

vi.mock('../../../../src/components/Chat/SlashPalette', () => ({
  SlashPalette: ({ filter, onSelect, onClose }: { filter: string; onSelect: (cmd: string) => void; onClose: () => void }) => (
    <div data-testid="slash-palette">
      <span data-testid="slash-filter">{filter}</span>
      <button data-testid="slash-select" onClick={() => onSelect('/compact')}>Select</button>
      <button data-testid="slash-close" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('../../../../src/components/Usage/ContextRing', () => ({
  ContextRing: ({ percent }: { percent: number }) => (
    <div data-testid="context-ring">{percent}%</div>
  ),
}));

const defaultProps = {
  isStreaming: false,
  onSend: vi.fn().mockReturnValue(true),
  onCancel: vi.fn(),
  currentSessionId: 'session-1',
  disabled: false,
};

describe('MessageInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDraft.mockReturnValue('');
  });

  it('renders without store subscriptions (props only)', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByPlaceholderText('Ask anything, / for commands')).toBeInTheDocument();
  });

  it('shows disabled placeholder when disabled', () => {
    render(<MessageInput {...defaultProps} disabled={true} />);
    expect(screen.getByPlaceholderText('Select a session to start chatting...')).toBeInTheDocument();
  });

  it('calls onSend when send button clicked with input', () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: 'Hello world' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('Hello world', []);
  });

  it('does not send empty message', () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    // Send button should be disabled when input is empty
    const sendBtn = screen.getByTitle('Send message');
    expect(sendBtn).toBeDisabled();
  });

  it('calls onCancel when cancel button clicked during streaming', () => {
    const onCancel = vi.fn();
    render(<MessageInput {...defaultProps} isStreaming={true} onCancel={onCancel} />);

    const cancelBtn = screen.getByTitle('Stop generation');
    fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows context percent from prop', () => {
    render(<MessageInput {...defaultProps} contextPercent={42} />);

    expect(screen.getByTestId('context-ring')).toHaveTextContent('42%');
    expect(screen.getAllByText('42%').length).toBeGreaterThanOrEqual(2);
  });

  it('shows model name from prop', () => {
    render(<MessageInput {...defaultProps} currentModel="anthropic/claude-sonnet-4-20250514" />);

    // Model name is formatted: split by /, pop, replace - with space, title case
    expect(screen.getByText('Claude Sonnet 4 20250514')).toBeInTheDocument();
  });

  it('disables input during streaming', () => {
    render(<MessageInput {...defaultProps} isStreaming={true} />);

    // The cancel button should show instead of send
    expect(screen.getByTitle('Stop generation')).toBeInTheDocument();
    expect(screen.queryByTitle('Send message')).not.toBeInTheDocument();
  });

  it('shows streaming status indicator', () => {
    render(<MessageInput {...defaultProps} isStreaming={true} />);
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('shows awaiting input when not streaming', () => {
    render(<MessageInput {...defaultProps} isStreaming={false} />);
    expect(screen.getByText('Awaiting input')).toBeInTheDocument();
  });

  it('shows compacting state from props', () => {
    render(<MessageInput {...defaultProps} isCompacting={true} compactionReason="Summarizing..." />);
    expect(screen.getByText('Summarizing...')).toBeInTheDocument();
  });

  it('shows Claude badge for claude sessions', () => {
    render(<MessageInput {...defaultProps} currentSessionSdkType="claude" />);
    expect(screen.getByText('CC')).toBeInTheDocument();
  });

  it('does not show Claude badge for pi sessions', () => {
    render(<MessageInput {...defaultProps} currentSessionSdkType="pi" />);
    expect(screen.queryByText('CC')).not.toBeInTheDocument();
  });

  it('shows overage warning when quotaInfo.isUsingOverage is true on claude session', () => {
    render(
      <MessageInput
        {...defaultProps}
        currentSessionSdkType="claude"
        quotaInfo={{ isUsingOverage: true, status: 'overage', rateLimitType: 'conversation', resetsAt: 1234 }}
      />
    );
    expect(screen.getByText('⚠ Extra')).toBeInTheDocument();
  });

  it('loads draft from draftStore on session change', () => {
    mockGetDraft.mockReturnValue('saved draft text');
    render(<MessageInput {...defaultProps} currentSessionId="session-1" />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    expect(textarea).toHaveValue('saved draft text');
  });

  it('clears input and calls onSend on Enter key', () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: 'Test message' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('Test message', []);
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: 'Test message' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows /compact modal when /compact command is entered', async () => {
    render(<MessageInput {...defaultProps} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: '/compact' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(screen.getByTestId('compact-modal')).toBeInTheDocument();
    });
  });

  it('shows slash palette when input starts with /', () => {
    render(<MessageInput {...defaultProps} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: '/com' } });

    expect(screen.getByTestId('slash-palette')).toBeInTheDocument();
  });

  it('hides slash palette for non-slash input', () => {
    render(<MessageInput {...defaultProps} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: 'hello' } });

    expect(screen.queryByTestId('slash-palette')).not.toBeInTheDocument();
  });

  it('shows error toast when onSend returns false', () => {
    const onSend = vi.fn().mockReturnValue(false);
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = screen.getByPlaceholderText('Ask anything, / for commands');
    fireEvent.change(textarea, { target: { value: 'Test' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
  });

  it('calls onOpenSettings when model button is clicked', () => {
    const onOpenSettings = vi.fn();
    render(<MessageInput {...defaultProps} onOpenSettings={onOpenSettings} />);

    const settingsBtn = screen.getByTitle('Change model');
    fireEvent.click(settingsBtn);

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
