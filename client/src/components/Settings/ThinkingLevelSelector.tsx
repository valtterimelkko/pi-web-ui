import { Lightbulb } from 'lucide-react';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ThinkingLevelSelectorProps {
  value: ThinkingLevel;
  /** Omit to expose all levels; supply model capabilities to hide unsupported levels. */
  availableLevels?: readonly ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
}

export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

const levels: { value: ThinkingLevel; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'No extended thinking' },
  { value: 'minimal', label: 'Minimal', description: 'Brief reasoning' },
  { value: 'low', label: 'Low', description: 'Quick thinking' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { value: 'high', label: 'High', description: 'Deep analysis' },
  { value: 'xhigh', label: 'Extra High', description: 'Extended reasoning' },
  { value: 'max', label: 'Max', description: 'Absolute maximum reasoning' },
];

export function ThinkingLevelSelector({ value, availableLevels = ALL_THINKING_LEVELS, onChange }: ThinkingLevelSelectorProps) {
  const visibleLevels = levels.filter((level) => availableLevels.includes(level.value));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-gray-700">
        <Lightbulb className="w-5 h-5 text-gray-400" />
        <span className="font-medium">Thinking Level</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {visibleLevels.map((level) => (
          <button
            key={level.value}
            onClick={() => onChange(level.value)}
            className={`
              p-3 rounded-lg text-left transition-colors
              ${value === level.value
                ? 'bg-blue-50 border border-blue-500'
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
