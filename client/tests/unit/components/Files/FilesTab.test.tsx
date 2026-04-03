import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilesTab } from '../../../../src/components/Files/FilesTab';

// ── mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: { currentSessionId: null; sessions: [] }) => unknown) =>
    selector({ currentSessionId: null, sessions: [] }),
  ),
}));

const mockNavigate = vi.fn();

vi.mock('../../../../src/store/filesStore', () => ({
  useFilesStore: vi.fn((selector?: unknown) => {
    const state = {
      currentPath: '/root',
      items: [],
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

// ── tests ─────────────────────────────────────────────────────────────────

describe('FilesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
