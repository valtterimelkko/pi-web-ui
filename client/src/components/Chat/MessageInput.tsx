import { useRef, useState, useCallback, useEffect } from 'react';
import { Paperclip, X, Settings2, ArrowUpRight, Loader2, Square, Sparkles } from 'lucide-react';
import { useChatStore, useSessionStore, useDraftStore } from '../../store';
import { useUIStore } from '../../store/uiStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { CompactModal } from './CompactModal';
import { ContextRing } from '../Usage/ContextRing';
import { SlashPalette } from './SlashPalette';
import { uploadFile } from '../../lib/api';

interface MessageInputProps {
  disabled?: boolean;
  onOpenSettings?: () => void;
}

export function MessageInput({ disabled, onOpenSettings }: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const inputValue = useChatStore((state) => state.inputValue);
  const selectedFiles = useChatStore((state) => state.selectedFiles);
  const uploadedFiles = useChatStore((state) => state.uploadedFiles);
  const isDragging = useChatStore((state) => state.isDragging);
  const showThinking = useChatStore((state) => state.showThinking);
  const toggleThinking = useChatStore((state) => state.toggleThinking);
  const setInputValue = useChatStore((state) => state.setInputValue);
  const addFiles = useChatStore((state) => state.addFiles);
  const removeFile = useChatStore((state) => state.removeFile);
  const clearFiles = useChatStore((state) => state.clearFiles);
  const setIsDragging = useChatStore((state) => state.setIsDragging);
  const addUploadedFile = useChatStore((state) => state.addUploadedFile);
  const updateUploadedFile = useChatStore((state) => state.updateUploadedFile);

  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isCompacting = useSessionStore((state) => state.isCompacting);
  const compactionReason = useSessionStore((state) => state.compactionReason);
  const currentModel = useSessionStore((state) => state.currentModel);
  const contextPercent = useSessionStore((state) => state.contextPercent);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { sendPrompt, abortGeneration } = useWebSocket();

  // Draft store for per-session draft persistence
  const currentDraft = useDraftStore((state) => state.currentDraft);
  const setDraft = useDraftStore((state) => state.setDraft);
  const syncCurrentDraft = useDraftStore((state) => state.syncCurrentDraft);
  const sendDraft = useDraftStore((state) => state.sendDraft);
  const setSendCallback = useDraftStore((state) => state.setSendCallback);

  // Sync draft when session changes
  useEffect(() => {
    syncCurrentDraft();
  }, [currentSessionId, syncCurrentDraft]);

  // Set up send callback for draft store
  useEffect(() => {
    setSendCallback(async (content: string) => {
      // Check if any files are still uploading
      const pendingUploads = useChatStore.getState().uploadedFiles.filter(f => f.uploading);
      if (pendingUploads.length > 0) {
        return false;
      }

      // Build message with file context
      const successfulUploads = useChatStore.getState().uploadedFiles.filter(f => f.serverPath && !f.error);
      let promptMessage = content;
      
      if (successfulUploads.length > 0) {
        const filePaths = successfulUploads.map(f => f.serverPath).join('\n');
        const fileNote = successfulUploads.length === 1
          ? `I've uploaded a file. Please read it at: ${filePaths}`
          : `I've uploaded ${successfulUploads.length} files. Please read them at:\n${filePaths}`;
        
        promptMessage = content
          ? `${fileNote}\n\n${content}`
          : fileNote;
      }

      const images: unknown[] = [];
      const sent = sendPrompt(promptMessage, images);
      if (!sent) {
        // Surface send failure - don't clear draft, show error toast
        useUIStore.getState().addToast({
          type: 'error',
          message: 'Failed to send message. Check your connection and try again.',
        });
        return false;
      }

      // Optimistic user message insertion - immediately show the user's message
      // The server will eventually send message_start but this ensures instant feedback
      const store = useSessionStore.getState();
      if (store.currentSessionId) {
        store.addMessage({
          id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          role: 'user',
          content: promptMessage,
          timestamp: Date.now(),
          isComplete: true,
        });
      }

      return true;
    });
  }, [sendPrompt, setSendCallback]);

  const [isFocused, setIsFocused] = useState(false);
  const [showCompactModal, setShowCompactModal] = useState(false);
  const [showSlashPalette, setShowSlashPalette] = useState(false);

  // Format model name for display
  const displayModelName = currentModel
    ? currentModel.split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    : 'No Model';

  // Auto-resize textarea
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    
    // Save to draft store for per-session persistence
    if (currentSessionId) {
      setDraft(currentSessionId, value);
    }
    
    // Also update chat store for backward compatibility
    setInputValue(value);
    adjustTextareaHeight();

    // Show slash palette when input starts with /
    if (value.startsWith('/') && value.length <= 20) {
      setShowSlashPalette(true);
    } else {
      setShowSlashPalette(false);
    }
  };

  const handleSend = useCallback(async () => {
    const message = currentDraft.trim();
    if (!message && uploadedFiles.length === 0) return;
    if (disabled || isStreaming) return;
    if (!message && uploadedFiles.length === 0) return;

    // Handle slash commands
    if (message === '/compact') {
      setShowCompactModal(true);
      if (currentSessionId) {
        setDraft(currentSessionId, '');
      }
      setInputValue('');
      clearFiles();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }

    // Check if any files are still uploading
    const pendingUploads = uploadedFiles.filter(f => f.uploading);
    if (pendingUploads.length > 0) {
      // Wait for uploads to complete
      return;
    }

    // Use sendDraft from draftStore for per-session draft handling
    const success = currentSessionId ? await sendDraft(currentSessionId) : false;
    
    // Only clear local state if send was successful
    if (success) {
      setInputValue('');
      clearFiles();
      setShowSlashPalette(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  }, [currentDraft, uploadedFiles, disabled, isStreaming, currentSessionId, sendDraft, setInputValue, clearFiles, setDraft]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      if (!e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
    if (e.key === 'Escape') {
      setShowSlashPalette(false);
    }
  };

  const handleSlashSelect = (command: string) => {
    const newValue = command + ' ';
    if (currentSessionId) {
      setDraft(currentSessionId, newValue);
    }
    setInputValue(newValue);
    setShowSlashPalette(false);
    textareaRef.current?.focus();
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFilesAdded(files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      handleFilesAdded(files);
    }
    e.target.value = '';
  };

  const handleFilesAdded = (files: File[]) => {
    addFiles(files);
    // Upload each file immediately
    files.forEach((file) => {
      addUploadedFile({ file, serverPath: '', uploading: true });
      
      uploadFile(file)
        .then((result) => {
          // Find the index in the current state
          const currentUploaded = useChatStore.getState().uploadedFiles;
          const idx = currentUploaded.findIndex(u => u.file === file && u.uploading);
          if (idx >= 0) {
            updateUploadedFile(idx, { serverPath: result.path, uploading: false });
          }
        })
        .catch((err) => {
          const currentUploaded = useChatStore.getState().uploadedFiles;
          const idx = currentUploaded.findIndex(u => u.file === file && u.uploading);
          if (idx >= 0) {
            updateUploadedFile(idx, { uploading: false, error: err.message || 'Upload failed' });
          }
        });
    });
  };

  const hasUploads = uploadedFiles.some(f => f.serverPath && !f.uploading);
  const isAnyUploading = uploadedFiles.some(f => f.uploading);
  const canSend = (currentDraft.trim().length > 0 || hasUploads) && !disabled && !isStreaming && !isAnyUploading;

  return (
    <div className="relative">
      {/* Slash palette */}
      {showSlashPalette && (
        <SlashPalette
          filter={currentDraft}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashPalette(false)}
        />
      )}

      {/* Status strip */}
      <div className="flex items-center justify-between px-3 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          {isCompacting ? (
            <>
              <Sparkles className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
              <span className="text-blue-600">
                {compactionReason || 'Compacting context...'}
              </span>
            </>
          ) : (
            <>
              <span className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
              <span className="text-gray-500">
                {isStreaming ? 'Thinking...' : 'Awaiting input'}
              </span>
            </>
          )}
        </div>
        {contextPercent > 0 && (
          <div className="flex items-center gap-1.5">
            <ContextRing
              percent={contextPercent}
              size={20}
              showLabel
              label={`Context usage: ${contextPercent}%`}
            />
            <span className="text-xs text-gray-400">{contextPercent}%</span>
          </div>
        )}
      </div>

      {/* Main composer */}
      <div
        className={`relative rounded-xl border transition-all duration-200 ${
          isDragging
            ? 'border-blue-500 bg-blue-50'
            : isFocused
            ? 'border-blue-500 bg-white'
            : 'border-gray-200 bg-white'
        } ${disabled ? 'opacity-50' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* File attachments preview */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 border-b border-gray-200">
            {selectedFiles.map((file, index) => {
              const uploadInfo = uploadedFiles[index];
              const isUploading = uploadInfo?.uploading;
              const hasError = uploadInfo?.error;
              const isSuccess = uploadInfo?.serverPath && !uploadInfo.uploading;
              
              return (
                <div
                  key={index}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
                    hasError ? 'bg-red-50 text-red-600' :
                    isSuccess ? 'bg-green-50 text-green-700' :
                    'bg-gray-100 text-gray-600'
                  }`}
                >
                  {isUploading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                  ) : (
                    <Paperclip className={`w-3.5 h-3.5 ${hasError ? 'text-red-400' : isSuccess ? 'text-green-500' : 'text-gray-400'}`} />
                  )}
                  <span className="max-w-[150px] truncate" title={isSuccess ? uploadInfo.serverPath : file.name}>
                    {file.name}
                  </span>
                  {isUploading && <span className="text-xs text-blue-500">uploading...</span>}
                  {hasError && <span className="text-xs text-red-400" title={uploadInfo.error}>failed</span>}
                  <button
                    onClick={() => removeFile(index)}
                    className="p-0.5 hover:bg-gray-200 rounded transition-colors"
                    type="button"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={currentDraft}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={disabled ? 'Select a session to start chatting...' : 'Ask anything, / for commands'}
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent px-4 py-3 text-gray-900 placeholder-gray-400 resize-none outline-none min-h-[72px] sm:min-h-[48px] max-h-[120px] sm:max-h-[200px] text-sm"
          style={{ lineHeight: '1.5', overscrollBehavior: 'contain' }}
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="flex items-center gap-2">
            {/* File attach */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
              type="button"
              title="Attach files"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Model selector pill */}
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              type="button"
              title="Change model"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span className="max-w-[80px] truncate">{displayModelName}</span>
            </button>

            {/* Thinking toggle */}
            <div className="flex items-center gap-1.5">
              <span className="hidden sm:inline text-xs text-gray-500">Thinking</span>
              <span className="sm:hidden text-xs text-gray-500">Think</span>
              <button
                onClick={toggleThinking}
                className={`w-8 h-4.5 rounded-full transition-colors relative ${
                  showThinking ? 'bg-blue-500' : 'bg-gray-300'
                }`}
                type="button"
              >
                <span
                  className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform shadow-sm ${
                    showThinking ? 'left-4' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Send/Stop button */}
          {isStreaming ? (
            <button
              onClick={abortGeneration}
              className="p-2 rounded-full bg-red-500 text-white hover:bg-red-600 transition-all"
              type="button"
              title="Stop generation"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`p-2 rounded-full transition-all ${
                canSend
                  ? 'bg-gray-900 text-white hover:bg-gray-800'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
              type="button"
              title="Send message"
            >
              <ArrowUpRight className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 bg-blue-50 border-2 border-dashed border-blue-500 rounded-xl flex items-center justify-center">
            <div className="text-blue-600 font-medium text-sm">Drop files here</div>
          </div>
        )}
      </div>

      {/* Compact Modal */}
      <CompactModal isOpen={showCompactModal} onClose={() => setShowCompactModal(false)} />
    </div>
  );
}
