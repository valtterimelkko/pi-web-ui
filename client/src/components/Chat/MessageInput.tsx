import { useRef, useState, useCallback, useEffect } from 'react';
import { Send, Paperclip, X, Settings2, ArrowUpRight } from 'lucide-react';
import { useChatStore, useSessionStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { CompactModal } from './CompactModal';
import { SlashPalette } from './SlashPalette';

interface MessageInputProps {
  disabled?: boolean;
  onOpenSettings?: () => void;
}

export function MessageInput({ disabled, onOpenSettings }: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const inputValue = useChatStore((state) => state.inputValue);
  const selectedFiles = useChatStore((state) => state.selectedFiles);
  const isDragging = useChatStore((state) => state.isDragging);
  const showThinking = useChatStore((state) => state.showThinking);
  const toggleThinking = useChatStore((state) => state.toggleThinking);
  const setInputValue = useChatStore((state) => state.setInputValue);
  const addFiles = useChatStore((state) => state.addFiles);
  const removeFile = useChatStore((state) => state.removeFile);
  const clearFiles = useChatStore((state) => state.clearFiles);
  const setIsDragging = useChatStore((state) => state.setIsDragging);

  const isStreaming = useSessionStore((state) => state.isStreaming);
  const currentModel = useSessionStore((state) => state.currentModel);
  const contextPercent = useSessionStore((state) => state.contextPercent);
  const { sendPrompt } = useWebSocket();

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
    setInputValue(value);
    adjustTextareaHeight();

    // Show slash palette when input starts with /
    if (value.startsWith('/') && value.length <= 20) {
      setShowSlashPalette(true);
    } else {
      setShowSlashPalette(false);
    }
  };

  const handleSend = useCallback(() => {
    const message = inputValue.trim();
    if (!message || disabled || isStreaming) return;

    // Handle slash commands
    if (message === '/compact') {
      setShowCompactModal(true);
      setInputValue('');
      clearFiles();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }

    const images: unknown[] = [];

    sendPrompt(message, images);
    setInputValue('');
    clearFiles();
    setShowSlashPalette(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [inputValue, disabled, isStreaming, sendPrompt, setInputValue, clearFiles]);

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
    setInputValue(command + ' ');
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
      addFiles(files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      addFiles(files);
    }
    e.target.value = '';
  };

  const canSend = inputValue.trim().length > 0 && !disabled && !isStreaming;

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
          <span className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
          <span className="text-gray-500">
            {isStreaming ? 'Thinking...' : 'Awaiting input'}
          </span>
        </div>
        {contextPercent > 0 && (
          <span className="text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full text-[11px]">
            {contextPercent}% context
          </span>
        )}
      </div>

      {/* Main composer */}
      <div
        className={`relative rounded-xl border transition-all duration-200 ${
          isDragging
            ? 'border-teal-500 bg-teal-50'
            : isFocused
            ? 'border-teal-500 bg-white'
            : 'border-gray-200 bg-white'
        } ${disabled ? 'opacity-50' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* File attachments preview */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 border-b border-gray-200">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg text-sm text-gray-600"
              >
                <Paperclip className="w-3.5 h-3.5 text-gray-400" />
                <span className="max-w-[150px] truncate">{file.name}</span>
                <button
                  onClick={() => removeFile(index)}
                  className="p-0.5 hover:bg-gray-200 rounded transition-colors"
                  type="button"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
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
          placeholder={disabled ? 'Select a session to start chatting...' : 'Ask anything, / for commands, @ to mention files'}
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent px-4 py-3 text-gray-900 placeholder-gray-400 resize-none outline-none min-h-[48px] max-h-[200px]"
          style={{ lineHeight: '1.5' }}
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
              <span>{displayModelName}</span>
            </button>

            {/* Thinking toggle */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">Thinking</span>
              <button
                onClick={toggleThinking}
                className={`w-8 h-4.5 rounded-full transition-colors relative ${
                  showThinking ? 'bg-teal-500' : 'bg-gray-300'
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

          {/* Send button */}
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
        </div>

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 bg-teal-50 border-2 border-dashed border-teal-500 rounded-xl flex items-center justify-center">
            <div className="text-teal-600 font-medium text-sm">Drop files here</div>
          </div>
        )}
      </div>

      {/* Compact Modal */}
      <CompactModal isOpen={showCompactModal} onClose={() => setShowCompactModal(false)} />
    </div>
  );
}
