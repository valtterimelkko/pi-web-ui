import { X, Settings2, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionStore, useUIStore } from '../../store';
import { ModelSelector, type Model } from './ModelSelector';
import { ThinkingLevelSelector, type ThinkingLevel } from './ThinkingLevelSelector';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [showThinking, setShowThinking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { setModel } = useWebSocket();
  const storeCurrentModel = useSessionStore((state) => state.currentModel);
  const errorMessage = useSessionStore((state) => state.error);

  // Fetch models on mount
  useEffect(() => {
    if (!isOpen) return;

    const fetchModels = async () => {
      try {
        const response = await api.get('/api/models') as { models: Model[] };
        const modelList = response.models || [];
        setModels(modelList);
        // Set current model from store or default to first model
        const initialModel = storeCurrentModel || (modelList[0]?.id ?? '');
        setCurrentModel(initialModel);
      } catch (error) {
        console.error('Failed to fetch models:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchModels();
  }, [isOpen, storeCurrentModel]);

  // Clear error when modal opens
  useEffect(() => {
    if (isOpen) {
      setError(null);
    }
  }, [isOpen]);

  // Listen for error messages from the store (WebSocket errors)
  useEffect(() => {
    if (errorMessage && isOpen) {
      // Check if this is a model-related error
      if (errorMessage.includes('model') || errorMessage.includes('Model')) {
        setError(errorMessage);
        setIsSaving(false);
      }
    }
  }, [errorMessage, isOpen]);

  const handleSave = () => {
    if (currentModel) {
      setIsSaving(true);
      setError(null);
      setModel(currentModel);
      
      // Wait a bit for the WebSocket response
      setTimeout(() => {
        setIsSaving(false);
        // Only close if no error occurred
        if (!error) {
          onClose();
        }
      }, 1000);
    } else {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-testid="settings-modal">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <Settings2 className="w-6 h-6 text-violet-400" />
            <h2 className="text-xl font-semibold text-slate-100">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 flex items-start gap-2" data-testid="model-error">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-200 font-medium">Failed to change model</p>
                <p className="text-xs text-red-300">{error}</p>
              </div>
            </div>
          )}

          {/* Model Selection */}
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">Model</h3>
            {isLoading ? (
              <div className="text-slate-400 text-sm">Loading models...</div>
            ) : (
              <ModelSelector
                models={models}
                currentModel={currentModel}
                onSelect={setCurrentModel}
              />
            )}
          </section>

          {/* Thinking Level */}
          <section>
            <ThinkingLevelSelector
              value={thinkingLevel}
              onChange={setThinkingLevel}
            />
          </section>

          {/* Toggle Options */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-slate-300">Show Thinking Blocks</span>
              <button
                onClick={() => setShowThinking(!showThinking)}
                className={`
                  w-12 h-6 rounded-full transition-colors relative
                  ${showThinking ? 'bg-violet-600' : 'bg-slate-700'}
                `}
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 rounded-full bg-white transition-transform
                    ${showThinking ? 'left-7' : 'left-1'}
                  `}
                />
              </button>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-slate-800">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !currentModel}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
