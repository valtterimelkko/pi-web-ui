import { Lightbulb } from 'lucide-react';

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';

interface ThinkingLevelSelectorProps {
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}

const levels: { value: ThinkingLevel; label: string; description: string }[] = [
  { value: 'none', label: 'No Thinking', description: 'Direct responses' },
  { value: 'low', label: 'Low', description: 'Quick thinking' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { value: 'high', label: 'High', description: 'Deep analysis' },
];

export function ThinkingLevelSelector({ value, onChange }: ThinkingLevelSelectorProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-slate-200">
        <Lightbulb className="w-5 h-5 text-amber-400" />
        <span className="font-medium">Thinking Level</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {levels.map((level) => (
          <button
            key={level.value}
            onClick={() => onChange(level.value)}
            className={`
              p-3 rounded-lg text-left transition-colors
              ${value === level.value
                ? 'bg-violet-600/30 border border-violet-600'
                : 'bg-slate-800 border border-transparent hover:bg-slate-700'
              }
            `}
          >
            <p className="text-sm font-medium text-slate-200">{level.label}</p>
            <p className="text-xs text-slate-500">{level.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
