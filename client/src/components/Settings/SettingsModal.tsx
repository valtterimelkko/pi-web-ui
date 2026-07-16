import { X, Settings2, AlertCircle, RefreshCw, Info, Lock } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionStore } from '../../store';
import { ModelSelector, type Model } from './ModelSelector';
import { ALL_THINKING_LEVELS, ThinkingLevelSelector, type ThinkingLevel } from './ThinkingLevelSelector';

const LEGACY_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh',
];
const CLAUDE_MAX_THINKING_ALIASES = new Set(['sonnet', 'opus']);

// A Claude provider-profile model entry, as returned by GET /api/models?sdkType=claude.
interface ClaudeProfileEntry {
  id: string;            // 'profile:<id>' for profile entries, or a bare alias
  displayName: string;
  provider: string;
  backend?: string;
  claudeModel?: string;
}

// Backend labels mirror the NewSessionModal structured selector.
const CLAUDE_BACKEND_LABEL: Record<string, string> = {
  'sdk-subscription': 'SDK',
  'cli-direct': 'CLI direct',
  'channel': 'Channel',
};

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
  const isAntigravitySession = useMemo(() => currentSessionSdkType === 'antigravity', [currentSessionSdkType]);

  // Profile entries for the locked Claude model panel (best-effort fetch).
  const [claudeProfiles, setClaudeProfiles] = useState<ClaudeProfileEntry[]>([]);

  // Human-readable label for the locked Claude model panel. Resolves the active
  // session model to its profile displayName + backend when possible, otherwise
  // humanizes whatever model string the server reported.
  const lockedModelLabel = useMemo(() => {
    if (!isClaudeSession) return '';
    const model = storeCurrentModel || '';
    const byId = claudeProfiles.find((p) => p.id === model);
    if (byId) {
      const be = byId.backend && CLAUDE_BACKEND_LABEL[byId.backend];
      return be ? `${byId.displayName} · ${be}` : byId.displayName;
    }
    if (!model) return 'Claude (fixed)';
    const parts = model.replace(/^profile:/, '').split('/');
    const tail = parts[parts.length - 1] ?? model;
    return tail
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }, [isClaudeSession, storeCurrentModel, claudeProfiles]);

  // Fetch models on mount (or use Claude models for Claude sessions)
  useEffect(() => {
    if (!isOpen) return;

    // Reset loading state when modal opens
    setIsLoading(true);
    setError(null);

    const fetchModels = async () => {
      try {
        // Claude sessions lock the model at creation time — there is no
        // interactive selector here. Best-effort fetch of the profile entries so
        // the locked panel can show a clean provider/backend/model label.
        if (isClaudeSession) {
          setModels([]);
          setCurrentModel(storeCurrentModel || '');
          try {
            const resp = await api.get('/api/models?sdkType=claude') as { models?: ClaudeProfileEntry[] };
            const entries = (resp.models || []).filter((m) => m.id.startsWith('profile:'));
            setClaudeProfiles(entries);
          } catch {
            // Non-fatal: the locked panel falls back to a humanized model string.
          }
          setIsLoading(false);
          return;
        }
        
        // Add a timeout to prevent infinite loading (10 seconds)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), 10000);
        });

        const sdkTypeParam = isOpenCodeSession ? 'opencode' : isAntigravitySession ? 'antigravity' : 'pi';
        const response = await Promise.race([
          api.get(`/api/models?sdkType=${sdkTypeParam}`) as Promise<{ models: Model[] }>,
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
  }, [isOpen, isClaudeSession, isOpenCodeSession, isAntigravitySession, storeCurrentModel]); // Depend on runtime and current model

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

  const availableThinkingLevels = useMemo<readonly ThinkingLevel[]>(() => {
    // Claude Code's current SDK and direct CLI both accept `--effort max`, but
    // the selected model still matters. Claude profiles deliberately avoid a
    // runtime probe; native Sonnet/Opus and Z.ai profiles are known to support
    // max, while Haiku stays on the legacy ceiling.
    if (isClaudeSession) {
      const selectedSessionModel = storeCurrentModel ?? '';
      const profile = claudeProfiles.find((entry) => entry.id === selectedSessionModel);
      const model = profile?.claudeModel ?? (selectedSessionModel.startsWith('profile:') ? undefined : selectedSessionModel);
      if (profile?.provider === 'zai' || (model && CLAUDE_MAX_THINKING_ALIASES.has(model))) {
        return ALL_THINKING_LEVELS;
      }
      return LEGACY_THINKING_LEVELS;
    }
    if (isOpenCodeSession || isAntigravitySession) return LEGACY_THINKING_LEVELS;

    const selectedModel = models.find(
      (model) => `${model.provider}/${model.id}` === currentModel,
    );
    return selectedModel?.thinkingLevels ?? LEGACY_THINKING_LEVELS;
  }, [claudeProfiles, currentModel, isAntigravitySession, isClaudeSession, isOpenCodeSession, models, storeCurrentModel]);

  useEffect(() => {
    if (isLoading) return;
    if (!availableThinkingLevels.includes(thinkingLevel)) {
      setThinkingLevel(availableThinkingLevels.at(-1) ?? 'off');
    }
  }, [availableThinkingLevels, isLoading, thinkingLevel]);

  const handleSave = () => {
    // Claude sessions lock the model at creation: never send a mid-session model
    // change (a bare alias would silently re-route provider/backend). Only the
    // thinking level is user-tunable for an existing Claude session.
    if (!isClaudeSession && !currentModel) {
      onClose();
      return;
    }
    setIsSaving(true);
    setError(null);
    if (!isClaudeSession) {
      setModel(currentModel);
    }
    sendThinkingLevel(thinkingLevel);

    setTimeout(() => {
      setIsSaving(false);
      if (!error) {
        onClose();
      }
    }, 1000);
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
              {isAntigravitySession && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700 border border-violet-200">
                  Antigravity
                </span>
              )}
            </h3>
            {isOpenCodeSession && (
              <div className="mb-3 flex items-start gap-2 text-xs text-gray-500 bg-gray-50 p-2 rounded">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>OpenCode Direct sessions use OpenCode-backed Z.AI Coding Plan models.</span>
              </div>
            )}
            {isAntigravitySession && (
              <div className="mb-3 flex items-start gap-2 text-xs text-gray-500 bg-gray-50 p-2 rounded">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Antigravity sessions use Google Gemini models via the agy CLI.</span>
              </div>
            )}
            {isClaudeSession ? (
              <div data-testid="claude-model-locked">
                <div className="w-full flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded flex items-center justify-center bg-amber-50">
                      <Lock className="w-4 h-4 text-amber-600" />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-medium text-gray-900" data-testid="claude-model-locked-label">{lockedModelLabel}</p>
                      <p className="text-xs text-gray-500">Fixed for this session</p>
                    </div>
                  </div>
                  <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">Locked</span>
                </div>
                <p className="mt-2 flex items-start gap-2 text-xs text-gray-500" data-testid="claude-model-locked-note">
                  <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Provider, backend, and model are chosen when a Claude session is created. Start a new session to change them.</span>
                </p>
              </div>
            ) : isLoading ? (
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
                            const sdkTypeParam = isOpenCodeSession ? 'opencode' : isAntigravitySession ? 'antigravity' : 'pi';
                            const response = await Promise.race([
                              api.get(`/api/models?sdkType=${sdkTypeParam}`) as Promise<{ models: Model[] }>,
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
              availableLevels={availableThinkingLevels}
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
            disabled={isSaving || (!isClaudeSession && !currentModel)}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
