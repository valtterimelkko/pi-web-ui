import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TransferConfirmationModal } from '../../../../src/components/Sidebar/TransferConfirmationModal';
import { useTransferStore } from '../../../../src/store/transferStore';
import { useSessionStore } from '../../../../src/store';
import { useUIStore } from '../../../../src/store/uiStore';
import { api } from '../../../../src/lib/api';

vi.mock('../../../../src/store/transferStore', () => ({
  useTransferStore: vi.fn(),
}));

vi.mock('../../../../src/store', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: vi.fn(),
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ switchSession: vi.fn() })),
}));

vi.mock('../../../../src/lib/api', () => ({
  api: { get: vi.fn() },
}));

vi.mock('lucide-react', () => ({
  Info: () => <span>Info</span>,
  AlertTriangle: () => <span>AlertTriangle</span>,
  Check: () => <span>Check</span>,
  X: () => <span>X</span>,
  Loader2: () => <span>Loader2</span>,
  Folder: () => <span>Folder</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  ChevronRight: () => <span>ChevronRight</span>,
  ArrowUp: () => <span>ArrowUp</span>,
  History: () => <span>History</span>,
  Star: () => <span>Star</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  ChevronUp: () => <span>ChevronUp</span>,
}));

const defaultSource = {
  sessionId: 'src-1',
  displayName: 'Source Session',
  sdkType: 'pi' as const,
  cwd: '/home/user/project-a',
};

const defaultExistingTarget = {
  sessionId: 'tgt-1',
  displayName: 'Target Session',
  sdkType: 'claude' as const,
  cwd: '/home/user/project-b',
};

