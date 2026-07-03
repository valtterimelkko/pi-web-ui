import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionItem } from '../../../../src/components/Sidebar/SessionItem';
import { useSessionStore, useUIStore } from '../../../../src/store';
import { useWebSocket } from '../../../../src/hooks/useWebSocket';
import { useTransferStore } from '../../../../src/store/transferStore';

vi.mock('../../../../src/store', () => ({
  useSessionStore: vi.fn(),
  useUIStore: vi.fn(),
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('../../../../src/store/transferStore', () => ({
  useTransferStore: vi.fn(),
}));

vi.mock('../../../../src/lib/api', () => ({
  deleteSession: vi.fn(),
}));

vi.mock('../../../../src/components/Sidebar/SessionStatusIndicator', () => ({
  SessionStatusIndicator: () => <div />,
}));

vi.mock('../../../../src/components/Sidebar/WorkerStatusIndicator', () => ({
  WorkerStatusIndicator: () => <div />,
}));

vi.mock('lucide-react', () => ({
  Trash2: () => <span />,
  Edit2: () => <span />,
  Check: () => <span />,
  X: () => <span />,
  Archive: () => <span />,
  ArchiveRestore: () => <span />,
  Download: () => <span />,
  FileText: () => <span />,
  FileJson: () => <span />,
  Code: () => <span />,
  Loader2: () => <span />,
  Pin: () => <span />,
  PinOff: () => <span />,
  GripVertical: () => <span data-testid="grip-icon" />,
}));

function makeDataTransfer(sourceId?: string) {
  return {
    setData: vi.fn(),
    getData: vi.fn((type: string) =>
      type === 'application/session-id' ? (sourceId ?? 'source-id') : '',
    ),
    effectAllowed: '',
    dropEffect: '',
  };
}

const sourceSession = {
  id: 'source-session-id',
  path: '/path/to/source-session.jsonl',
  firstMessage: 'Source session message',
  messageCount: 3,
  cwd: '/home/source',
  name: 'Source Session',
  sdkType: 'pi' as const,
  model: 'claude-3-opus',
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
};

const targetSession = {
  id: 'target-session-id',
  path: '/path/to/target-session.jsonl',
  firstMessage: 'Target session message',
  messageCount: 7,
  cwd: '/home/target',
  name: 'Target Session',
  sdkType: 'claude' as const,
  model: 'claude-3-opus',
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
};

const otherSession = {
  id: 'other-session-id',
  path: '/path/to/other-session.jsonl',
  firstMessage: 'Other session message',
  messageCount: 1,
  cwd: '/home/other',
  name: 'Other Session',
  sdkType: 'opencode' as const,
  model: 'glm-4',
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
};

describe('SessionItem – drag-and-drop transfer', () => {
  const mockSwitchSession = vi.fn();
  const mockPinSession = vi.fn();
  const mockUnpinSession = vi.fn();
  const mockArchiveSession = vi.fn();
  const mockUnarchiveSession = vi.fn();
  const mockGetSessionDisplayName = vi.fn().mockReturnValue(undefined);
  const mockSetSessionDisplayName = vi.fn();
  const mockRemoveSessionDisplayName = vi.fn();
  const mockSetSwitchingSession = vi.fn();
  const mockSetSessions = vi.fn();

  const mockStartDrag = vi.fn();
  const mockEndDrag = vi.fn();
  const mockSetHoverTarget = vi.fn();
  const mockOpenConfirmExisting = vi.fn();

  let transferStoreState: any;

  function sessionStoreState(overrides: Record<string, any> = {}) {
    return {
      sessions: [sourceSession, targetSession, otherSession],
      setSessions: mockSetSessions,
      archiveSession: mockArchiveSession,
      unarchiveSession: mockUnarchiveSession,
      // SessionItem subscribes to the underlying value arrays (not the getters).
      pinnedSessionPaths: [],
      sessionDisplayNames: {},
      isSessionPinned: vi.fn().mockReturnValue(false),
      getSessionDisplayName: mockGetSessionDisplayName,
      setSessionDisplayName: mockSetSessionDisplayName,
      removeSessionDisplayName: mockRemoveSessionDisplayName,
      setSwitchingSession: mockSetSwitchingSession,
      sessionData: {},
      workerStatus: {},
      isSwitchingSession: false,
      switchingToSessionId: null,
      ...overrides,
    };
  }

  function transferStoreDefaults(overrides: Record<string, any> = {}) {
    return {
      isDragging: false,
      source: null,
      hoverTargetId: null,
      startDrag: mockStartDrag,
      endDrag: mockEndDrag,
      setHoverTarget: mockSetHoverTarget,
      openConfirmExisting: mockOpenConfirmExisting,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionDisplayName.mockReturnValue(undefined);

    (useWebSocket as any).mockReturnValue({
      switchSession: mockSwitchSession,
      pinSession: mockPinSession,
      unpinSession: mockUnpinSession,
    });

    transferStoreState = transferStoreDefaults();

    (useTransferStore as any).mockImplementation((selector: any) =>
      selector(transferStoreState),
    );

    const ssState = sessionStoreState();
    (useSessionStore as any).mockImplementation((selector: any) =>
      selector ? selector(ssState) : ssState,
    );
    (useSessionStore as any).getState = () => ssState;

    (useUIStore as any).mockImplementation((selector: any) => {
      const state = { addToast: vi.fn() };
      return selector ? selector(state) : state;
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  describe('Drag source', () => {
    it('has draggable attribute', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      expect(screen.getByRole('listitem').hasAttribute('draggable')).toBe(true);
    });

    it('dragStart sets application/session-id data', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer();
      fireEvent.dragStart(item, { dataTransfer: dt });
      expect(dt.setData).toHaveBeenCalledWith('application/session-id', sourceSession.id);
      expect(dt.effectAllowed).toBe('copy');
    });

    it('mouse drag (>5px) calls startDrag with correct metadata', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(item, { clientX: 110, clientY: 100 });
      expect(mockStartDrag).toHaveBeenCalledWith({
        sessionId: sourceSession.id,
        displayName: sourceSession.name,
        sdkType: sourceSession.sdkType,
        cwd: sourceSession.cwd,
      });
    });

    it('short click does not trigger drag', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(item, { clientX: 102, clientY: 101 });
      fireEvent.mouseUp(item);
      expect(mockStartDrag).not.toHaveBeenCalled();
    });

    it('short click switches session instead', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(item, { clientX: 101, clientY: 100 });
      fireEvent.mouseUp(item);
      fireEvent.click(item);
      expect(mockSwitchSession).toHaveBeenCalledWith(sourceSession.path);
    });

    it('mousedown with non-left button does not start drag tracking', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      fireEvent.mouseDown(item, { button: 2, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(item, { clientX: 120, clientY: 120 });
      expect(mockStartDrag).not.toHaveBeenCalled();
    });
  });

  describe('Drop target (existing session)', () => {
    function renderDraggingTarget(
      overrides: { isDropTarget?: boolean; onDrop?: (id: string) => void; isArchived?: boolean } = {},
    ) {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        source: {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      return render(
        <SessionItem
          session={targetSession}
          isActive={false}
          isDropTarget={overrides.isDropTarget ?? true}
          onDrop={overrides.onDrop}
          isArchived={overrides.isArchived}
        />,
      );
    }

    it('accepts drop when isDropTarget=true and transfer is dragging', () => {
      renderDraggingTarget();
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(sourceSession.id);
      fireEvent.dragOver(item, { dataTransfer: dt });
      expect(dt.dropEffect).toBe('copy');
      expect(mockSetHoverTarget).toHaveBeenCalledWith(targetSession.id);
    });

    it('rejects drop on self (same session)', () => {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        source: {
          sessionId: targetSession.id,
          displayName: targetSession.name,
          sdkType: targetSession.sdkType,
          cwd: targetSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      render(<SessionItem session={targetSession} isActive={false} isDropTarget={true} />);
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(targetSession.id);
      fireEvent.drop(item, { dataTransfer: dt });
      expect(mockOpenConfirmExisting).not.toHaveBeenCalled();
    });

    it('calls onDrop callback when provided', () => {
      const onDrop = vi.fn();
      renderDraggingTarget({ onDrop });
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(sourceSession.id);
      fireEvent.drop(item, { dataTransfer: dt });
      expect(onDrop).toHaveBeenCalledWith(sourceSession.id);
      expect(mockOpenConfirmExisting).not.toHaveBeenCalled();
    });

    it('opens openConfirmExisting when no onDrop callback', () => {
      renderDraggingTarget();
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(sourceSession.id);
      fireEvent.drop(item, { dataTransfer: dt });
      expect(mockOpenConfirmExisting).toHaveBeenCalledWith(
        {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
        {
          sessionId: targetSession.id,
          displayName: targetSession.name,
          sdkType: targetSession.sdkType,
          cwd: targetSession.cwd,
        },
      );
    });

    it('drop ends drag state', () => {
      const onDrop = vi.fn();
      renderDraggingTarget({ onDrop });
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(sourceSession.id);
      fireEvent.drop(item, { dataTransfer: dt });
      expect(mockEndDrag).toHaveBeenCalled();
    });

    it('dragLeave clears hover target', () => {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        hoverTargetId: targetSession.id,
        source: {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      render(<SessionItem session={targetSession} isActive={false} isDropTarget={true} />);
      const item = screen.getByRole('listitem');
      fireEvent.dragLeave(item);
      expect(mockSetHoverTarget).toHaveBeenCalledWith(null);
    });

    it('drop with empty source id does nothing', () => {
      renderDraggingTarget();
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer('');
      dt.getData = vi.fn(() => '');
      fireEvent.drop(item, { dataTransfer: dt });
      expect(mockOpenConfirmExisting).not.toHaveBeenCalled();
    });
  });

  describe('Visual feedback', () => {
    it('non-target items get opacity-60 when dragging another session', () => {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        source: {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      render(<SessionItem session={otherSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      expect(item.className).toContain('opacity-60');
    });

    it('source item gets opacity-40 and ring when dragging', () => {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        source: {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      expect(item.className).toContain('opacity-40');
      expect(item.className).toContain('ring-2');
      expect(item.className).toContain('ring-blue-300');
    });

    it('valid hover target gets highlighted ring', () => {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        source: {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      render(<SessionItem session={targetSession} isActive={false} isDropTarget={true} />);
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(sourceSession.id);
      fireEvent.dragOver(item, { dataTransfer: dt });
      fireEvent.dragLeave(item);
    });
  });

  describe('Edge cases', () => {
    it('archived sessions are not valid drop targets', () => {
      transferStoreState = transferStoreDefaults({
        isDragging: true,
        source: {
          sessionId: sourceSession.id,
          displayName: sourceSession.name,
          sdkType: sourceSession.sdkType,
          cwd: sourceSession.cwd,
        },
      });
      (useTransferStore as any).mockImplementation((selector: any) =>
        selector(transferStoreState),
      );
      render(
        <SessionItem
          session={targetSession}
          isActive={false}
          isDropTarget={true}
          isArchived={true}
        />,
      );
      const item = screen.getByRole('listitem');
      const dt = makeDataTransfer(sourceSession.id);
      fireEvent.dragOver(item, { dataTransfer: dt });
      expect(dt.dropEffect).toBe('');
      expect(mockSetHoverTarget).not.toHaveBeenCalled();
    });

    it('does not trigger drag during editing', () => {
      const ssState = sessionStoreState();
      (useSessionStore as any).mockImplementation((selector: any) =>
        selector ? selector(ssState) : ssState,
      );
      (useSessionStore as any).getState = () => ssState;

      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');

      fireEvent.contextMenu(item);
      const renameButton = screen.queryByText('Rename');
      if (renameButton) {
        fireEvent.click(renameButton);
      }

      const input = screen.queryByPlaceholderText('Session name');
      if (input) {
        fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 100 });
        fireEvent.mouseMove(item, { clientX: 120, clientY: 120 });
        expect(mockStartDrag).not.toHaveBeenCalled();
      }
    });

    it('global mouseup listener ends drag state', () => {
      render(<SessionItem session={sourceSession} isActive={false} />);
      const item = screen.getByRole('listitem');
      fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(item, { clientX: 120, clientY: 120 });
      expect(mockStartDrag).toHaveBeenCalled();

      fireEvent.mouseUp(window);
      expect(mockEndDrag).toHaveBeenCalled();
    });
  });
});
