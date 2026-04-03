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
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCompact}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm rounded-lg transition-colors"
          >
            Compact
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Compaction summarizes the conversation to free up context window.
          This helps maintain performance in long conversations.
        </p>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Custom Instructions (optional)
          </label>
          <textarea
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="e.g., Focus on preserving technical details about the API implementation..."
            rows={3}
            className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 placeholder-gray-400 text-sm resize-none focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
          <p className="mt-1 text-xs text-gray-400">
            Leave empty to use default summarization behavior.
          </p>
        </div>
      </div>
    </Modal>
  );
}
