import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useGitStore } from '../../../src/store/gitStore';

// Mock fetch
global.fetch = vi.fn();

describe('gitStore', () => {
  beforeEach(() => {
    useGitStore.setState({
      status: null, branches: { current: '', list: [] },
      log: [], diff: '', selectedFile: null, isLoading: false, error: null, cwd: null,
    });
    vi.clearAllMocks();
  });

  it('starts with null status', () => {
    expect(useGitStore.getState().status).toBeNull();
  });

  it('sets cwd', () => {
    useGitStore.getState().setCwd('/root/test');
    expect(useGitStore.getState().cwd).toBe('/root/test');
  });

  it('sets selected file', () => {
    useGitStore.getState().setSelectedFile('test.ts');
    expect(useGitStore.getState().selectedFile).toBe('test.ts');
  });

  it('fetches status successfully', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isRepo: true, branch: 'main', ahead: 0, behind: 0,
        staged: [], unstaged: [], untracked: [],
      }),
    });
    await useGitStore.getState().fetchStatus('/root/test');
    expect(useGitStore.getState().status?.branch).toBe('main');
    expect(useGitStore.getState().isLoading).toBe(false);
  });

  it('handles fetch error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Not a git repo' }),
    });
    await useGitStore.getState().fetchStatus('/tmp');
    expect(useGitStore.getState().error).toBe('Not a git repo');
  });
});
