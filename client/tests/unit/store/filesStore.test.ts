import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFilesStore } from '../../../src/store/filesStore';

global.fetch = vi.fn();

describe('filesStore', () => {
  beforeEach(() => {
    useFilesStore.setState({
      currentPath: '/root',
      items: [],
      selectedFile: null,
      previewContent: null,
      previewTruncated: false,
      previewTotalSize: 0,
      isLoading: false,
      error: null,
      isEditing: false,
      editBuffer: null,
      isDirty: false,
      isSaving: false,
      saveError: null,
    });
    vi.clearAllMocks();
  });

  it('starts with /root as current path', () => {
    expect(useFilesStore.getState().currentPath).toBe('/root');
  });

  it('sets current path via setCurrentPath', () => {
    useFilesStore.getState().setCurrentPath('/tmp');
    expect(useFilesStore.getState().currentPath).toBe('/tmp');
  });

  it('navigates to a directory and stores items', async () => {
    const mockItems = [
      {
        name: 'file.txt',
        path: '/root/file.txt',
        isDirectory: false,
        isSymlink: false,
        size: 100,
        modifiedAt: '',
      },
    ];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockItems),
    });

    await useFilesStore.getState().navigate('/root');

    expect(useFilesStore.getState().items).toHaveLength(1);
    expect(useFilesStore.getState().items[0].name).toBe('file.txt');
    expect(useFilesStore.getState().currentPath).toBe('/root');
    expect(useFilesStore.getState().isLoading).toBe(false);
  });

  it('handles { files: [] } envelope from browse endpoint', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ files: [{ name: 'a.txt', path: '/root/a.txt', isDirectory: false, isSymlink: false, size: 0, modifiedAt: '' }] }),
    });

    await useFilesStore.getState().navigate('/root');
    expect(useFilesStore.getState().items).toHaveLength(1);
  });

  it('sets error on navigation failure', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Access denied' }),
    });

    await useFilesStore.getState().navigate('/etc');

    expect(useFilesStore.getState().error).toBe('Access denied');
    expect(useFilesStore.getState().isLoading).toBe(false);
  });

  it('selectFile stores preview content', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: 'hello world' }),
    });

    await useFilesStore.getState().selectFile('/root/file.txt');

    expect(useFilesStore.getState().selectedFile).toBe('/root/file.txt');
    expect(useFilesStore.getState().previewContent).toBe('hello world');
  });

  it('selectFile preserves the truncated flag and total size from the read response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: 'partial',
        truncated: true,
        totalSize: 300_000,
        readSize: 6,
      }),
    });

    await useFilesStore.getState().selectFile('/root/big.md');

    expect(useFilesStore.getState().previewTruncated).toBe(true);
    expect(useFilesStore.getState().previewTotalSize).toBe(300_000);
  });

  it('selectFile marks a small file as not truncated', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: 'small', truncated: false, totalSize: 5 }),
    });

    await useFilesStore.getState().selectFile('/root/small.md');

    expect(useFilesStore.getState().previewTruncated).toBe(false);
    expect(useFilesStore.getState().previewTotalSize).toBe(5);
  });

  it('refresh re-runs navigate with current path', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    useFilesStore.setState({ currentPath: '/home' });
    await useFilesStore.getState().refresh();

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(call).toContain(encodeURIComponent('/home'));
  });

  it('createFile POSTs to /api/files/write then refreshes', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    useFilesStore.setState({ currentPath: '/root' });

    await useFilesStore.getState().createFile('/root/new.md', 'hi');

    expect(global.fetch).toHaveBeenCalledWith('/api/files/write', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/root/new.md', content: 'hi' }),
    }));
  });

  it('createDir POSTs to /api/files/mkdir', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    useFilesStore.setState({ currentPath: '/root' });

    await useFilesStore.getState().createDir('/root/newdir');

    expect(global.fetch).toHaveBeenCalledWith('/api/files/mkdir', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/root/newdir' }),
    }));
  });

  it('renameItem PUTs to /api/files/rename', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    useFilesStore.setState({ currentPath: '/root' });

    await useFilesStore.getState().renameItem('/root/a.md', '/root/b.md');

    expect(global.fetch).toHaveBeenCalledWith('/api/files/rename', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ oldPath: '/root/a.md', newPath: '/root/b.md' }),
    }));
  });

  it('deleteItem DELETEs and clears selection when removing the selected file', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    useFilesStore.setState({ selectedFile: '/root/x.md', currentPath: '/root' });

    await useFilesStore.getState().deleteItem('/root/x.md');

    expect(global.fetch).toHaveBeenCalledWith('/api/files/delete', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ path: '/root/x.md' }),
    }));
    expect(useFilesStore.getState().selectedFile).toBeNull();
  });

  // ── editing ───────────────────────────────────────────────────────────────

  it('startEditing seeds the edit buffer from preview content', () => {
    useFilesStore.setState({ previewContent: '# Hello', previewTruncated: false });
    const result = useFilesStore.getState().startEditing();
    expect(result.ok).toBe(true);
    expect(useFilesStore.getState().isEditing).toBe(true);
    expect(useFilesStore.getState().editBuffer).toBe('# Hello');
    expect(useFilesStore.getState().isDirty).toBe(false);
  });

  it('updateEditBuffer updates the buffer and marks dirty when content changes', () => {
    useFilesStore.setState({
      previewContent: 'original',
      editBuffer: 'original',
      isEditing: true,
      isDirty: false,
    });
    useFilesStore.getState().updateEditBuffer('changed');
    expect(useFilesStore.getState().editBuffer).toBe('changed');
    expect(useFilesStore.getState().isDirty).toBe(true);
  });

  it('updateEditBuffer clears dirty when content reverts to the saved copy', () => {
    useFilesStore.setState({
      previewContent: 'original',
      editBuffer: 'changed',
      isEditing: true,
      isDirty: true,
    });
    useFilesStore.getState().updateEditBuffer('original');
    expect(useFilesStore.getState().isDirty).toBe(false);
  });

  it('cancelEditing discards the buffer and exits edit mode', () => {
    useFilesStore.setState({
      previewContent: 'original',
      editBuffer: 'changed',
      isEditing: true,
      isDirty: true,
      saveError: 'boom',
    });
    useFilesStore.getState().cancelEditing();
    expect(useFilesStore.getState().isEditing).toBe(false);
    expect(useFilesStore.getState().editBuffer).toBe(null);
    expect(useFilesStore.getState().isDirty).toBe(false);
    expect(useFilesStore.getState().saveError).toBe(null);
  });

  it('selectFile resets stale edit state from a previously edited file', async () => {
    useFilesStore.setState({
      isEditing: true,
      editBuffer: 'stale',
      isDirty: true,
      saveError: 'old error',
      previewContent: 'stale',
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: 'fresh', truncated: false, totalSize: 5 }),
    });

    await useFilesStore.getState().selectFile('/root/new.md');

    expect(useFilesStore.getState().previewContent).toBe('fresh');
    expect(useFilesStore.getState().isEditing).toBe(false);
    expect(useFilesStore.getState().editBuffer).toBe(null);
    expect(useFilesStore.getState().isDirty).toBe(false);
    expect(useFilesStore.getState().saveError).toBe(null);
  });

  it('saveFile POSTs to /api/files/write with path+content and clears dirty on success', async () => {
    useFilesStore.setState({
      selectedFile: '/root/note.md',
      previewContent: 'old',
      editBuffer: 'new content',
      isDirty: true,
      isEditing: true,
      saveError: 'previous error',
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await useFilesStore.getState().saveFile();

    expect(global.fetch).toHaveBeenCalledWith('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/root/note.md', content: 'new content' }),
    });
    const state = useFilesStore.getState();
    expect(state.isSaving).toBe(false);
    expect(state.isDirty).toBe(false);
    expect(state.saveError).toBe(null);
    // Preview is refreshed from the just-saved buffer; buffer is retained.
    expect(state.previewContent).toBe('new content');
    expect(state.editBuffer).toBe('new content');
  });

  it('saveFile retains the buffer and surfaces saveError on failure', async () => {
    useFilesStore.setState({
      selectedFile: '/root/note.md',
      previewContent: 'old',
      editBuffer: 'my precious edits',
      isDirty: true,
      isEditing: true,
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Disk full' }),
    });

    await useFilesStore.getState().saveFile();

    const state = useFilesStore.getState();
    expect(state.isSaving).toBe(false);
    // Never lose the user's text on failure.
    expect(state.editBuffer).toBe('my precious edits');
    expect(state.isDirty).toBe(true);
    expect(state.saveError).toBe('Disk full');
  });

  // ── truncation safety: never edit/save a partial (truncated) file ──────────

  it('startEditing refuses a truncated file, stays read-only, and surfaces a reason', () => {
    useFilesStore.setState({ previewContent: 'partial', previewTruncated: true });
    const result = useFilesStore.getState().startEditing();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
    }
    expect(useFilesStore.getState().isEditing).toBe(false);
    expect(useFilesStore.getState().editBuffer).toBe(null);
  });

  it('saveFile refuses a truncated file and never calls the server', async () => {
    useFilesStore.setState({
      selectedFile: '/root/big.md',
      previewContent: 'partial',
      previewTruncated: true,
      editBuffer: 'partial',
      isDirty: true,
      isEditing: true,
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await useFilesStore.getState().saveFile();

    expect(global.fetch).not.toHaveBeenCalled();
    const state = useFilesStore.getState();
    expect(state.isSaving).toBe(false);
    expect(state.saveError).toBeTruthy();
  });
});
