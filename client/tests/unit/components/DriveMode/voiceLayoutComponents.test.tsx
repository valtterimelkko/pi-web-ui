/**
 * The two layout modes, at the component level (Child V, 2026-09-15).
 *
 * `VoiceLayoutToggle` is the operator's switch; `DriveModeSessionPane` is the
 * live session shown beside the voice surface in desktop mode. The pane must be
 * the REAL session view — it reads `useSessionStore` and renders the shared
 * message list — so these tests pin the store read, not a private copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VoiceLayoutToggle } from '../../../../src/components/DriveMode/VoiceLayoutToggle';
import { DriveModeSessionPane } from '../../../../src/components/DriveMode/DriveModeSessionPane';

vi.mock('lucide-react', () => ({
  Smartphone: () => <span data-testid="icon-smartphone" />,
  Monitor: () => <span data-testid="icon-monitor" />,
}));

const sessionState = {
  messages: [{ id: 'm1', role: 'assistant', content: 'the answer', timestamp: 1 }],
  isStreaming: false,
  currentSessionId: 's1',
};

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: unknown) => unknown) => (selector ? selector(sessionState) : sessionState)),
}));

vi.mock('../../../../src/components/Chat/MessageList', () => ({
  MessageList: ({ messages, hasSession }: { messages: unknown[]; hasSession: boolean }) => (
    <div data-testid="message-list" data-count={messages.length} data-has-session={String(hasSession)} />
  ),
}));

describe('VoiceLayoutToggle', () => {
  it('offers exactly the two modes and marks the active one', () => {
    render(<VoiceLayoutToggle mode="mobile" onSelect={vi.fn()} />);
    expect(screen.getByTestId('voice-layout-mobile')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('voice-layout-desktop')).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the operator choice', () => {
    const onSelect = vi.fn();
    render(<VoiceLayoutToggle mode="mobile" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('voice-layout-desktop'));
    expect(onSelect).toHaveBeenCalledWith('desktop');
  });

  it('says so when the desktop preference cannot be honoured at this width', () => {
    render(<VoiceLayoutToggle mode="desktop" onSelect={vi.fn()} degraded />);
    expect(screen.getByTestId('voice-layout-degraded')).toBeInTheDocument();
  });

  it('says nothing about width when the split is actually rendered', () => {
    render(<VoiceLayoutToggle mode="desktop" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('voice-layout-degraded')).toBeNull();
  });
});

describe('DriveModeSessionPane', () => {
  beforeEach(() => {
    sessionState.isStreaming = false;
    sessionState.messages = [{ id: 'm1', role: 'assistant', content: 'the answer', timestamp: 1 }];
  });

  it('renders the real session transcript from the session store', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    const list = screen.getByTestId('message-list');
    expect(list).toHaveAttribute('data-count', '1');
    expect(list).toHaveAttribute('data-has-session', 'true');
  });

  it('names the session and the model', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    expect(screen.getByText('Worker')).toBeInTheDocument();
    expect(screen.getByText('test-model')).toBeInTheDocument();
  });

  it('shows the worker as working while the session streams', () => {
    sessionState.isStreaming = true;
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    expect(screen.getByTestId('drive-session-streaming')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('shows idle when the worker is not running', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    expect(screen.queryByTestId('drive-session-streaming')).toBeNull();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });
});
