import { useState, useMemo } from 'react';
import { Search, Check, ChevronDown, Github, Sparkles, Cpu, Brain, Zap } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  description?: string;
}

interface ModelSelectorProps {
  models: Model[];
  currentModel: string;
  onSelect: (modelId: string) => void;
}

// Provider icons and colors for visual distinction
const providerStyles: Record<string, { icon: typeof Github; color: string; bgColor: string; label: string }> = {
  'github-copilot': {
    icon: Github,
    color: 'text-purple-400',
    bgColor: 'bg-purple-600/20',
    label: 'GitHub Copilot',
  },
  'kimi': {
    icon: Sparkles,
    color: 'text-orange-400',
    bgColor: 'bg-orange-600/20',
    label: 'Kimi',
  },
  'openai': {
    icon: Brain,
    color: 'text-green-400',
    bgColor: 'bg-green-600/20',
    label: 'OpenAI',
  },
  'google': {
    icon: Zap,
    color: 'text-blue-400',
    bgColor: 'bg-blue-600/20',
    label: 'Google',
  },
  'xai': {
    icon: Cpu,
    color: 'text-red-400',
    bgColor: 'bg-red-600/20',
    label: 'xAI',
  },
  'default': {
    icon: Cpu,
    color: 'text-slate-400',
    bgColor: 'bg-slate-600/20',
    label: 'Other',
  },
};

function getProviderStyle(provider: string) {
  const key = provider.toLowerCase();
  if (key.includes('github') || key.includes('copilot')) return providerStyles['github-copilot'];
  if (key.includes('kimi')) return providerStyles['kimi'];
  if (key.includes('openai') || key.includes('gpt')) return providerStyles['openai'];
  if (key.includes('google') || key.includes('gemini')) return providerStyles['google'];
  if (key.includes('xai') || key.includes('grok')) return providerStyles['xai'];
  return providerStyles['default'];
}

// Format model name for display (remove provider prefix, capitalize)
function formatModelName(modelId: string): string {
  // Remove provider prefix (e.g., "github-copilot/gpt-5.4" -> "gpt-5.4")
  const parts = modelId.split('/');
  const name = parts.length > 1 ? parts.slice(1).join('/') : modelId;
  
  // Capitalize and format
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Scoring constants for search relevance
const SCORE_EXACT_MATCH = 3;
const SCORE_STARTS_WITH = 2;
const SCORE_INCLUDES = 1;

interface ScoredModel extends Model {
  score: number;
}

// Highlight matched text in search results
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) {
    return <>{text}</>;
  }

  const normalizedQuery = query.toLowerCase();
  const normalizedText = text.toLowerCase();
  const parts: Array<{ text: string; isMatch: boolean }> = [];
  
  let lastIndex = 0;
  let index = normalizedText.indexOf(normalizedQuery);
  
  while (index !== -1) {
    // Add text before match
    if (index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, index), isMatch: false });
    }
    // Add matched text
    parts.push({ text: text.slice(index, index + query.length), isMatch: true });
    lastIndex = index + query.length;
    index = normalizedText.indexOf(normalizedQuery, lastIndex);
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return (
    <>
      {parts.map((part, i) => (
        part.isMatch ? (
          <mark key={i} className="bg-violet-500/30 text-violet-200 rounded px-0.5">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      ))}
    </>
  );
}

