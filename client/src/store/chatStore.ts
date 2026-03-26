import { create } from 'zustand';

export interface UploadedFileInfo {
  file: File;
  serverPath: string;
  uploading: boolean;
  error?: string;
}

interface ChatState {
  // Input state
  inputValue: string;
  selectedFiles: File[];
  uploadedFiles: UploadedFileInfo[];
  isDragging: boolean;

  // UI state
  showThinking: boolean;
  sidebarOpen: boolean;

  // Actions
  setInputValue: (value: string) => void;
  addFiles: (files: File[]) => void;
  removeFile: (index: number) => void;
  clearFiles: () => void;
  setIsDragging: (isDragging: boolean) => void;
  toggleThinking: () => void;
  toggleSidebar: () => void;
  addUploadedFile: (info: UploadedFileInfo) => void;
  updateUploadedFile: (index: number, updates: Partial<UploadedFileInfo>) => void;
  clearUploadedFiles: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  inputValue: '',
  selectedFiles: [],
  uploadedFiles: [],
  isDragging: false,
  showThinking: true,
  sidebarOpen: true,

  setInputValue: (value) => set({ inputValue: value }),

  addFiles: (files) => set((state) => ({
    selectedFiles: [...state.selectedFiles, ...files],
  })),

  removeFile: (index) => set((state) => ({
    selectedFiles: state.selectedFiles.filter((_, i) => i !== index),
    uploadedFiles: state.uploadedFiles.filter((_, i) => i !== index),
  })),

  clearFiles: () => set({ selectedFiles: [], uploadedFiles: [] }),

  setIsDragging: (isDragging) => set({ isDragging }),

  toggleThinking: () => set((state) => ({ showThinking: !state.showThinking })),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  addUploadedFile: (info) => set((state) => ({
    uploadedFiles: [...state.uploadedFiles, info],
  })),

  updateUploadedFile: (index, updates) => set((state) => ({
    uploadedFiles: state.uploadedFiles.map((f, i) => i === index ? { ...f, ...updates } : f),
  })),

  clearUploadedFiles: () => set({ uploadedFiles: [] }),
}));
