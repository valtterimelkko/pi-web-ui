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

/**
 * Result of `startEditing`. `ok: false` carries a human-readable `reason` the
 * UI can surface (e.g. the file was loaded truncated and is read-only).
 */
export type StartEditingResult = { ok: true } | { ok: false; reason: string };

interface FilesState {
  currentPath: string;
  items: FileEntry[];
  selectedFile: string | null;
  previewContent: string | null;
  previewTruncated: boolean;
  previewTotalSize: number;
  isLoading: boolean;
  error: string | null;

  // ── markdown editing state ──
  isEditing: boolean;
  editBuffer: string | null;
  isDirty: boolean;
  isSaving: boolean;
  saveError: string | null;

  navigate: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  renameItem: (oldPath: string, newPath: string) => Promise<void>;
  deleteItem: (path: string) => Promise<void>;
  setCurrentPath: (path: string) => void;
  startEditing: () => StartEditingResult;
  updateEditBuffer: (next: string) => void;
  saveFile: () => Promise<void>;
  cancelEditing: () => void;
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
  previewTruncated: false,
  previewTotalSize: 0,
  isLoading: false,
  error: null,

  // ── markdown editing state ──
  isEditing: false,
  editBuffer: null,
  isDirty: false,
  isSaving: false,
  saveError: null,

  setCurrentPath: (path) => set({ currentPath: path }),

  navigate: async (path) => {
    try {
      set({
        isLoading: true,
        error: null,
        selectedFile: null,
        previewContent: null,
        previewTruncated: false,
        previewTotalSize: 0,
        isEditing: false,
        editBuffer: null,
        isDirty: false,
        saveError: null,
      });
      const result = await apiFetch(`/api/files/browse?path=${encodeURIComponent(path)}`);
      // Server returns { path, parent, items } where each item has `type: 'directory'|'file'`
      const rawItems: Array<Record<string, unknown>> = Array.isArray(result)
        ? result
        : (result.items || result.files || result.entries || []);
      const items: FileEntry[] = rawItems.map((item) => ({
        name: item.name as string,
        path: item.path as string,
        isDirectory: item.isDirectory === true || item.type === 'directory',
        isSymlink: (item.isSymlink as boolean) ?? false,
        size: (item.size as number) ?? 0,
        modifiedAt: (item.modifiedAt as string) ?? '',
        extension: item.extension as string | undefined,
      }));
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
      // Preserve the server's truncation signal — the old UI discarded this,
      // which made it impossible to guard editing of large files (data loss).
      const truncated = typeof result === 'string' ? false : (result.truncated ?? false);
      const totalSize =
        typeof result === 'string' ? content.length : (result.totalSize ?? content.length);
      set({
        previewContent: content,
        previewTruncated: truncated,
        previewTotalSize: totalSize,
        isLoading: false,
        // A different file is now selected — drop any edit state from the
        // previous file so the editor re-seeds from this file's content.
        isEditing: false,
        editBuffer: null,
        isDirty: false,
        saveError: null,
      });
    } catch (e) {
      set({
        error: (e as Error).message,
        isLoading: false,
        previewContent: null,
        previewTruncated: false,
        previewTotalSize: 0,
        isEditing: false,
        editBuffer: null,
        isDirty: false,
        saveError: null,
      });
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
      set({ selectedFile: null, previewContent: null, previewTruncated: false, previewTotalSize: 0 });
    }
    await get().refresh();
  },

  // ── markdown editing ──────────────────────────────────────────────────────

  startEditing: () => {
    const { previewTruncated, previewContent } = get();
    // CRITICAL: never let a user edit a file that was loaded truncated —
    // saving would overwrite the full on-disk file with a partial copy.
    if (previewTruncated) {
      return {
        ok: false,
        reason: 'This file is too large to edit safely here and is read-only.',
      };
    }
    set({
      isEditing: true,
      editBuffer: previewContent ?? '',
      isDirty: false,
      saveError: null,
    });
    return { ok: true };
  },

  updateEditBuffer: (next) => {
    set({ editBuffer: next, isDirty: next !== get().previewContent });
  },

  saveFile: async () => {
    const { selectedFile, editBuffer, previewTruncated } = get();
    // CRITICAL: refuse to save a truncated file (belt-and-braces alongside the
    // UI gate) — see startEditing.
    if (previewTruncated) {
      set({ saveError: 'This file is too large to edit safely and cannot be saved.' });
      return;
    }
    if (selectedFile == null || editBuffer == null) return;
    set({ isSaving: true, saveError: null });
    try {
      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: editBuffer }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(err.error || 'Save failed');
      }
      // Success: the buffer is now the on-disk content, so refresh the
      // preview from it and clear the dirty flag.
      set({
        isSaving: false,
        isDirty: false,
        previewContent: editBuffer,
        saveError: null,
      });
    } catch (e) {
      // Keep the buffer — never lose the user's text on a failed save.
      set({ isSaving: false, saveError: (e as Error).message });
    }
  },

  cancelEditing: () => {
    set({ isEditing: false, editBuffer: null, isDirty: false, saveError: null });
  },
}));
