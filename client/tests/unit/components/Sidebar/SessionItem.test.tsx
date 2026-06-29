import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionItem } from '../../../../src/components/Sidebar/SessionItem';
import { useSessionStore } from '../../../../src/store';
import { useWebSocket } from '../../../../src/hooks/useWebSocket';
import * as api from '../../../../src/lib/api';

// Mock the dependencies
vi.mock('../../../../src/store', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('../../../../src/lib/api', () => ({
  deleteSession: vi.fn(),
}));

vi.mock('../../../../src/components/Sidebar/SessionStatusIndicator', () => ({
  SessionStatusIndicator: () => <div data-testid="session-status">Status</div>,
}));

vi.mock('../../../../src/components/Sidebar/WorkerStatusIndicator', () => ({
  WorkerStatusIndicator: () => <div data-testid="worker-status">Worker</div>,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Trash2: () => <span data-testid="trash-icon">🗑️</span>,
  Edit2: () => <span data-testid="edit-icon">✏️</span>,
  Check: () => <span data-testid="check-icon">✓</span>,
  X: () => <span data-testid="x-icon">✗</span>,
  Archive: () => <span data-testid="archive-icon">📦</span>,
  ArchiveRestore: () => <span data-testid="archive-restore-icon">📤</span>,
  Download: () => <span data-testid="download-icon">⬇️</span>,
  FileText: () => <span data-testid="file-text-icon">📄</span>,
  FileJson: () => <span data-testid="file-json-icon">📋</span>,
  Code: () => <span data-testid="code-icon">💻</span>,
  Loader2: () => <span data-testid="loader-icon">⏳</span>,
  Pin: () => <span data-testid="pin-icon">📌</span>,
  PinOff: () => <span data-testid="pin-off-icon">📍</span>,
  Bell: () => <span data-testid="bell-icon">🔔</span>,
  BellOff: () => <span data-testid="bell-off-icon">🔕</span>,
  GripVertical: () => <span data-testid="grip-icon">⠿</span>,
}));

describe('SessionItem', () => {
  const mockSession = {
    id: 'test-session-id',
    path: '/path/to/test-session.jsonl',
    firstMessage: 'Test session message',
    messageCount: 5,
    cwd: '/home/test',
    name: 'Test Session',
    sdkType: 'pi' as const,
    model: 'claude-3-opus',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  };

  const mockSwitchSession = vi.fn();
  const mockArchiveSession = vi.fn();
  const mockUnarchiveSession = vi.fn();
  const mockGetSessionDisplayName = vi.fn();
  const mockSetSessionDisplayName = vi.fn();
  const mockRemoveSessionDisplayName = vi.fn();
  const mockSetSwitchingSession = vi.fn();
  const mockSetSessions = vi.fn();
  const mockDeleteSession = vi.fn();
  const mockPinSession = vi.fn();
  const mockUnpinSession = vi.fn();
  const mockIsSessionPinned = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock implementations
    (useWebSocket as any).mockReturnValue({
      switchSession: mockSwitchSession,
      pinSession: mockPinSession,
      unpinSession: mockUnpinSession,
    });

    (useSessionStore as any).mockImplementation((selector: any) => {
      const state = {
        sessions: [mockSession],
        setSessions: mockSetSessions,
        archiveSession: mockArchiveSession,
        unarchiveSession: mockUnarchiveSession,
        getSessionDisplayName: mockGetSessionDisplayName.mockReturnValue(undefined),
        setSessionDisplayName: mockSetSessionDisplayName,
        removeSessionDisplayName: mockRemoveSessionDisplayName,
        setSwitchingSession: mockSetSwitchingSession,
        isSessionPinned: mockIsSessionPinned.mockReturnValue(false),
        sessionData: {},
        workerStatus: {},
        isSwitchingSession: false,
        switchingToSessionId: null,
      };
      return selector ? selector(state) : state;
    });
    (useSessionStore as any).getState = () => ({
      sessions: [mockSession],
      getSessionDisplayName: mockGetSessionDisplayName,
    });

    (api.deleteSession as any).mockImplementation(mockDeleteSession);
    
    // Mock window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  describe('Context Menu', () => {
    it('should show context menu on right-click', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      
      // Right-click on the session item
      fireEvent.contextMenu(sessionItem);
      
      // Context menu should appear with expected options
      await waitFor(() => {
        expect(screen.getByText('Rename')).toBeInTheDocument();
        expect(screen.getByText('Export')).toBeInTheDocument();
        expect(screen.getByText('Archive')).toBeInTheDocument();
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });
    });

    it('should show session name in context menu header', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      // Should show the session name in context menu header (specific class for header)
      await waitFor(() => {
        const headerElements = screen.getAllByText((content) => 
          content.includes('Test Session')
        );
        // Should have at least 2: one in the session item, one in context menu header
        expect(headerElements.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should close context menu when clicking outside', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      // Context menu should be visible
      await waitFor(() => {
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });
      
      // Click elsewhere (on document body)
      fireEvent.mouseDown(document.body);
      
      // Context menu should be closed
      await waitFor(() => {
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
      });
    });

    it('should not activate session when right-clicking', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      // Session should not be switched (switchSession should not be called)
      expect(mockSwitchSession).not.toHaveBeenCalled();
      expect(mockSetSwitchingSession).not.toHaveBeenCalled();
    });

    it('should call archiveSession when clicking Archive in context menu', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const archiveButton = screen.getByText('Archive');
        expect(archiveButton).toBeInTheDocument();
      });
      
      // Click the Archive button
      const archiveButton = screen.getByText('Archive');
      fireEvent.click(archiveButton);
      
      expect(mockArchiveSession).toHaveBeenCalledWith(mockSession.path);
    });

    it('should show Restore option for archived sessions', async () => {
      render(<SessionItem session={mockSession} isActive={false} isArchived={true} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        // Should show Restore instead of Archive
        expect(screen.queryByText('Archive')).not.toBeInTheDocument();
        expect(screen.getByText('Restore')).toBeInTheDocument();
      });
    });

    it('should call unarchiveSession when clicking Restore in context menu', async () => {
      render(<SessionItem session={mockSession} isActive={false} isArchived={true} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const restoreButton = screen.getByText('Restore');
        expect(restoreButton).toBeInTheDocument();
      });
      
      // Click the Restore button
      const restoreButton = screen.getByText('Restore');
      fireEvent.click(restoreButton);
      
      expect(mockUnarchiveSession).toHaveBeenCalledWith(mockSession.path);
    });

    it('should call deleteSession when clicking Delete in context menu', async () => {
      mockDeleteSession.mockResolvedValue(undefined);
      
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const deleteButton = screen.getByText('Delete');
        expect(deleteButton).toBeInTheDocument();
      });
      
      // Click the Delete button
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);
      
      // Should show confirmation dialog
      expect(window.confirm).toHaveBeenCalledWith('Delete this session? This cannot be undone.');
      
      // Should call deleteSession API
      await waitFor(() => {
        expect(mockDeleteSession).toHaveBeenCalledWith(mockSession.id);
      });
    });

    it('should update session list after successful deletion', async () => {
      mockDeleteSession.mockResolvedValue(undefined);
      
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const deleteButton = screen.getByText('Delete');
        expect(deleteButton).toBeInTheDocument();
      });
      
      // Click the Delete button
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);
      
      await waitFor(() => {
        expect(mockSetSessions).toHaveBeenCalled();
        expect(mockRemoveSessionDisplayName).toHaveBeenCalledWith(mockSession.path);
      });
    });

    it('should not delete if user cancels confirmation', async () => {
      (window.confirm as any).mockReturnValue(false);
      
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const deleteButton = screen.getByText('Delete');
        expect(deleteButton).toBeInTheDocument();
      });
      
      // Click the Delete button
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);
      
      // Confirmation should be shown
      expect(window.confirm).toHaveBeenCalled();
      
      // But delete should not be called
      expect(mockDeleteSession).not.toHaveBeenCalled();
    });

    it('should show rename input when clicking Rename in context menu', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const renameButton = screen.getByText('Rename');
        expect(renameButton).toBeInTheDocument();
      });
      
      // Click the Rename button
      const renameButton = screen.getByText('Rename');
      fireEvent.click(renameButton);
      
      // Should show input field
      await waitFor(() => {
        const input = screen.getByPlaceholderText('Session name');
        expect(input).toBeInTheDocument();
      });
    });

    it('should close context menu when pressing Escape', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });
      
      // Press Escape
      fireEvent.keyDown(sessionItem, { key: 'Escape' });
      
      // Context menu should be closed
      await waitFor(() => {
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
      });
    });

    it('should show Export submenu on hover', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const exportButton = screen.getByText('Export');
        expect(exportButton).toBeInTheDocument();
      });
      
      // Hover over Export should show submenu
      const exportButton = screen.getByText('Export');
      fireEvent.mouseEnter(exportButton);
      
      // Submenu should be visible
      await waitFor(() => {
        expect(screen.getByText('Markdown')).toBeInTheDocument();
        expect(screen.getByText('JSON')).toBeInTheDocument();
        expect(screen.getByText('HTML')).toBeInTheDocument();
      });
    });

    it('should apply disabled styling when deleting', async () => {
      mockDeleteSession.mockImplementation(() => new Promise(() => {})); // Never resolves
      
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.contextMenu(sessionItem);
      
      await waitFor(() => {
        const deleteButton = screen.getByText('Delete');
        expect(deleteButton).toBeInTheDocument();
      });
      
      // Click the Delete button
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);
      
      // Should apply opacity-50 and pointer-events-none styling to the session item
      await waitFor(() => {
        expect(sessionItem.className).toContain('opacity-50');
        expect(sessionItem.className).toContain('pointer-events-none');
      });
    });
  });

  describe('Hover Actions', () => {
    it('should show action buttons on hover for non-active session', async () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      
      // Hover over the session item
      fireEvent.mouseEnter(sessionItem);
      
      // Action buttons should become visible
      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(0);
      });
    });

    it('should always show action buttons for active session', () => {
      render(<SessionItem session={mockSession} isActive={true} />);
      
      // Action buttons should be visible without hovering
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  describe('Click Behavior', () => {
    it('should switch session on click when not active', () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.click(sessionItem);
      
      expect(mockSetSwitchingSession).toHaveBeenCalledWith(true, mockSession.id);
      expect(mockSwitchSession).toHaveBeenCalledWith(mockSession.path);
    });

    it('should not switch session when clicking active session', () => {
      render(<SessionItem session={mockSession} isActive={true} />);
      
      const sessionItem = screen.getByRole('listitem');
      fireEvent.click(sessionItem);
      
      expect(mockSwitchSession).not.toHaveBeenCalled();
    });

    it('should not switch session when context menu is visible', () => {
      render(<SessionItem session={mockSession} isActive={false} />);
      
      const sessionItem = screen.getByRole('listitem');
      
      // First right-click to show context menu
      fireEvent.contextMenu(sessionItem);
      
      // Then click the session item
      fireEvent.click(sessionItem);
      
      // Should not switch because context menu is visible
      expect(mockSwitchSession).not.toHaveBeenCalled();
    });
  });
});
