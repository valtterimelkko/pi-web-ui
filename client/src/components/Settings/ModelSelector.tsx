import { useState, useMemo } from 'react';
import { Search, Check, ChevronDown, Github, Sparkles, Cpu, Brain, Zap, Triangle } from 'lucide-react';

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
  'anthropic': {
    icon: Triangle,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
    label: 'Anthropic',
  },
  'github-copilot': {
    icon: Github,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    label: 'GitHub Copilot',
  },
  'kimi': {
    icon: Sparkles,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
    label: 'Kimi',
  },
  'openai': {
    icon: Brain,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
    label: 'OpenAI',
  },
  'google': {
    icon: Zap,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    label: 'Google',
  },
  'google-antigravity': {
    icon: Sparkles,
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
    label: 'Antigravity',
  },
  'xai': {
    icon: Cpu,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
    label: 'xAI',
  },
  'default': {
    icon: Cpu,
    color: 'text-gray-500',
    bgColor: 'bg-gray-50',
    label: 'Other',
  },
};

function getProviderStyle(provider: string) {
  const key = provider.toLowerCase();
  if (key.includes('antigravity')) return providerStyles['google-antigravity'];
  if (key.includes('anthropic') || key.includes('claude')) return providerStyles['anthropic'];
  if (key.includes('github') || key.includes('copilot')) return providerStyles['github-copilot'];
  if (key.includes('kimi')) return providerStyles['kimi'];
  if (key.includes('openai') || key.includes('gpt')) return providerStyles['openai'];
  if (key.includes('google') || key.includes('gemini')) return providerStyles['google'];
  if (key.includes('xai') || key.includes('grok')) return providerStyles['xai'];
  return providerStyles['default'];
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
    if (index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, index), isMatch: false });
    }
    parts.push({ text: text.slice(index, index + query.length), isMatch: true });
    lastIndex = index + query.length;
    index = normalizedText.indexOf(normalizedQuery, lastIndex);
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return (
    <>
      {parts.map((part, i) => (
        part.isMatch ? (
          <mark key={i} className="bg-teal-100 text-teal-800 rounded px-0.5">
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
      return models.map(m => ({ ...m, score: 0 }));
    }

    const scoredModels: ScoredModel[] = [];

    for (const model of models) {
      const nameLower = model.name.toLowerCase();
      const providerLower = model.provider.toLowerCase();
      let score = 0;

      if (nameLower === query) {
        score += SCORE_EXACT_MATCH;
      } else if (nameLower.startsWith(query)) {
        score += SCORE_STARTS_WITH;
      } else if (nameLower.includes(query)) {
        score += SCORE_INCLUDES;
      }

      if (providerLower === query) {
        score += SCORE_EXACT_MATCH;
      } else if (providerLower.startsWith(query)) {
        score += SCORE_STARTS_WITH;
      } else if (providerLower.includes(query)) {
        score += SCORE_INCLUDES;
      }

      if (score > 0) {
        scoredModels.push({ ...model, score });
      }
    }

    return scoredModels.sort((a, b) => b.score - a.score);
  }, [models, search]);

  // Group models by provider
  const groupedModels = useMemo(() => {
    const groups: Record<string, Model[]> = {};
    for (const model of filteredModels) {
      if (!groups[model.provider]) groups[model.provider] = [];
      groups[model.provider].push(model);
    }
    return groups;
  }, [filteredModels]);

  const selectedModel = currentModel
    ? models.find((m) => `${m.provider}/${m.id}` === currentModel)
    : undefined;
  const selectedProviderStyle = selectedModel ? getProviderStyle(selectedModel.provider) : providerStyles['default'];
  const SelectedIcon = selectedProviderStyle.icon;

  const handleSelect = (modelId: string, provider: string) => {
    const qualifiedModelId = `${provider}/${modelId}`;

    if (qualifiedModelId !== currentModel) {
      onSelect(qualifiedModelId);
    }
    setIsOpen(false);
    setSearch('');
  };

  const hasSearchQuery = search.trim().length > 0;

  return (
    <div className="relative" data-testid="model-selector">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
        data-testid="model-selector-trigger"
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded flex items-center justify-center ${selectedProviderStyle.bgColor}`}>
            <SelectedIcon className={`w-4 h-4 ${selectedProviderStyle.color}`} />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-gray-900">
              {selectedModel?.name || 'Select Model'}
            </p>
            <p className="text-xs text-gray-500">
              {selectedModel?.provider || 'Choose a model'}
            </p>
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-lg border border-gray-200 shadow-xl z-50 max-h-96 overflow-hidden flex flex-col" data-testid="model-selector-dropdown">
          <div className="p-3 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models..."
                className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                autoFocus
                data-testid="model-selector-search"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {hasSearchQuery ? (
              filteredModels.map((model) => {
                const providerStyle = getProviderStyle(model.provider);
                const ProviderIcon = providerStyle.icon;

                return (
                  <button
                    key={`${model.provider}/${model.id}`}
                    onClick={() => handleSelect(model.id, model.provider)}
                    className={`
                      w-full px-3 py-2.5 flex items-center gap-3 hover:bg-gray-50 transition-colors
                      ${currentModel === `${model.provider}/${model.id}` ? 'bg-teal-50' : ''}
                    `}
                    data-testid="model-option"
                  >
                    <div className={`w-6 h-6 rounded flex items-center justify-center ${providerStyle.bgColor}`}>
                      <ProviderIcon className={`w-3 h-3 ${providerStyle.color}`} />
                    </div>
                    <div className="flex-1 text-left">
                      <p className="text-sm text-gray-900">
                        <HighlightedText text={model.name} query={search} />
                      </p>
                      <p className="text-xs text-gray-500">
                        <HighlightedText text={model.provider} query={search} />
                        {' · '}
                        {model.contextWindow.toLocaleString()} context
                        {model.description && ` · ${model.description}`}
                      </p>
                    </div>
                    {currentModel === `${model.provider}/${model.id}` && (
                      <Check className="w-4 h-4 text-teal-600" />
                    )}
                  </button>
                );
              })
            ) : (
              Object.entries(groupedModels).map(([provider, providerModels]) => {
                const providerStyle = getProviderStyle(provider);
                const ProviderIcon = providerStyle.icon;

                return (
                  <div key={provider}>
                    <div className={`px-3 py-2 text-xs font-medium uppercase bg-gray-50 flex items-center gap-2 text-gray-500`} data-testid="provider-header">
                      <ProviderIcon className="w-3 h-3" />
                      {provider}
                    </div>
                    {providerModels.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => handleSelect(model.id, provider)}
                        className={`
                          w-full px-3 py-2.5 flex items-center gap-3 hover:bg-gray-50 transition-colors
                          ${currentModel === `${provider}/${model.id}` ? 'bg-teal-50' : ''}
                        `}
                      >
                        <div className="flex-1 text-left">
                          <p className="text-sm text-gray-900">{model.name}</p>
                          <p className="text-xs text-gray-500">
                            {model.contextWindow.toLocaleString()} context
                            {model.description && ` · ${model.description}`}
                          </p>
                        </div>
                        {currentModel === `${provider}/${model.id}` && (
                          <Check className="w-4 h-4 text-teal-600" />
                        )}
                      </button>
                    ))}
                  </div>
                );
              })
            )}

            {filteredModels.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-gray-400">
                No models found matching &quot;{search}&quot;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
