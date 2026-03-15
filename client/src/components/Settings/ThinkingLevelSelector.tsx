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
      <div className="flex items-center gap-2 text-gray-700">
        <Lightbulb className="w-5 h-5 text-gray-400" />
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
                ? 'bg-teal-50 border border-teal-500'
                : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'
              }
            `}
          >
            <p className="text-sm font-medium text-gray-900">{level.label}</p>
            <p className="text-xs text-gray-500">{level.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
