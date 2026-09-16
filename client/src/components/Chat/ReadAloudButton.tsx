import { Volume2, Square, Loader2 } from 'lucide-react';
import type { ReadAloudState } from '../../hooks/useReadAloud';

interface ReadAloudButtonProps {
  state: ReadAloudState;
  speedEnabled: boolean;
  onClick: () => void;
  onToggleSpeed: () => void;
}

export function ReadAloudButton({ state, speedEnabled, onClick, onToggleSpeed }: ReadAloudButtonProps) {
  const isLoading = state === 'loading';
  const isPlaying = state === 'playing';
  const isPaused = state === 'paused';

  return (
    <>
      {/* Speed toggle — shown when idle or playing */}
      {!isLoading && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSpeed();
          }}
          className={`
            w-7 h-7 rounded-lg text-[10px] font-semibold transition-all duration-200 touch-manipulation
            flex items-center justify-center
            ${speedEnabled
              ? 'bg-pi-primary/10 text-pi-primary border border-pi-primary/30'
              : 'bg-surface dark:bg-surface-dark border border-outline-subtle dark:border-outline-subtle-dark text-content-muted dark:text-content-muted-dark sm:opacity-0 sm:group-hover:opacity-100 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle hover:text-content-primary dark:hover:text-content-primary-dark'
            }
          `}
          title={speedEnabled ? 'Speed: 1.25× — tap for 1×' : 'Speed: 1× — tap for 1.25×'}
          aria-label={speedEnabled ? 'Set playback speed to 1×' : 'Set playback speed to 1.25×'}
          type="button"
        >
          {speedEnabled ? '1.25' : '1'}
        </button>
      )}

      <button
        onClick={onClick}
        disabled={isLoading}
        className={`
          p-1.5 rounded-lg transition-all duration-200 touch-manipulation
          ${isLoading
            ? 'bg-pi-primary/10 text-pi-primary cursor-wait'
            : isPlaying
              ? 'bg-pi-primary/15 text-pi-primary border border-pi-primary/30'
              : 'bg-surface dark:bg-surface-dark border border-outline-subtle dark:border-outline-subtle-dark text-content-muted dark:text-content-muted-dark sm:opacity-0 sm:group-hover:opacity-100 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle hover:text-content-primary dark:hover:text-content-primary-dark cursor-pointer'
          }
        `}
        title={isLoading ? 'Loading…' : isPlaying ? 'Stop' : isPaused ? 'Stopped at a sentence boundary — tap to clear' : 'Read aloud'}
        aria-label={isLoading ? 'Loading audio' : isPlaying ? 'Stop reading aloud' : 'Read message aloud'}
        type="button"
      >
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
          : isPlaying ? <Square className="w-4 h-4" strokeWidth={1.75} />
          : <Volume2 className="w-4 h-4" strokeWidth={1.75} />}
      </button>
    </>
  );
}
