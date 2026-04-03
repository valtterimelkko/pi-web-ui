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
      isLoading: false,
      error: null,
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
});