describe('TransferConfirmationModal', () => {
  let mockOnConfirm: ReturnType<typeof vi.fn>;
  let mockCancel: ReturnType<typeof vi.fn>;
  let mockSetScope: ReturnType<typeof vi.fn>;
  let mockSetNewTargetRuntime: ReturnType<typeof vi.fn>;
  let mockSetNewTargetCwd: ReturnType<typeof vi.fn>;
  let mockGetRecentFolders: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnConfirm = vi.fn();
    mockCancel = vi.fn();
    mockSetScope = vi.fn();
    mockSetNewTargetRuntime = vi.fn();
    mockSetNewTargetCwd = vi.fn();
    mockGetRecentFolders = vi.fn(() => []);

    (useSessionStore as any).mockImplementation((selector?: any) => {
      const state = {
        claudeAvailable: true,
        claudeAuthError: null,
        opencodeAvailable: true,
        opencodeAuthError: null,
        switchSession: vi.fn(),
      };
      return typeof selector === 'function' ? selector(state) : state;
    });
    (useSessionStore as any).getState = () => ({ sessions: [] });

    (useUIStore as any).mockImplementation((selector: any) =>
      selector({
        recentFolders: [],
        getRecentFolders: mockGetRecentFolders,
      }),
    );

    (api.get as any).mockResolvedValue({
      path: '/root/project',
      parent: '/root',
      items: [],
    });
  });

  function setupTransferStore(overrides: Record<string, any> = {}) {
    const state = {
      status: 'confirming' as const,
      targetMode: 'existing' as const,
      source: defaultSource,
      existingTarget: defaultExistingTarget,
      newTargetRuntime: 'pi' as const,
      newTargetCwd: '/root',
      scope: 'visible_recent' as const,
      error: null,
      cancel: mockCancel,
      setScope: mockSetScope,
      setNewTargetRuntime: mockSetNewTargetRuntime,
      setNewTargetCwd: mockSetNewTargetCwd,
      createdSessionId: null,
      ...overrides,
    };
    (useTransferStore as any).mockImplementation((selector: any) => selector(state));
    return state;
  }

  function setupExistingStore(overrides: Record<string, any> = {}) {
    return setupTransferStore({
      source: defaultSource,
      existingTarget: defaultExistingTarget,
      targetMode: 'existing',
      ...overrides,
    });
  }

  function setupNewStore(overrides: Record<string, any> = {}) {
    return setupTransferStore({
      source: defaultSource,
      existingTarget: null,
      targetMode: 'new',
      newTargetRuntime: 'pi',
      newTargetCwd: '/root/project',
      ...overrides,
    });
  }

  describe('Existing target variant', () => {
    it('renders source display name, sdkType badge, and cwd', () => {
      setupExistingStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByText('Source Session')).toBeInTheDocument();
      expect(screen.getByText('Pi SDK')).toBeInTheDocument();
      expect(screen.getByText('/home/user/project-a')).toBeInTheDocument();
    });

    it('renders target display name, sdkType badge, and cwd', () => {
      setupExistingStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByText('Target Session')).toBeInTheDocument();
      expect(screen.getByText('Claude Direct')).toBeInTheDocument();
      expect(screen.getByText('/home/user/project-b')).toBeInTheDocument();
    });

    it('shows scope selector with "Recent visible context" selected by default', () => {
      setupExistingStore({ scope: 'visible_recent' });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      const recentRadio = screen.getByRole('radio', { name: /Recent visible context/ });
      const fullRadio = screen.getByRole('radio', { name: /Full visible context/ });
      expect(recentRadio).toBeChecked();
      expect(fullRadio).not.toBeChecked();
    });

    it('shows info callout about visible context and target agent waiting', () => {
      setupExistingStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(
        screen.getByText(/Only visible\/default-rendered context will be transferred/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/target agent will be told to wait for your next instruction/),
      ).toBeInTheDocument();
    });

    it('shows CWD mismatch warning when cwds differ', () => {
      setupExistingStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByText(/Source and target workspaces differ/)).toBeInTheDocument();
    });

    it('does not show CWD mismatch warning when cwds match', () => {
      setupExistingStore({
        source: { ...defaultSource, cwd: '/same/path' },
        existingTarget: { ...defaultExistingTarget, cwd: '/same/path' },
      });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.queryByText(/Source and target workspaces differ/)).not.toBeInTheDocument();
    });

    it('cancel button calls store cancel()', () => {
      setupExistingStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      fireEvent.click(screen.getByText('Cancel'));
      expect(mockCancel).toHaveBeenCalled();
    });

    it('confirm button calls onConfirm', () => {
      setupExistingStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      fireEvent.click(screen.getByRole('button', { name: /Transfer Visible Context/ }));
      expect(mockOnConfirm).toHaveBeenCalled();
    });

    it('confirm button shows "Transferring..." when submitting', () => {
      setupExistingStore({ status: 'submitting' });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByRole('button', { name: /Transferring/ })).toBeDisabled();
    });

    it('shows error message when transfer fails with code TRANSFER_TARGET_BUSY', () => {
      setupExistingStore({
        status: 'failed',
        error: { code: 'TRANSFER_TARGET_BUSY', message: 'Target busy' },
      });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(
        screen.getByText(/target session is currently busy/),
      ).toBeInTheDocument();
    });

    it('shows error message for generic failure', () => {
      setupExistingStore({
        status: 'failed',
        error: { code: 'GENERIC_ERROR', message: 'Something went wrong' },
      });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('shows success state after transfer succeeds with "Go to target session" button', () => {
      setupExistingStore({ status: 'succeeded', createdSessionId: 'new-1' });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByText('Context transferred — ready for your next instruction')).toBeInTheDocument();
      const goToBtn = screen.getByRole('button', { name: /Go to target session/ });
      expect(goToBtn).toBeInTheDocument();
      fireEvent.click(goToBtn);
      expect(mockCancel).toHaveBeenCalled();
    });
  });

  describe('New target variant', () => {
    it('renders runtime picker with Pi SDK, Claude Direct, OpenCode Direct', () => {
      setupNewStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByText('Pi SDK', { selector: '.text-sm.font-medium' })).toBeInTheDocument();
      expect(
        screen.getByText('Claude Direct', { selector: '.text-sm.font-medium' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText('OpenCode Direct', { selector: '.text-sm.font-medium' }),
      ).toBeInTheDocument();
    });

    it('shows CWD input field', () => {
      setupNewStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      expect(screen.getByPlaceholderText('/path/to/project')).toBeInTheDocument();
    });

    it('disables unavailable runtimes based on sessionStore', () => {
      (useSessionStore as any).mockImplementation((selector?: any) => {
        const state = {
          claudeAvailable: false,
          claudeAuthError: 'Not configured',
          opencodeAvailable: false,
          opencodeAuthError: 'Not installed',
        };
        return typeof selector === 'function' ? selector(state) : state;
      });
      setupNewStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);

      const claudeBtn = screen.getByText('Claude Direct').closest('button')!;
      const opencodeBtn = screen.getByText('OpenCode Direct').closest('button')!;
      expect(claudeBtn).toBeDisabled();
      expect(opencodeBtn).toBeDisabled();
    });

    it('confirm is blocked when CWD is empty', () => {
      setupNewStore({ newTargetCwd: '' });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      const confirmBtn = screen.getByRole('button', { name: /Transfer Visible Context/ });
      expect(confirmBtn).toBeDisabled();
    });

    it('changing scope updates the store', () => {
      setupNewStore();
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      fireEvent.click(screen.getByRole('radio', { name: /Full visible context/ }));
      expect(mockSetScope).toHaveBeenCalledWith('visible_full');
    });
  });

  describe('Edge cases', () => {
    it('escape key cancels when not submitting', () => {
      setupExistingStore({ status: 'confirming' });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(mockCancel).toHaveBeenCalled();
    });

    it('escape key does NOT cancel when submitting', () => {
      setupExistingStore({ status: 'submitting' });
      render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it('backdrop click does not close the modal', () => {
      setupExistingStore();
      const { container } = render(
        <TransferConfirmationModal onConfirm={mockOnConfirm} />,
      );
      const backdrop = container.firstChild as HTMLElement;
      fireEvent.click(backdrop);
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it.each([
      ['pi', 'Pi SDK', 'bg-blue-100', 'claude'] as const,
      ['claude', 'Claude Direct', 'bg-amber-100', 'pi'] as const,
      ['opencode', 'OpenCode Direct', 'bg-emerald-100', 'pi'] as const,
    ])(
      'source sdkType shows correct badge color for %s',
      (sdkType, label, colorClass, targetSdkType) => {
        setupTransferStore({
          source: { ...defaultSource, sdkType },
          existingTarget: { ...defaultExistingTarget, sdkType: targetSdkType },
        });
        render(<TransferConfirmationModal onConfirm={mockOnConfirm} />);
        const badge = screen.getByText(label);
        expect(badge.className).toContain(colorClass);
      },
    );
  });
});
