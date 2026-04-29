import { Mic, MicOff, Loader2 } from 'lucide-react';

export type DictationButtonState = 'idle' | 'recording' | 'processing' | 'error';

interface DictationButtonProps {
  state: DictationButtonState;
  onToggle: () => void;
  errorMessage?: string;
}

export function DictationButton({ state, onToggle, errorMessage }: DictationButtonProps) {
  const isDisabled = state === 'processing';

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={onToggle}
        disabled={isDisabled}
        className={`relative flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150 select-none touch-manipulation ${
          isDisabled ? 'cursor-not-allowed' : 'active:scale-95'
        } ${
          state === 'idle'
            ? 'bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-700'
            : state === 'recording'
            ? 'bg-red-100 hover:bg-red-200 text-red-600'
            : state === 'processing'
            ? 'bg-blue-50 text-blue-500'
            : 'bg-orange-100 hover:bg-orange-200 text-orange-600'
        }`}
        type="button"
        title={
          state === 'idle'
            ? 'Start dictation'
            : state === 'recording'
            ? 'Stop dictation'
            : state === 'processing'
            ? 'Processing…'
            : 'Retry dictation'
        }
        aria-label={
          state === 'recording'
            ? 'Stop dictation'
            : 'Start dictation'
        }
        aria-pressed={state === 'recording'}
      >
        {state === 'idle' && <Mic className="w-4 h-4" />}
        {state === 'recording' && (
          <>
            <MicOff className="w-4 h-4" />
            <span className="absolute inset-0 rounded-full animate-ping bg-red-200 opacity-50" />
          </>
        )}
        {state === 'processing' && <Loader2 className="w-4 h-4 animate-spin" />}
        {state === 'error' && <Mic className="w-4 h-4" />}
      </button>
      {state === 'error' && errorMessage && (
        <p className="text-orange-600 text-[10px] leading-tight max-w-[80px] text-center" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
