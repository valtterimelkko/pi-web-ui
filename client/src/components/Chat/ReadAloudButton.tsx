import { Volume2, Square, Loader2 } from 'lucide-react';

type ReadAloudState = 'idle' | 'loading' | 'playing';

interface ReadAloudButtonProps {
  state: ReadAloudState;
  speedEnabled: boolean;
  onClick: () => void;
  onToggleSpeed: () => void;
}

export function ReadAloudButton({ state, speedEnabled, onClick, onToggleSpeed }: ReadAloudButtonProps) {
  const isLoading = state === 'loading';
  const isPlaying = state === 'playing';

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
              ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300'
              : 'bg-gray-100 text-gray-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-600'
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
          p-2 rounded-lg transition-all duration-200 touch-manipulation
          ${isLoading
            ? 'bg-blue-100 text-blue-600 cursor-wait'
            : isPlaying
              ? 'bg-blue-100 text-blue-600'
              : 'bg-gray-100 text-gray-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-700 cursor-pointer'
          }
        `}
        title={isLoading ? 'Loading…' : isPlaying ? 'Stop' : 'Read aloud'}
        aria-label={isLoading ? 'Loading audio' : isPlaying ? 'Stop reading aloud' : 'Read message aloud'}
        type="button"
      >
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" />
          : isPlaying ? <Square className="w-4 h-4" />
          : <Volume2 className="w-4 h-4" />}
      </button>
    </>
  );
}
