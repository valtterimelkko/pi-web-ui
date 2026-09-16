/**
 * The two layout modes, at the component level (Child V, 2026-09-15; reworked
 * 2026-09-16).
 *
 * `VoiceLayoutToggle` is the operator's switch; `DriveModeSessionPane` is the
 * live session shown under the voice block in desktop mode.
 *
 * The pane must be the REAL session view — the operator's report was that it
 * showed "super raw content … not organised like in the regular session view":
 * the flat legacy `MessageList` renders one bare bubble per store message,
 * while the regular chat screen renders `VirtualizedMessageList`, where
 * consecutive tool runs collapse into a `ToolGroupContainer`, skill payloads
 * are transformed and tool verbosity lives. These tests pin the pane to that
 * SAME list, fed from the addressed session's own projection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VoiceLayoutToggle } from '../../../../src/components/DriveMode/VoiceLayoutToggle';
import { DriveModeSessionPane } from '../../../../src/components/DriveMode/DriveModeSessionPane';

vi.mock('lucide-react', () => ({
  Smartphone: () => <span data-testid="icon-smartphone" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  ArrowDown: () => <span data-testid="icon-arrow-down" />,
}));

interface ListProps {
  messages: Array<{ id: string; role: string; content: unknown }>;
  isStreaming?: boolean;
  sessionId?: string;
  hasSession?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
}

/** The real session list is mocked ONLY to observe what the pane hands it. */
const lastProps: Partial<ListProps> = {};
vi.mock('../../../../src/components/Chat/VirtualizedMessageList', () => ({
  VirtualizedMessageList: (props: ListProps) => {
    lastProps.messages = props.messages;
    lastProps.isStreaming = props.isStreaming;
    lastProps.sessionId = props.sessionId;
    lastProps.hasSession = props.hasSession;
    return (
      <div
        data-testid="session-view"
        data-count={props.messages.length}
        data-streaming={String(props.isStreaming)}
        data-session={props.sessionId ?? ''}
      >
        <button onClick={() => props.onAtBottomChange?.(false)}>left the bottom</button>
      </div>
    );
  },
}));

function message(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, role: 'assistant', content, timestamp: 1, ...extra };
}

const sessionState = {
  messages: [message('m1', 'the answer')],
  currentSessionId: 's1',
  isStreaming: false,
  sessionMessages: {} as Record<string, Array<Record<string, unknown>>>,
  streamingSessions: {} as Record<string, boolean>,
  historyReplayActive: {} as Record<string, boolean>,
  getWorkerStatus: (_sessionId: string) => undefined,
  isTransferReady: (_sessionId: string) => false,
};

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: unknown) => unknown) => (selector ? selector(sessionState) : sessionState)),
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

  it('says nothing about width when the desktop arrangement is actually rendered', () => {
    render(<VoiceLayoutToggle mode="desktop" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('voice-layout-degraded')).toBeNull();
  });
});

describe('DriveModeSessionPane — the real session view', () => {
  beforeEach(() => {
    sessionState.isStreaming = false;
    sessionState.messages = [message('m1', 'the answer')];
    sessionState.sessionMessages = {};
    sessionState.streamingSessions = {};
    sessionState.currentSessionId = 's1';
    Object.keys(lastProps).forEach((key) => delete lastProps[key as keyof ListProps]);
  });

  it('renders the shared session list (the regular chat view), not a flat bubble dump', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    const list = screen.getByTestId('session-view');
    expect(list).toHaveAttribute('data-count', '1');
    expect(list).toHaveAttribute('data-session', 's1');
    expect(lastProps.hasSession).toBe(true);
  });

  it('hands the list live messages converted by the shared adapter', () => {
    sessionState.messages = [message('m1', 'the answer')];
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    // A plain string store content is adapted to ContentPart[] — the shape the
    // regular view renders.
    expect(Array.isArray(lastProps.messages?.[0].content)).toBe(true);
  });

  it('follows the ADDRESSED session, not whatever the tab has current', () => {
    sessionState.currentSessionId = 's1';
    sessionState.messages = [message('m1', 'the addressed lane never shows this')];
    sessionState.sessionMessages = {
      s2: [message('lane-1', 'lane two says this'), message('lane-2', 'and this')],
    };
    render(<DriveModeSessionPane sessionDisplayName="Worker Two" modelName="test-model" sessionId="s2" />);
    expect(screen.getByTestId('session-view')).toHaveAttribute('data-count', '2');
    expect(screen.getByTestId('session-view')).toHaveAttribute('data-session', 's2');
  });

  it('reports streaming from the addressed session, not the global flag', () => {
    sessionState.isStreaming = false;
    sessionState.streamingSessions = { s2: true };
    sessionState.sessionMessages = { s2: [message('lane-1', 'working')] };
    render(<DriveModeSessionPane sessionDisplayName="Worker Two" modelName="test-model" sessionId="s2" />);
    expect(screen.getByTestId('session-view')).toHaveAttribute('data-streaming', 'true');
    expect(screen.getByTestId('drive-session-streaming')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('shows idle when the addressed session is not running', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    expect(screen.queryByTestId('drive-session-streaming')).toBeNull();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('carries the addressed session identity for observability', () => {
    // The pane must say which session it is showing: it is the pane's whole
    // contract in lane mode, and the real-browser harness reads it back.
    sessionState.sessionMessages = { s2: [message('lane-1', 'lane two')] };
    render(<DriveModeSessionPane sessionDisplayName="Worker Two" modelName="test-model" sessionId="s2" />);
    expect(screen.getByTestId('drive-session-pane')).toHaveAttribute('data-drive-session', 's2');
  });

  it('names the session and the model', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    expect(screen.getByText('Worker')).toBeInTheDocument();
    expect(screen.getByText('test-model')).toBeInTheDocument();
  });

  it('offers a scroll-to-bottom control once the operator scrolls away', () => {
    render(<DriveModeSessionPane sessionDisplayName="Worker" modelName="test-model" />);
    expect(screen.queryByTestId('drive-session-scroll-bottom')).toBeNull();
    fireEvent.click(screen.getByText('left the bottom'));
    expect(screen.getByTestId('drive-session-scroll-bottom')).toBeInTheDocument();
  });
});
