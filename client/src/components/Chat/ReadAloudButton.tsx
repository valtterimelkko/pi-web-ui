import { Volume2, Square, Loader2 } from 'lucide-react';

type ReadAloudState = 'idle' | 'loading' | 'playing';

interface ReadAloudButtonProps {
  state: ReadAloudState;
  onClick: () => void;
}

export function ReadAloudButton({ state, onClick }: ReadAloudButtonProps) {
  const isLoading = state === 'loading';
  const isPlaying = state === 'playing';

  return (
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
  );
}
