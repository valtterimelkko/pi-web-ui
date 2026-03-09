import { create } from 'zustand';

interface ChatState {
  // Input state
  inputValue: string;
  selectedFiles: File[];
  isDragging: boolean;
  showThinking: boolean;
  
  // UI state
  sidebarOpen: boolean;
  activeToolCall: string | null;
  
  // Actions
  setInputValue: (value: string) => void;
  addFiles: (files: File[]) => void;
  removeFile: (index: number) => void;
  clearFiles: () => void;
  setIsDragging: (isDragging: boolean) => void;
  toggleThinking: () => void;
  toggleSidebar: () => void;
  setActiveToolCall: (id: string | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  inputValue: '',
  selectedFiles: [],
  isDragging: false,
  showThinking: true,
  sidebarOpen: true,
  activeToolCall: null,

  setInputValue: (value) => set({ inputValue: value }),
  
  addFiles: (files) => set((state) => ({
    selectedFiles: [...state.selectedFiles, ...files],
  })),
  
  removeFile: (index) => set((state) => ({
    selectedFiles: state.selectedFiles.filter((_, i) => i !== index),
  })),
  
  clearFiles: () => set({ selectedFiles: [] }),
  
  setIsDragging: (isDragging) => set({ isDragging }),
  
  toggleThinking: () => set((state) => ({ showThinking: !state.showThinking })),
  
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  
  setActiveToolCall: (id) => set({ activeToolCall: id }),
}));
