import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { GitTab } from '../../../../src/components/Git/GitTab';
import { useGitStore } from '../../../../src/store/gitStore';

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: { currentSessionId: string | null; sessions: [] }) => unknown) => {
    const state = { currentSessionId: null, sessions: [] };
    return selector ? selector(state) : state;
  }),
}));

describe('GitTab', () => {
  beforeEach(() => {
    useGitStore.setState({
      status: null, branches: { current: '', list: [] },
      log: [], diff: '', selectedFile: null, isLoading: false, error: null, cwd: null,
      fetchStatus: vi.fn(), fetchBranches: vi.fn(), fetchLog: vi.fn(),
      fetchDiff: vi.fn(), stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(),
      commit: vi.fn(), push: vi.fn(), pull: vi.fn(), checkout: vi.fn(),
      setSelectedFile: vi.fn(), setCwd: vi.fn(),
      refresh: vi.fn(),
    });
  });

  it('renders git panel', () => {
    render(<GitTab />);
    // Should render without crashing
    expect(document.body).toBeDefined();
  });

  it('shows not-a-git-repo message when isRepo is false', () => {
    useGitStore.setState({
      status: { isRepo: false, branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
    } as Parameters<typeof useGitStore.setState>[0]);
    render(<GitTab />);
    expect(screen.getByText('Not a git repository')).toBeDefined();
  });
});
