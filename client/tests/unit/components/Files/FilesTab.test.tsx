import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilesTab } from '../../../../src/components/Files/FilesTab';

// ── mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: { currentSessionId: null; sessions: [] }) => unknown) =>
    selector({ currentSessionId: null, sessions: [] }),
  ),
}));

const mockNavigate = vi.fn();
let mockItems: any[] = [];

vi.mock('../../../../src/store/filesStore', () => ({
  useFilesStore: vi.fn((selector?: unknown) => {
    const state = {
      currentPath: '/root',
      items: mockItems,
      selectedFile: null,
      previewContent: null,
      isLoading: false,
      error: null,
      navigate: mockNavigate,
      refresh: vi.fn(),
      selectFile: vi.fn(),
      createFile: vi.fn(),
      createDir: vi.fn(),
      renameItem: vi.fn(),
      deleteItem: vi.fn(),
      setCurrentPath: vi.fn(),
    };
    // Support both selector and direct call patterns
    if (typeof selector === 'function') return selector(state);
    return state;
  }),
}));

const mockCopyToClipboard = vi.fn(() => Promise.resolve(true));
vi.mock('../../../../src/lib/clipboard', () => ({
  copyToClipboard: (...args: any[]) => mockCopyToClipboard(...args),
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe('FilesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockItems = [];
  });

  it('renders without crashing', () => {
    render(<FilesTab />);
    expect(document.body).toBeDefined();
  });

  it('shows empty directory message when no items', () => {
    render(<FilesTab />);
    expect(screen.getByText('Empty directory')).toBeDefined();
  });

  it('renders breadcrumb root segment', () => {
    render(<FilesTab />);
    // Root "/" button should be visible
    expect(screen.getByText('/')).toBeDefined();
  });

  it('renders filter input', () => {
    render(<FilesTab />);
    const input = screen.getByPlaceholderText('Filter files…');
    expect(input).toBeDefined();
  });

  it('renders toolbar buttons (refresh, new file, new folder)', () => {
    render(<FilesTab />);
    expect(screen.getByTitle('Refresh')).toBeDefined();
    expect(screen.getByTitle('New file')).toBeDefined();
    expect(screen.getByTitle('New folder')).toBeDefined();
  });

  it('renders copy path buttons for items and calls copyToClipboard on click', async () => {
    mockItems = [
      { name: 'folder1', path: '/root/folder1', isDirectory: true, size: 0, modifiedAt: '' },
      { name: 'file1.txt', path: '/root/file1.txt', isDirectory: false, size: 100, modifiedAt: '' },
    ];
    render(<FilesTab />);

    // Renders the file and folder names
    expect(screen.getByText('folder1')).toBeDefined();
    expect(screen.getByText('file1.txt')).toBeDefined();

    // Renders Copy path buttons (2 for folder, 2 for file due to icon and action buttons having "Copy path" title)
    const copyButtons = screen.getAllByTitle('Copy path');
    expect(copyButtons.length).toBe(4);

    // Click the copy action button (or icon button) for folder1
    fireEvent.click(copyButtons[0]);
    expect(mockCopyToClipboard).toHaveBeenCalledWith('/root/folder1', 'Path copied to clipboard');

    // Click the copy button for file1.txt
    fireEvent.click(copyButtons[3]);
    expect(mockCopyToClipboard).toHaveBeenCalledWith('/root/file1.txt', 'Path copied to clipboard');
  });

  it('triggers copy on touch long press', () => {
    vi.useFakeTimers();
    mockItems = [
      { name: 'file1.txt', path: '/root/file1.txt', isDirectory: false, size: 100, modifiedAt: '' },
    ];
    render(<FilesTab />);

    const row = screen.getByText('file1.txt').closest('.group');
    expect(row).not.toBeNull();

    if (row) {
      fireEvent.touchStart(row);
      vi.advanceTimersByTime(600);
      expect(mockCopyToClipboard).toHaveBeenCalledWith('/root/file1.txt', 'Path copied to clipboard');
    }
    vi.useRealTimers();
  });
});
