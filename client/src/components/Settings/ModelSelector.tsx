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

export function ModelSelector({ models, currentModel, onSelect }: ModelSelectorProps) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const filteredModels = useMemo(() => {
    const query = search.toLowerCase();
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        m.provider.toLowerCase().includes(query)
    );
  }, [models, search]);

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

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
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
        <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 rounded-lg border border-slate-700 shadow-xl z-50 max-h-96 overflow-hidden flex flex-col">
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
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {Object.entries(groupedModels).map(([provider, providerModels]) => {
              const providerStyle = getProviderStyle(provider);
              const ProviderIcon = providerStyle.icon;
              
              return (
                <div key={provider}>
                  <div className={`px-3 py-2 text-xs font-medium uppercase bg-slate-900/50 flex items-center gap-2 ${providerStyle.color}`}>
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
            })}
            
            {Object.keys(groupedModels).length === 0 && (
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
