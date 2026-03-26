import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, UploadedFileInfo } from '../../../src/store/chatStore';
import { act } from '@testing-library/react';

describe('ChatStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useChatStore.setState({
      inputValue: '',
      selectedFiles: [],
      uploadedFiles: [],
      isDragging: false,
      showThinking: true,
      sidebarOpen: true,
    });
  });

  describe('UI State', () => {
    it('should toggle thinking visibility', () => {
      const { toggleThinking } = useChatStore.getState();

      expect(useChatStore.getState().showThinking).toBe(true);

      act(() => {
        toggleThinking();
      });

      expect(useChatStore.getState().showThinking).toBe(false);

      act(() => {
        toggleThinking();
      });

      expect(useChatStore.getState().showThinking).toBe(true);
    });

    it('should toggle sidebar visibility', () => {
      const { toggleSidebar } = useChatStore.getState();

      expect(useChatStore.getState().sidebarOpen).toBe(true);

      act(() => {
        toggleSidebar();
      });

      expect(useChatStore.getState().sidebarOpen).toBe(false);

      act(() => {
        toggleSidebar();
      });

      expect(useChatStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('Input State', () => {
    it('should set input value', () => {
      const { setInputValue } = useChatStore.getState();

      act(() => {
        setInputValue('Hello world');
      });

      expect(useChatStore.getState().inputValue).toBe('Hello world');

      act(() => {
        setInputValue('Updated text');
      });

      expect(useChatStore.getState().inputValue).toBe('Updated text');
    });

    it('should clear input value', () => {
      const { setInputValue } = useChatStore.getState();

      act(() => {
        setInputValue('Some text');
      });

      expect(useChatStore.getState().inputValue).toBe('Some text');

      act(() => {
        setInputValue('');
      });

      expect(useChatStore.getState().inputValue).toBe('');
    });
  });

  describe('File Handling', () => {
    it('should add files', () => {
      const { addFiles } = useChatStore.getState();
      const file1 = new File(['content1'], 'test1.txt');
      const file2 = new File(['content2'], 'test2.txt');

      act(() => {
        addFiles([file1]);
      });

      expect(useChatStore.getState().selectedFiles).toHaveLength(1);
      expect(useChatStore.getState().selectedFiles[0]).toBe(file1);

      act(() => {
        addFiles([file2]);
      });

      expect(useChatStore.getState().selectedFiles).toHaveLength(2);
      expect(useChatStore.getState().selectedFiles[1]).toBe(file2);
    });

    it('should remove file by index', () => {
      const { addFiles, removeFile } = useChatStore.getState();
      const file1 = new File(['content1'], 'test1.txt');
      const file2 = new File(['content2'], 'test2.txt');

      act(() => {
        addFiles([file1, file2]);
      });

      expect(useChatStore.getState().selectedFiles).toHaveLength(2);

      act(() => {
        removeFile(0);
      });

      expect(useChatStore.getState().selectedFiles).toHaveLength(1);
      expect(useChatStore.getState().selectedFiles[0]).toBe(file2);
    });

    it('should clear all files', () => {
      const { addFiles, clearFiles } = useChatStore.getState();
      const file1 = new File(['content1'], 'test1.txt');
      const file2 = new File(['content2'], 'test2.txt');

      act(() => {
        addFiles([file1, file2]);
      });

      expect(useChatStore.getState().selectedFiles).toHaveLength(2);

      act(() => {
        clearFiles();
      });

      expect(useChatStore.getState().selectedFiles).toHaveLength(0);
      expect(useChatStore.getState().uploadedFiles).toHaveLength(0);
    });

    it('should set dragging state', () => {
      const { setIsDragging } = useChatStore.getState();

      expect(useChatStore.getState().isDragging).toBe(false);

      act(() => {
        setIsDragging(true);
      });

      expect(useChatStore.getState().isDragging).toBe(true);

      act(() => {
        setIsDragging(false);
      });

      expect(useChatStore.getState().isDragging).toBe(false);
    });
  });

  describe('Uploaded Files', () => {
    it('should add uploaded file info', () => {
      const { addUploadedFile } = useChatStore.getState();
      const file = new File(['content'], 'test.txt');
      const info: UploadedFileInfo = {
        file,
        serverPath: '',
        uploading: true,
      };

      act(() => {
        addUploadedFile(info);
      });

      expect(useChatStore.getState().uploadedFiles).toHaveLength(1);
      expect(useChatStore.getState().uploadedFiles[0]).toEqual(info);
    });

    it('should update uploaded file info', () => {
      const { addUploadedFile, updateUploadedFile } = useChatStore.getState();
      const file = new File(['content'], 'test.txt');

      act(() => {
        addUploadedFile({ file, serverPath: '', uploading: true });
      });

      act(() => {
        updateUploadedFile(0, { serverPath: '/uploads/test.txt', uploading: false });
      });

      const uploaded = useChatStore.getState().uploadedFiles[0];
      expect(uploaded.serverPath).toBe('/uploads/test.txt');
      expect(uploaded.uploading).toBe(false);
    });

    it('should clear uploaded files', () => {
      const { addUploadedFile, clearUploadedFiles } = useChatStore.getState();
      const file = new File(['content'], 'test.txt');

      act(() => {
        addUploadedFile({ file, serverPath: '/uploads/test.txt', uploading: false });
      });

      expect(useChatStore.getState().uploadedFiles).toHaveLength(1);

      act(() => {
        clearUploadedFiles();
      });

      expect(useChatStore.getState().uploadedFiles).toHaveLength(0);
    });

    it('should handle upload errors', () => {
      const { addUploadedFile, updateUploadedFile } = useChatStore.getState();
      const file = new File(['content'], 'test.txt');

      act(() => {
        addUploadedFile({ file, serverPath: '', uploading: true });
      });

      act(() => {
        updateUploadedFile(0, { uploading: false, error: 'Upload failed' });
      });

      const uploaded = useChatStore.getState().uploadedFiles[0];
      expect(uploaded.uploading).toBe(false);
      expect(uploaded.error).toBe('Upload failed');
    });
  });

  describe('State Independence', () => {
    it('should maintain independent UI state from file state', () => {
      const {
        toggleThinking,
        toggleSidebar,
        addFiles,
      } = useChatStore.getState();
      const file = new File(['content'], 'test.txt');

      act(() => {
        toggleThinking();
        toggleSidebar();
        addFiles([file]);
      });

      const state = useChatStore.getState();
      expect(state.showThinking).toBe(false);
      expect(state.sidebarOpen).toBe(false);
      expect(state.selectedFiles).toHaveLength(1);
    });

    it('should not affect UI state when clearing files', () => {
      const { addFiles, clearFiles, toggleThinking } = useChatStore.getState();
      const file = new File(['content'], 'test.txt');

      act(() => {
        toggleThinking();
        addFiles([file]);
      });

      expect(useChatStore.getState().showThinking).toBe(false);
      expect(useChatStore.getState().selectedFiles).toHaveLength(1);

      act(() => {
        clearFiles();
      });

      expect(useChatStore.getState().showThinking).toBe(false); // Should remain unchanged
      expect(useChatStore.getState().selectedFiles).toHaveLength(0);
    });
  });
});