export function ModelSelector({ models, currentModel, onSelect }: ModelSelectorProps) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  // Smart filtering with scoring and sorting by relevance
  const filteredModels = useMemo(() => {
    const query = search.toLowerCase().trim();
    
    if (!query) {
      // No search query, return all models with score 0 (will be grouped by provider)
      return models.map(m => ({ ...m, score: 0 }));
    }

    const scoredModels: ScoredModel[] = [];

    for (const model of models) {
      const nameLower = model.name.toLowerCase();
      const providerLower = model.provider.toLowerCase();
      let score = 0;

      // Check name matches
      if (nameLower === query) {
        score += SCORE_EXACT_MATCH;
      } else if (nameLower.startsWith(query)) {
        score += SCORE_STARTS_WITH;
      } else if (nameLower.includes(query)) {
        score += SCORE_INCLUDES;
      }

      // Check provider matches (add to existing score)
      if (providerLower === query) {
        score += SCORE_EXACT_MATCH;
      } else if (providerLower.startsWith(query)) {
        score += SCORE_STARTS_WITH;
      } else if (providerLower.includes(query)) {
        score += SCORE_INCLUDES;
      }

      // Only include models with at least one match
      if (score > 0) {
        scoredModels.push({ ...model, score });
      }
    }

    // Sort by score descending (highest relevance first)
    return scoredModels.sort((a, b) => b.score - a.score);
  }, [models, search]);

  // Group models by provider when there's no search, or show flat list when searching
  const groupedModels = useMemo(() => {
    const groups: Record<string, Model[]> = {};
    for (const model of filteredModels) {
      if (!groups[model.provider]) groups[model.provider] = [];
      groups[model.provider].push(model);
    }
    return groups;
  }, [filteredModels]);

  const selectedModel = models.find((m) => m.id === currentModel);
  const selectedProviderStyle = selectedModel ? getProviderStyle(selectedModel.provider) : providerStyles['default'];
  const SelectedIcon = selectedProviderStyle.icon;

  const handleSelect = (modelId: string) => {
    if (modelId !== currentModel) {
      onSelect(modelId);
      const model = models.find((m) => m.id === modelId);
      const modelName = model?.name || formatModelName(modelId);
      useUIStore.getState().addToast({
        type: 'success',
        message: `Model changed to ${modelName}`,
      });
    }
    setIsOpen(false);
    setSearch('');
  };

  // When searching, show results as a flat list sorted by relevance
  // When not searching, group by provider
  const hasSearchQuery = search.trim().length > 0;

  return (
    <div className="relative" data-testid="model-selector">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
        data-testid="model-selector-trigger"
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded flex items-center justify-center ${selectedProviderStyle.bgColor}`}>
            <SelectedIcon className={`w-4 h-4 ${selectedProviderStyle.color}`} />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-slate-200">
              {selectedModel?.name || 'Select Model'}
            </p>
            <p className="text-xs text-slate-400">
              {selectedModel?.provider || 'Choose a model'}
            </p>
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 rounded-lg border border-slate-700 shadow-xl z-50 max-h-96 overflow-hidden flex flex-col" data-testid="model-selector-dropdown">
          <div className="p-3 border-b border-slate-700">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models..."
                className="w-full pl-9 pr-3 py-2 bg-slate-900 rounded text-sm text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-600"
                autoFocus
                data-testid="model-selector-search"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {hasSearchQuery ? (
              // Flat list when searching, sorted by relevance
              filteredModels.map((model) => {
                const providerStyle = getProviderStyle(model.provider);
                const ProviderIcon = providerStyle.icon;
                
                return (
                  <button
                    key={model.id}
                    onClick={() => handleSelect(model.id)}
                    className={`
                      w-full px-3 py-2.5 flex items-center gap-3 hover:bg-slate-700 transition-colors
                      ${currentModel === model.id ? 'bg-violet-600/20' : ''}
                    `}
                    data-testid="model-option"
                  >
                    <div className={`w-6 h-6 rounded flex items-center justify-center ${providerStyle.bgColor}`}>
                      <ProviderIcon className={`w-3 h-3 ${providerStyle.color}`} />
                    </div>
                    <div className="flex-1 text-left">
                      <p className="text-sm text-slate-200">
                        <HighlightedText text={model.name} query={search} />
                      </p>
                      <p className="text-xs text-slate-400">
                        <HighlightedText text={model.provider} query={search} />
                        {' · '}
                        {model.contextWindow.toLocaleString()} context
                        {model.description && ` · ${model.description}`}
                      </p>
                    </div>
                    {currentModel === model.id && (
                      <Check className="w-4 h-4 text-violet-400" />
                    )}
                  </button>
                );
              })
            ) : (
              // Grouped by provider when not searching
              Object.entries(groupedModels).map(([provider, providerModels]) => {
                const providerStyle = getProviderStyle(provider);
                const ProviderIcon = providerStyle.icon;
                
                return (
                  <div key={provider}>
                    <div className={`px-3 py-2 text-xs font-medium uppercase bg-slate-900/50 flex items-center gap-2 ${providerStyle.color}`} data-testid="provider-header">
                      <ProviderIcon className="w-3 h-3" />
                      {provider}
                    </div>
                    {providerModels.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => handleSelect(model.id)}
                        className={`
                          w-full px-3 py-2.5 flex items-center gap-3 hover:bg-slate-700 transition-colors
                          ${currentModel === model.id ? 'bg-violet-600/20' : ''}
                        `}
                      >
                        <div className="flex-1 text-left">
                          <p className="text-sm text-slate-200">{model.name}</p>
                          <p className="text-xs text-slate-400">
                            {model.contextWindow.toLocaleString()} context
                            {model.description && ` · ${model.description}`}
                          </p>
                        </div>
                        {currentModel === model.id && (
                          <Check className="w-4 h-4 text-violet-400" />
                        )}
                      </button>
                    ))}
                  </div>
                );
              })
            )}
            
            {filteredModels.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-slate-400">
                No models found matching &quot;{search}&quot;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
