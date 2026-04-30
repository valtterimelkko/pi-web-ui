import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeFolderPicker } from '../../../../src/components/DriveMode/DriveModeFolderPicker';
import { useUIStore } from '../../../../src/store/uiStore';

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

  it('clicking a recent folder immediately calls onSelectFolder', () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('project-a'));
    expect(mockOnSelectFolder).toHaveBeenCalledWith('/root/project-a');
  });

  it('clicking "Back" calls onBack', () => {
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });

  it('shows empty state when no recent folders', () => {
    (useUIStore as ReturnType<typeof vi.fn>).mockReturnValue({
      recentFolders: [],
      getRecentFolders: vi.fn().mockReturnValue([]),
    });
    render(<DriveModeFolderPicker onSelectFolder={mockOnSelectFolder} onBack={mockOnBack} />);
    expect(screen.getByText(/No recent folders/)).toBeInTheDocument();
  });
});
