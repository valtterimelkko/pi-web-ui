import { useRef, useState, useCallback } from 'react';
import { Send, Paperclip, X } from 'lucide-react';
import { useChatStore, useSessionStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { CompactModal } from './CompactModal';

interface MessageInputProps {
  disabled?: boolean;
}

export function MessageInput({ disabled }: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const inputValue = useChatStore((state) => state.inputValue);
  const selectedFiles = useChatStore((state) => state.selectedFiles);
  const isDragging = useChatStore((state) => state.isDragging);
  const setInputValue = useChatStore((state) => state.setInputValue);
  const addFiles = useChatStore((state) => state.addFiles);
  const removeFile = useChatStore((state) => state.removeFile);
  const clearFiles = useChatStore((state) => state.clearFiles);
  const setIsDragging = useChatStore((state) => state.setIsDragging);
  
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const { sendPrompt } = useWebSocket();
  
  const [isFocused, setIsFocused] = useState(false);
  const [showCompactModal, setShowCompactModal] = useState(false);

  // Auto-resize textarea
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    adjustTextareaHeight();
  };

  const handleSend = useCallback(() => {
    const message = inputValue.trim();
    if (!message || disabled || isStreaming) return;

    // Handle slash commands
    if (message === '/compact') {
      setShowCompactModal(true);
      setInputValue('');
      clearFiles();
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }

    // TODO: Handle file uploads (convert to base64 images)
    const images: unknown[] = [];
    
    sendPrompt(message, images);
    setInputValue('');
    clearFiles();
    
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [inputValue, disabled, isStreaming, sendPrompt, setInputValue, clearFiles]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      // Allow Shift+Enter for new line, otherwise send
      if (!e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
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
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const canSend = inputValue.trim().length > 0 && !disabled && !isStreaming;

  return (
    <div
      className={`relative rounded-2xl border transition-all duration-200 ${
        isDragging
          ? 'border-violet-500 bg-violet-500/10'
          : isFocused
          ? 'border-violet-500/50 bg-slate-800'
          : 'border-slate-700 bg-slate-800/50'
      } ${disabled ? 'opacity-50' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* File attachments preview */}
      {selectedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-700">
          {selectedFiles.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 rounded-lg text-sm text-slate-300"
            >
              <Paperclip className="w-3.5 h-3.5 text-slate-400" />
              <span className="max-w-[150px] truncate">{file.name}</span>
              <button
                onClick={() => removeFile(index)}
                className="p-0.5 hover:bg-slate-600 rounded transition-colors"
                type="button"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Textarea */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={disabled ? 'Select a session to start chatting...' : 'Type a message... (Ctrl+Enter to send)'}
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent px-4 py-3.5 pr-24 text-slate-100 placeholder-slate-500 resize-none outline-none min-h-[56px] max-h-[200px]"
          style={{ lineHeight: '1.5' }}
        />

        {/* Actions */}
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {/* File attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors"
            type="button"
            title="Attach files"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`p-2 rounded-lg transition-all ${
              canSend
                ? 'bg-violet-600 text-white hover:bg-violet-500 shadow-lg shadow-violet-600/20'
                : 'bg-slate-700 text-slate-500 cursor-not-allowed'
            }`}
            type="button"
            title="Send message"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-violet-500/10 border-2 border-dashed border-violet-500 rounded-2xl flex items-center justify-center">
          <div className="text-violet-400 font-medium">Drop files here</div>
        </div>
      )}

      {/* Compact Modal */}
      <CompactModal isOpen={showCompactModal} onClose={() => setShowCompactModal(false)} />
    </div>
  );
}
