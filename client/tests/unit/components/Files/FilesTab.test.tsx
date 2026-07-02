import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FilesTab } from '../../../../src/components/Files/FilesTab';

// ── mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: { currentSessionId: null; sessions: [] }) => unknown) =>
    selector({ currentSessionId: null, sessions: [] }),
  ),
}));

const mockNavigate = vi.fn();
const mockSelectFile = vi.fn();
const mockStartEditing = vi.fn(() => ({ ok: true }));
const mockUpdateEditBuffer = vi.fn();
const mockSaveFile = vi.fn();
const mockCancelEditing = vi.fn();
const mockSetState = vi.fn();
let mockItems: any[] = [];
// Mutable editor-relevant store slices (defaults match a fresh store).
let mockSelectedFile: string | null = null;
let mockPreviewContent: string | null = null;
let mockPreviewTruncated = false;
let mockPreviewTotalSize = 0;
let mockEditBuffer: string | null = null;
let mockIsEditing = false;
let mockIsDirty = false;
let mockIsSaving = false;
let mockSaveError: string | null = null;

vi.mock('../../../../src/store/filesStore', () => ({
  // Object.assign attaches `.setState` to the hook (like the real zustand hook)
  // via a lazy wrapper, so the `mock`-prefixed var is accessed at call time only.
  useFilesStore: Object.assign(
    vi.fn((selector?: unknown) => {
      const state = {
        currentPath: '/root',
        items: mockItems,
        selectedFile: mockSelectedFile,
        previewContent: mockPreviewContent,
        previewTruncated: mockPreviewTruncated,
        previewTotalSize: mockPreviewTotalSize,
        isLoading: false,
        error: null,
        isEditing: mockIsEditing,
        editBuffer: mockEditBuffer,
        isDirty: mockIsDirty,
        isSaving: mockIsSaving,
        saveError: mockSaveError,
        navigate: mockNavigate,
        refresh: vi.fn(),
        selectFile: mockSelectFile,
        createFile: vi.fn(),
        createDir: vi.fn(),
        renameItem: vi.fn(),
        deleteItem: vi.fn(),
        setCurrentPath: vi.fn(),
        startEditing: mockStartEditing,
        updateEditBuffer: mockUpdateEditBuffer,
        saveFile: mockSaveFile,
        cancelEditing: mockCancelEditing,
      };
      // Support both selector and direct call patterns
      if (typeof selector === 'function') return selector(state);
      return state;
    }),
    { setState: (...args: unknown[]) => mockSetState(...args) },
  ),
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
    mockSelectedFile = null;
    mockPreviewContent = null;
    mockPreviewTruncated = false;
    mockPreviewTotalSize = 0;
    mockEditBuffer = null;
    mockIsEditing = false;
    mockIsDirty = false;
    mockIsSaving = false;
    mockSaveError = null;
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

  // ── Markdown editor wiring ────────────────────────────────────────────────

  it('renders the Markdown editor (not the read-only pre) for a .md file', () => {
    mockSelectedFile = '/root/note.md';
    mockPreviewContent = '# Hello';
    mockEditBuffer = '# Hello';
    const { container } = render(<FilesTab />);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe('# Hello');
    // The read-only <pre> preview is not used for an editable markdown file.
    expect(container.querySelector('pre')).toBeNull();
  });

  it('renders the read-only pre preview for a non-markdown file', () => {
    mockSelectedFile = '/root/data.json';
    mockPreviewContent = '{"a":1}';
    const { container } = render(<FilesTab />);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('renders the read-only pre and a notice (no editor) for a truncated markdown file', () => {
    mockSelectedFile = '/root/huge.md';
    mockPreviewContent = 'partial content…';
    mockPreviewTruncated = true;
    mockPreviewTotalSize = 300_000;
    const { container } = render(<FilesTab />);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
    expect(screen.getByText(/too large/i)).toBeInTheDocument();
  });

  it('wires the editor Save button to the store saveFile action', () => {
    mockSelectedFile = '/root/note.md';
    mockPreviewContent = '# Hi';
    mockEditBuffer = '# Hi edited';
    mockIsDirty = true;
    render(<FilesTab />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(mockSaveFile).toHaveBeenCalledTimes(1);
  });

  it('wires the editor textarea changes to updateEditBuffer', () => {
    mockSelectedFile = '/root/note.md';
    mockPreviewContent = '# Hi';
    mockEditBuffer = '# Hi';
    const { container } = render(<FilesTab />);
    const textareaEl = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textareaEl, { target: { value: '# Hi edited' } });
    expect(mockUpdateEditBuffer).toHaveBeenCalledWith('# Hi edited');
  });

  it('closing the editor cancels editing and clears the selection', () => {
    mockSelectedFile = '/root/note.md';
    mockPreviewContent = '# Hi';
    mockEditBuffer = '# Hi';
    mockIsDirty = false; // no unsaved-changes prompt
    render(<FilesTab />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(mockCancelEditing).toHaveBeenCalledTimes(1);
    expect(mockSetState).toHaveBeenCalled();
    const lastCall = mockSetState.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall.selectedFile).toBeNull();
  });

  it('refresh re-reads the file from disk via selectFile when there are no unsaved changes', () => {
    mockSelectedFile = '/root/note.md';
    mockPreviewContent = '# Hi';
    mockEditBuffer = '# Hi';
    mockIsDirty = false;
    render(<FilesTab />);
    // Scope to the editor dialog: the Files toolbar also has a Refresh button.
    const editor = within(screen.getByRole('dialog'));
    fireEvent.click(editor.getByRole('button', { name: /refresh/i }));
    expect(mockSelectFile).toHaveBeenCalledWith('/root/note.md');
  });

  it('refresh prompts before discarding unsaved changes', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockSelectedFile = '/root/note.md';
    mockPreviewContent = '# Hi';
    mockEditBuffer = '# Hi changed';
    mockIsDirty = true;
    render(<FilesTab />);
    const editor = within(screen.getByRole('dialog'));
    fireEvent.click(editor.getByRole('button', { name: /refresh/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockSelectFile).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
