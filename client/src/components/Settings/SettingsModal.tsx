import { X, Settings2, AlertCircle, RefreshCw, Info } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionStore } from '../../store';
import { ModelSelector, type Model } from './ModelSelector';
import { ThinkingLevelSelector, type ThinkingLevel } from './ThinkingLevelSelector';

// Claude models for Claude Direct sessions
const CLAUDE_MODELS: Model[] = [
  { id: 'opus', name: 'Claude Opus', provider: 'anthropic', contextWindow: 200000, maxTokens: 64000, description: 'Most powerful Claude model for complex tasks' },
  { id: 'sonnet', name: 'Claude Sonnet', provider: 'anthropic', contextWindow: 200000, maxTokens: 64000, description: 'Balanced performance and speed' },
  { id: 'haiku', name: 'Claude Haiku', provider: 'anthropic', contextWindow: 200000, maxTokens: 64000, description: 'Fastest Claude model for simple tasks' },
];

function normalizeClaudeModelId(modelId: string | null): 'opus' | 'sonnet' | 'haiku' | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet') || lower.includes('default')) return 'sonnet';
  return null;
}

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
  const { setModel, setThinkingLevel: sendThinkingLevel } = useWebSocket();
  const storeCurrentModel = useSessionStore((state) => state.currentModel);
  const storeCurrentThinkingLevel = useSessionStore((state) => state.currentThinkingLevel);
  const errorMessage = useSessionStore((state) => state.error);
  const currentSessionSdkType = useSessionStore((state) => state.currentSessionSdkType);
  
  // Runtime-specific model handling
  const isClaudeSession = useMemo(() => currentSessionSdkType === 'claude', [currentSessionSdkType]);
  const isOpenCodeSession = useMemo(() => currentSessionSdkType === 'opencode', [currentSessionSdkType]);

  // Fetch models on mount (or use Claude models for Claude sessions)
  useEffect(() => {
    if (!isOpen) return;

    // Reset loading state when modal opens
    setIsLoading(true);
    setError(null);

    const fetchModels = async () => {
      try {
        // For Claude sessions, use hardcoded Claude models
        if (isClaudeSession) {
          setModels(CLAUDE_MODELS);
          // Default to sonnet if no model selected, or normalize any prior Claude model id
          const normalizedCurrent = normalizeClaudeModelId(storeCurrentModel);
          const validModel = CLAUDE_MODELS.find(m => m.id === normalizedCurrent);
          setCurrentModel(validModel?.id || 'sonnet');
          setIsLoading(false);
          return;
        }
        
        // Add a timeout to prevent infinite loading (10 seconds)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), 10000);
        });
        
        const response = await Promise.race([
          api.get(`/api/models?sdkType=${isOpenCodeSession ? 'opencode' : 'pi'}`) as Promise<{ models: Model[] }>,
          timeoutPromise
        ]);
        
        const modelList = response.models || [];
        setModels(modelList);
        const initialModel = storeCurrentModel || (modelList[0]?.id ?? '');
        setCurrentModel(initialModel);
      } catch (error) {
        console.error('Failed to fetch models:', error);
        setError(error instanceof Error ? error.message : 'Failed to load models');
      } finally {
        setIsLoading(false);
      }
    };

    fetchModels();
  }, [isOpen, isClaudeSession, isOpenCodeSession, storeCurrentModel]); // Depend on runtime and current model

  // Update current model when storeCurrentModel changes (separate from fetch)
  useEffect(() => {
    if (storeCurrentModel && !currentModel) {
      setCurrentModel(storeCurrentModel);
    }
  }, [storeCurrentModel, currentModel]);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      if (storeCurrentThinkingLevel) {
        setThinkingLevel(storeCurrentThinkingLevel as ThinkingLevel);
      }
    }
  }, [isOpen, storeCurrentThinkingLevel]);

  useEffect(() => {
    if (errorMessage && isOpen) {
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
      sendThinkingLevel(thinkingLevel);

      setTimeout(() => {
        setIsSaving(false);
        if (!error) {
          onClose();
        }
      }, 1000);
    } else {
      onClose();
    }
  };

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" data-testid="settings-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Settings2 className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2" data-testid="model-error">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-700 font-medium">Failed to change model</p>
                <p className="text-xs text-red-600">{error}</p>
              </div>
            </div>
          )}

          {/* Model Selection */}
          <section>
            <h3 className="text-sm font-medium text-gray-500 mb-3">
              Model
              {isClaudeSession && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 border border-amber-200">
                  Claude Direct
                </span>
              )}
              {isOpenCodeSession && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-200">
                  OpenCode Direct
                </span>
              )}
            </h3>
            {isClaudeSession && (
              <div className="mb-3 flex items-start gap-2 text-xs text-gray-500 bg-gray-50 p-2 rounded">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Claude Direct sessions only support Claude models (Opus, Sonnet, Haiku).</span>
              </div>
            )}
            {isOpenCodeSession && (
              <div className="mb-3 flex items-start gap-2 text-xs text-gray-500 bg-gray-50 p-2 rounded">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>OpenCode Direct sessions use OpenCode-backed Z.AI Coding Plan models.</span>
              </div>
            )}
            {isLoading ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading models...
              </div>
            ) : error && models.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-red-500 text-sm mb-3">{error}</p>
                <button
                  onClick={() => {
                    setIsLoading(true);
                    setError(null);
                    // Re-trigger the effect by toggling isOpen temporarily
                    const wasOpen = isOpen;
                    if (wasOpen) {
                      // Force refetch by resetting state
                      setTimeout(() => {
                        const fetchModels = async () => {
                          try {
                            const timeoutPromise = new Promise<never>((_, reject) => {
                              setTimeout(() => reject(new Error('Request timeout')), 10000);
                            });
                            const response = await Promise.race([
                              api.get(`/api/models?sdkType=${isOpenCodeSession ? 'opencode' : 'pi'}`) as Promise<{ models: Model[] }>,
                              timeoutPromise
                            ]);
                            const modelList = response.models || [];
                            setModels(modelList);
                            const initialModel = storeCurrentModel || (modelList[0]?.id ?? '');
                            setCurrentModel(initialModel);
                          } catch (err) {
                            console.error('Failed to fetch models:', err);
                            setError(err instanceof Error ? err.message : 'Failed to load models');
                          } finally {
                            setIsLoading(false);
                          }
                        };
                        fetchModels();
                      }, 0);
                    }
                  }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center gap-2 mx-auto"
                >
                  <RefreshCw className="w-4 h-4" />
                  Retry
                </button>
              </div>
            ) : (
              <ModelSelector
                models={models}
                currentModel={currentModel}
                onSelect={setCurrentModel}
                qualifyWithProvider={!isClaudeSession}
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
              <span className="text-gray-700">Show Thinking Blocks</span>
              <button
                onClick={() => setShowThinking(!showThinking)}
                className={`
                  w-12 h-6 rounded-full transition-colors relative
                  ${showThinking ? 'bg-blue-500' : 'bg-gray-300'}
                `}
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 rounded-full bg-white transition-transform shadow-sm
                    ${showThinking ? 'left-7' : 'left-1'}
                  `}
                />
              </button>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !currentModel}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
