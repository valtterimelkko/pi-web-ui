import { X, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { ModelSelector, type Model } from './ModelSelector';
import { ThinkingLevelSelector, type ThinkingLevel } from './ThinkingLevelSelector';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Mock models - in production, fetch from /api/models
const mockModels: Model[] = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'Anthropic', contextWindow: 200000, maxTokens: 4096 },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', provider: 'Anthropic', contextWindow: 200000, maxTokens: 4096 },
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI', contextWindow: 128000, maxTokens: 4096 },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [currentModel, setCurrentModel] = useState(mockModels[0].id);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [showThinking, setShowThinking] = useState(true);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
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
          {/* Model Selection */}
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">Model</h3>
            <ModelSelector
              models={mockModels}
              currentModel={currentModel}
              onSelect={setCurrentModel}
            />
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
            className="px-4 py-2 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
