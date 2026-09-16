import { Mic, MicOff, Loader2 } from 'lucide-react';

export type DictationButtonState = 'idle' | 'starting' | 'recording' | 'processing' | 'error';

interface DictationButtonProps {
  state: DictationButtonState;
  onToggle: () => void;
  errorMessage?: string;
}

export function DictationButton({ state, onToggle, errorMessage }: DictationButtonProps) {
  const isDisabled = state === 'processing' || state === 'starting';

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={onToggle}
        disabled={isDisabled}
        className={`relative flex items-center justify-center w-8 h-8 rounded-full transition-all duration-150 select-none touch-manipulation ${
          isDisabled ? 'cursor-not-allowed' : 'active:scale-95'
        } ${
          state === 'idle'
            ? 'bg-surface dark:bg-surface-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle text-content-muted dark:text-content-muted-dark hover:text-content-primary dark:hover:text-content-primary-dark border border-outline-subtle dark:border-outline-subtle-dark'
            : state === 'recording'
            ? 'bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30'
            : state === 'processing'
            ? 'bg-pi-primary/10 text-pi-primary border border-pi-primary/30'
            : state === 'starting'
            ? 'bg-amber-500/10 text-amber-600 border border-amber-500/30'
            : 'bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 border border-orange-500/30'
        }`}
        type="button"
        title={
          state === 'idle'
            ? 'Start dictation'
            : state === 'starting'
            ? 'Starting microphone…'
            : state === 'recording'
            ? 'Stop dictation'
            : state === 'processing'
            ? 'Processing…'
            : 'Retry dictation'
        }
        aria-label={
          state === 'recording'
            ? 'Stop dictation'
            : state === 'starting'
            ? 'Starting microphone'
            : 'Start dictation'
        }
        aria-busy={state === 'starting' || undefined}
        aria-pressed={state === 'recording'}
      >
        {state === 'idle' && <Mic className="w-3.5 h-3.5" strokeWidth={1.75} />}
        {state === 'recording' && (
          <>
            <MicOff className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span className="absolute inset-0 rounded-full animate-ping bg-red-400/20 opacity-50" />
          </>
        )}
        {state === 'processing' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />}
        {state === 'starting' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />}
        {state === 'error' && <Mic className="w-3.5 h-3.5" strokeWidth={1.75} />}
      </button>
      {state === 'error' && errorMessage && (
        <p className="text-orange-600 text-[10px] leading-tight max-w-[80px] text-center" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
