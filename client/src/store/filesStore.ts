import { create } from 'zustand';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string;
  extension?: string;
}

interface FilesState {
  currentPath: string;
  items: FileEntry[];
  selectedFile: string | null;
  previewContent: string | null;
  isLoading: boolean;
  error: string | null;

  navigate: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  renameItem: (oldPath: string, newPath: string) => Promise<void>;
  deleteItem: (path: string) => Promise<void>;
  setCurrentPath: (path: string) => void;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const useFilesStore = create<FilesState>((set, get) => ({
  currentPath: '/root',
  items: [],
  selectedFile: null,
  previewContent: null,
  isLoading: false,
  error: null,

  setCurrentPath: (path) => set({ currentPath: path }),

  navigate: async (path) => {
    try {
      set({ isLoading: true, error: null, selectedFile: null, previewContent: null });
      const result = await apiFetch(`/api/files/browse?path=${encodeURIComponent(path)}`);
      const items: FileEntry[] = Array.isArray(result)
        ? result
        : (result.files || result.entries || []);
      set({ currentPath: path, items, isLoading: false });
    } catch (e) {
      set({ error: (e as Error).message, isLoading: false });
    }
  },

  refresh: async () => {
    await get().navigate(get().currentPath);
  },

  selectFile: async (path) => {
    try {
      set({ selectedFile: path, isLoading: true });
      const result = await apiFetch(`/api/files/read?path=${encodeURIComponent(path)}`);
      const content =
        typeof result === 'string' ? result : (result.content ?? JSON.stringify(result));
      set({ previewContent: content, isLoading: false });
    } catch (e) {
      set({ error: (e as Error).message, isLoading: false, previewContent: null });
    }
  },

  createFile: async (path, content = '') => {
    await apiFetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    await get().refresh();
  },

  createDir: async (path) => {
    await apiFetch('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    await get().refresh();
  },

  renameItem: async (oldPath, newPath) => {
    await apiFetch('/api/files/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath }),
    });
    await get().refresh();
  },

  deleteItem: async (path) => {
    await apiFetch('/api/files/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (get().selectedFile === path) {
      set({ selectedFile: null, previewContent: null });
    }
    await get().refresh();
  },
}));
