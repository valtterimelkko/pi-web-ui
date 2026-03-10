import { useState } from 'react';
import { Modal } from '../common/Modal';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useUIStore } from '../../store';

interface CompactModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CompactModal({ isOpen, onClose }: CompactModalProps) {
  const [customInstructions, setCustomInstructions] = useState('');
  const { sendCompact } = useWebSocket();
  const addToast = useUIStore((state) => state.addToast);

  const handleCompact = () => {
    const instructions = customInstructions.trim() || undefined;
    const success = sendCompact(instructions);
    
    if (success) {
      addToast({
        type: 'info',
        message: 'Compacting conversation context...',
      });
    } else {
      addToast({
        type: 'error',
        message: 'Failed to start compaction. No active session?',
      });
    }
    
    setCustomInstructions('');
    onClose();
  };

  const handleClose = () => {
    setCustomInstructions('');
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Compact Conversation"
      footer={
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm text-slate-300 hover:text-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCompact}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-lg transition-colors"
          >
            Compact
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          Compaction summarizes the conversation to free up context window.
          This helps maintain performance in long conversations.
        </p>
        
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Custom Instructions (optional)
          </label>
          <textarea
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="e.g., Focus on preserving technical details about the API implementation..."
            rows={3}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 text-sm resize-none focus:outline-none focus:border-violet-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave empty to use default summarization behavior.
          </p>
        </div>
      </div>
    </Modal>
  );
}
