import { useRef, useState, useCallback, useEffect, memo } from 'react';
import { Paperclip, X, Settings2, ArrowUpRight, Loader2, Square, Sparkles } from 'lucide-react';
import { useDraftStore } from '../../store';
import { useUIStore } from '../../store/uiStore';
import { CompactModal } from './CompactModal';
import { ContextRing } from '../Usage/ContextRing';
import { SlashPalette } from './SlashPalette';
import { uploadFile } from '../../lib/api';

interface UploadedFile {
  file: File;
  serverPath: string;
  uploading: boolean;
  error?: string;
}

export interface MessageInputProps {
  disabled?: boolean;
  isStreaming: boolean;
  isCompacting?: boolean;
  compactionReason?: string | null;
  currentModel?: string | null;
  contextPercent?: number;
  currentSessionId?: string | null;
  currentSessionSdkType?: 'pi' | 'claude' | null;
  quotaInfo?: { isUsingOverage: boolean; status: string; rateLimitType: string; resetsAt?: number } | null;
  onSend: (content: string, images?: unknown[]) => boolean;
  onCancel: () => void;
  onOpenSettings?: () => void;
  isReplaying?: boolean;
}

export const MessageInput = memo(function MessageInput({
  disabled,
  isStreaming,
  isCompacting,
  compactionReason,
  currentModel,
  contextPercent = 0,
  currentSessionId,
  currentSessionSdkType,
  quotaInfo,
  onSend,
  onCancel,
  onOpenSettings,
  isReplaying,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Local state for file attachments (formerly useChatStore)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showThinking, setShowThinking] = useState(true);

  // Input value — sourced from draftStore via getState() in callbacks, not subscription
  const [inputValue, setInputValue] = useState('');

  const [isFocused, setIsFocused] = useState(false);
  const [showCompactModal, setShowCompactModal] = useState(false);
  const [showSlashPalette, setShowSlashPalette] = useState(false);

  // Derive if current session is Claude Direct
  const isClaudeSession = currentSessionSdkType === 'claude';

  // Load draft on session change — use getState(), NOT a subscription
  useEffect(() => {
    if (currentSessionId) {
      const draft = useDraftStore.getState().getDraft(currentSessionId);
      setInputValue(draft || '');
    } else {
      setInputValue('');
    }
  }, [currentSessionId]);

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

    // Save to draft store for per-session persistence — use getState()
    if (currentSessionId) {
      useDraftStore.getState().setDraft(currentSessionId, value);
    }

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
    const message = inputValue.trim();
    if (!message && uploadedFiles.length === 0) return;
    if (disabled || isStreaming) return;

    // Handle slash commands
    if (message === '/compact') {
      setShowCompactModal(true);
      if (currentSessionId) {
        useDraftStore.getState().setDraft(currentSessionId, '');
      }
      setInputValue('');
      setSelectedFiles([]);
      setUploadedFiles([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }

    // Check if any files are still uploading
    const pendingUploads = uploadedFiles.filter(f => f.uploading);
    if (pendingUploads.length > 0) {
      return;
    }

    // Build message with file context
    const successfulUploads = uploadedFiles.filter(f => f.serverPath && !f.error);
    let promptMessage = message;

    if (successfulUploads.length > 0) {
      const filePaths = successfulUploads.map(f => f.serverPath).join('\n');
      const fileNote = successfulUploads.length === 1
        ? `I've uploaded a file. Please read it at: ${filePaths}`
        : `I've uploaded ${successfulUploads.length} files. Please read them at:\n${filePaths}`;

      promptMessage = message
        ? `${fileNote}\n\n${message}`
        : fileNote;
    }

    const images: unknown[] = [];
    const sent = onSend(promptMessage, images);

    if (sent) {
      // Clear draft after successful send
      if (currentSessionId) {
        useDraftStore.getState().clearDraft(currentSessionId);
      }
      setInputValue('');
      setSelectedFiles([]);
      setUploadedFiles([]);
      setShowSlashPalette(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } else {
      // Surface send failure
      useUIStore.getState().addToast({
        type: 'error',
        message: 'Failed to send message. Check your connection and try again.',
      });
    }
  }, [inputValue, uploadedFiles, disabled, isStreaming, currentSessionId, onSend]);

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
      useDraftStore.getState().setDraft(currentSessionId, newValue);
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
    setSelectedFiles(prev => [...prev, ...files]);
    // Upload each file immediately
    files.forEach((file) => {
      const uploadEntry: UploadedFile = { file, serverPath: '', uploading: true };
      setUploadedFiles(prev => [...prev, uploadEntry]);

      uploadFile(file)
        .then((result) => {
          setUploadedFiles(prev =>
            prev.map(u => (u.file === file && u.uploading) ? { ...u, serverPath: result.path, uploading: false } : u)
          );
        })
        .catch((err) => {
          setUploadedFiles(prev =>
            prev.map(u => (u.file === file && u.uploading) ? { ...u, uploading: false, error: err.message || 'Upload failed' } : u)
          );
        });
    });
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const hasUploads = uploadedFiles.some(f => f.serverPath && !f.uploading);
  const isAnyUploading = uploadedFiles.some(f => f.uploading);
  const canSend = (inputValue.trim().length > 0 || hasUploads) && !disabled && !isStreaming && !isAnyUploading;

  return (
    <div className="relative">
      {/* Slash palette */}
      {showSlashPalette && (
        <SlashPalette
          filter={inputValue}
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
        <div className="flex items-center gap-1.5">
          {isClaudeSession && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20 cursor-help"
              title="Claude Direct - Claude Code CLI"
            >
              CC
            </span>
          )}
          {isClaudeSession && quotaInfo?.isUsingOverage && (
            <span className="text-xs text-amber-400" title="Using extra quota (overage)">⚠ Extra</span>
          )}
          {contextPercent > 0 && !isClaudeSession && (
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
                    onClick={() => handleRemoveFile(index)}
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
          value={inputValue}
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
                onClick={() => setShowThinking(prev => !prev)}
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
              onClick={onCancel}
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
}, (prev, next) => {
  return prev.disabled === next.disabled
    && prev.isStreaming === next.isStreaming
    && prev.isCompacting === next.isCompacting
    && prev.currentModel === next.currentModel
    && prev.contextPercent === next.contextPercent
    && prev.currentSessionId === next.currentSessionId
    && prev.onSend === next.onSend
    && prev.onCancel === next.onCancel;
});
