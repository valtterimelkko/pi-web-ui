import { useState, useMemo } from 'react';
import { Search, Check, ChevronDown } from 'lucide-react';

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

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-violet-600 flex items-center justify-center">
            <span className="text-white font-bold text-xs">
              {selectedModel?.provider.slice(0, 2).toUpperCase() || 'AI'}
            </span>
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-slate-200">
              {selectedModel?.name || 'Select Model'}
            </p>
            <p className="text-xs text-slate-500">
              {selectedModel?.provider || 'Choose a model'}
            </p>
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 rounded-lg border border-slate-700 shadow-xl z-50 max-h-80 overflow-hidden flex flex-col">
          <div className="p-3 border-b border-slate-700">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models..."
                className="w-full pl-9 pr-3 py-2 bg-slate-900 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-600"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {Object.entries(groupedModels).map(([provider, providerModels]) => (
              <div key={provider}>
                <div className="px-3 py-2 text-xs font-medium text-slate-500 uppercase bg-slate-900/50">
                  {provider}
                </div>
                {providerModels.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onSelect(model.id);
                      setIsOpen(false);
                    }}
                    className={`
                      w-full px-3 py-2 flex items-center gap-3 hover:bg-slate-700 transition-colors
                      ${currentModel === model.id ? 'bg-violet-600/20' : ''}
                    `}
                  >
                    <div className="flex-1 text-left">
                      <p className="text-sm text-slate-200">{model.name}</p>
                      <p className="text-xs text-slate-500">
                        {model.contextWindow.toLocaleString()} context
                      </p>
                    </div>
                    {currentModel === model.id && (
                      <Check className="w-4 h-4 text-violet-400" />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
