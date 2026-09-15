import { Monitor, Smartphone } from 'lucide-react';
import type { VoiceLayoutMode } from './voiceLayout';

export interface VoiceLayoutToggleProps {
  mode: VoiceLayoutMode;
  onSelect: (mode: VoiceLayoutMode) => void;
  /** True when the desktop preference cannot be honoured at this width. */
  degraded?: boolean;
}

/**
 * The mode switch (P-ChildV): the operator's explicit, persisted choice between
 * the existing voice-only surface ('mobile') and the desktop split that shows
 * the live session beside it. Deliberately a plain two-button choice — the mode
 * is a preference the operator sets once, not a hidden breakpoint behaviour.
 */
export function VoiceLayoutToggle({ mode, onSelect, degraded }: VoiceLayoutToggleProps) {
  const options: Array<{ id: VoiceLayoutMode; label: string; Icon: typeof Monitor }> = [
    { id: 'mobile', label: 'Mobile', Icon: Smartphone },
    { id: 'desktop', label: 'Desktop', Icon: Monitor },
  ];
  return (
    <div className="flex flex-col items-center gap-1" data-testid="voice-layout-toggle">
      <div
        role="group"
        aria-label="Voice Mode layout"
        className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-0.5"
      >
        {options.map(({ id, label, Icon }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-pressed={active}
              aria-label={`${label} layout`}
              data-testid={`voice-layout-${id}`}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors select-none touch-manipulation ${
                active
                  ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>
      {degraded && (
        <p data-testid="voice-layout-degraded" className="text-[11px] text-gray-500 dark:text-gray-400">
          Too narrow to split — showing the mobile layout.
        </p>
      )}
    </div>
  );
}
