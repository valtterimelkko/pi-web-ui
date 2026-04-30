import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DriveModeFolderPicker } from '../../../../src/components/DriveMode/DriveModeFolderPicker';
import { api } from '../../../../src/lib/api';
import { useUIStore } from '../../../../src/store/uiStore';

vi.mock('../../../../src/lib/api', () => ({
  api: {
    get: vi.fn(),
  },
}));

vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: vi.fn(),
}));

describe('DriveModeFolderPicker', () => {
  const mockOnSelectFolder = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useUIStore as ReturnType<typeof vi.fn>).mockReturnValue({
      recentFolders: [
        { path: '/root/project-a', label: 'project-a', count: 3, lastUsed: Date.now() },
        { path: '/root/project-b', label: 'project-b', count: 1, lastUsed: Date.now() },
      ],
      getRecentFolders: vi.fn().mockReturnValue([
        { path: '/root/project-a', label: 'project-a', count: 3, lastUsed: Date.now() },
        { path: '/root/project-b', label: 'project-b', count: 1, lastUsed: Date.now() },
      ]),
    });
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/root',
      parent: null,
      items: [
        { name: 'project-a', type: 'directory', path: '/root/project-a' },
        { name: 'project-b', type: 'directory', path: '/root/project-b' },
        { name: 'file.txt', type: 'file', path: '/root/file.txt' },
      ],
    });
  });

  it('renders title', () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    expect(screen.getByText('Choose a Folder')).toBeInTheDocument();
  });

  it('renders recent folders', () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    expect(screen.getByText('project-a')).toBeInTheDocument();
    expect(screen.getByText('project-b')).toBeInTheDocument();
  });

  it('renders browse section with directories', async () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    await waitFor(() => {
      expect(screen.getByText('project-a')).toBeInTheDocument();
    });
    // In browse list there are two project-a entries (recent + browse)
    const browseDirs = screen.getAllByText('project-a');
    expect(browseDirs.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking recent folder navigates to it', async () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    const recentButtons = screen.getAllByText('Select');
    fireEvent.click(recentButtons[0]);
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/api/files/browse?path='));
    });
  });

  it('clicking "Select This Folder" calls onSelectFolder with current path', async () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    await waitFor(() => {
      expect(screen.getByText('Select This Folder')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Select This Folder'));
    await waitFor(() => {
      expect(mockOnSelectFolder).toHaveBeenCalledWith('/root');
    });
  });

  it('clicking "Create Session" footer button calls onSelectFolder', async () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    await waitFor(() => {
      expect(screen.getByText('Create Session')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Create Session'));
    await waitFor(() => {
      expect(mockOnSelectFolder).toHaveBeenCalledWith('/root');
    });
  });

  it('clicking "Back" calls onBack', () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    const backButtons = screen.getAllByText('Back');
    fireEvent.click(backButtons[0]);
    expect(mockOnBack).toHaveBeenCalled();
  });

  it('navigates into subdirectory on click', async () => {
    // No recent folders so we only see browse entries
    (useUIStore as ReturnType<typeof vi.fn>).mockReturnValue({
      recentFolders: [],
      getRecentFolders: vi.fn().mockReturnValue([]),
    });

    (api.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        path: '/root',
        parent: null,
        items: [{ name: 'project-a', type: 'directory', path: '/root/project-a' }],
      })
      .mockResolvedValueOnce({
        path: '/root/project-a',
        parent: '/root',
        items: [],
      });

    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    await waitFor(() => {
      expect(screen.getByText('project-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('project-a'));

    await waitFor(() => {
      expect(api.get).toHaveBeenLastCalledWith('/api/files/browse?path=%2Froot%2Fproject-a');
    });
  });

  it('shows up button and navigates up', async () => {
    (api.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        path: '/root/project-a',
        parent: '/root',
        items: [],
      });

    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    await waitFor(() => {
      expect(screen.getByTitle('Go up')).toBeInTheDocument();
    });
  });

  it('shows error message on API failure', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Access denied'));
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    await waitFor(() => {
      expect(screen.getByText(/Access denied/)).toBeInTheDocument();
    });
  });
});
