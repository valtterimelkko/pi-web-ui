import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { Sidebar } from '../../../../src/components/Sidebar/Sidebar';

const createNewSession = vi.fn();

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ createNewSession, getSessions: vi.fn(), sendMessage: vi.fn() }),
}));

const sessionState = {
  sessions: [] as unknown[],
  currentSessionId: null as string | null,
  archivedSessionPaths: [] as string[],
  sessionDisplayNames: {} as Record<string, string>,
  archiveAllSessions: vi.fn(),
};

vi.mock('../../../../src/store', () => ({
  useSessionStore: (sel: (s: typeof sessionState) => unknown) => sel(sessionState),
  useUIStore: (sel: (s: unknown) => unknown) => sel({ theme: 'light', toggleTheme: vi.fn(), openDriveMode: vi.fn() }),
}));

vi.mock('../../../../src/store/chatStore', () => ({
  useChatStore: (sel: (s: unknown) => unknown) => sel({ sidebarOpen: true, toggleSidebar: vi.fn() }),
}));

vi.mock('../../../../src/store/transferStore', () => ({
  useTransferStore: (sel: (s: unknown) => unknown) => sel({
    status: 'idle',
    source: null,
    targetMode: null,
    existingTarget: null,
    newTargetRuntime: null,
    newTargetCwd: null,
    scope: null,
    setSubmitting: vi.fn(),
    setSucceeded: vi.fn(),
    setFailed: vi.fn(),
    reset: vi.fn(),
  }),
}));

// Capture the modal's props instead of rendering the real modal (its own
// behaviour is covered by NewSessionModal.test.tsx).
let lastModalProps: { onCreateSession?: (...args: unknown[]) => void } | undefined;
vi.mock('../../../../src/components/Session', () => ({
  NewSessionModal: (props: { onCreateSession?: (...args: unknown[]) => void }) => {
    lastModalProps = props;
    return null;
  },
}));
vi.mock('../../../../src/components/Sidebar/SessionList', () => ({ SessionList: () => null }));
vi.mock('../../../../src/components/Sidebar/SessionFilters', () => ({ SessionFilters: () => null }));
vi.mock('../../../../src/components/Sidebar/SessionItem', () => ({ SessionItem: () => null }));
vi.mock('../../../../src/components/Sidebar/TransferConfirmationModal', () => ({ TransferConfirmationModal: () => null }));
vi.mock('../../../../src/components/Usage', () => ({ TokenUsageDashboard: () => null }));

describe('Sidebar — create session forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastModalProps = undefined;
  });

  it('forwards every modal create argument — including the correlation requestId — to createNewSession', () => {
    render(<Sidebar />);
    expect(lastModalProps?.onCreateSession).toEqual(expect.any(Function));

    lastModalProps!.onCreateSession!('/root/pi-web-ui', 'commandcode', 'qwen/qwen3.8-max', undefined, 'high', 'req-correlation-1');

    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(createNewSession).toHaveBeenCalledWith('/root/pi-web-ui', 'commandcode', 'qwen/qwen3.8-max', undefined, 'high', 'req-correlation-1');
  });
});
