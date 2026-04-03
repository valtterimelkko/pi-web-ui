import { create } from 'zustand';

// Inline types (mirrors server-side git-service types)
interface GitFileStatus {
  path: string;
  staged: boolean;
  status: string;
  stagedStatus?: string;
}

interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
}

interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit?: string;
}

interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs: string;
}

interface GitState {
  status: GitStatus | null;
  branches: { current: string; list: GitBranch[] };
  log: GitLogEntry[];
  diff: string;
  selectedFile: string | null;
  isLoading: boolean;
  error: string | null;
  cwd: string | null;

  // Actions
  fetchStatus: (cwd: string) => Promise<void>;
  fetchBranches: (cwd: string) => Promise<void>;
  fetchLog: (cwd: string) => Promise<void>;
  fetchDiff: (cwd: string, staged?: boolean, file?: string) => Promise<void>;
  stage: (cwd: string, paths: string[]) => Promise<void>;
  unstage: (cwd: string, paths: string[]) => Promise<void>;
  discard: (cwd: string, paths: string[]) => Promise<void>;
  commit: (cwd: string, message: string) => Promise<void>;
  push: (cwd: string) => Promise<void>;
  pull: (cwd: string) => Promise<void>;
  checkout: (cwd: string, branch: string) => Promise<void>;
  setSelectedFile: (file: string | null) => void;
  setCwd: (cwd: string) => void;
  refresh: (cwd: string) => Promise<void>;
}

async function gitFetch(path: string, options?: RequestInit) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const useGitStore = create<GitState>((set, get) => ({
  status: null,
  branches: { current: '', list: [] },
  log: [],
  diff: '',
  selectedFile: null,
  isLoading: false,
  error: null,
  cwd: null,

  setCwd: (cwd) => set({ cwd }),
  setSelectedFile: (file) => set({ selectedFile: file }),

  fetchStatus: async (cwd) => {
    try {
      set({ isLoading: true, error: null });
      const status = await gitFetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
      set({ status, isLoading: false });
    } catch (e) {
      set({ error: (e as Error).message, isLoading: false });
    }
  },

  fetchBranches: async (cwd) => {
    try {
      const result = await gitFetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
      set({ branches: { current: result.current, list: result.branches } });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  fetchLog: async (cwd) => {
    try {
      const log = await gitFetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=50`);
      set({ log });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  fetchDiff: async (cwd, staged = false, file?: string) => {
    try {
      const params = new URLSearchParams({ cwd, staged: String(staged) });
      if (file) params.set('file', file);
      const result = await gitFetch(`/api/git/diff?${params}`);
      set({ diff: result.diff || '' });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  stage: async (cwd, paths) => {
    await gitFetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, paths }),
    });
    await get().fetchStatus(cwd);
  },

  unstage: async (cwd, paths) => {
    await gitFetch('/api/git/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, paths }),
    });
    await get().fetchStatus(cwd);
  },

  discard: async (cwd, paths) => {
    await gitFetch('/api/git/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, paths }),
    });
    await get().fetchStatus(cwd);
  },

  commit: async (cwd, message) => {
    await gitFetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, message }),
    });
    await get().fetchStatus(cwd);
    await get().fetchLog(cwd);
  },

  push: async (cwd) => {
    await gitFetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
  },

  pull: async (cwd) => {
    await gitFetch('/api/git/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    await get().fetchStatus(cwd);
  },

  checkout: async (cwd, branch) => {
    await gitFetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, branch }),
    });
    await get().fetchStatus(cwd);
    await get().fetchBranches(cwd);
  },

  refresh: async (cwd) => {
    await Promise.all([
      get().fetchStatus(cwd),
      get().fetchBranches(cwd),
      get().fetchLog(cwd),
    ]);
  },
}));
