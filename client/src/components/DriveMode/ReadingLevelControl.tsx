/**
 * ReadingLevelControl — how much of the worker's output is spoken, and which
 * level the surface is reading right now (P17).
 *
 * The control is the operator's switch; the indicator exists because the one
 * dangerous failure of summarisation is NOT KNOWING whether you heard
 * everything. So the active level is permanently visible, and when the answer
 * in flight is a condensation the surface says so.
 *
 * Presentational only: the level and the choice live in the persisted store,
 * and the reading itself lives in the answer reader.
 */
import {
  READING_LEVELS,
  READING_LEVEL_LABEL,
  type ReadingLevel,
} from './readingLevel';

/** How the active reading is described while an answer is in flight. */
const SPOKEN_KIND_LABEL: Record<ReadingLevel, string> = {
  verbatim: 'hearing it verbatim',
  summary: 'hearing a summary',
  headlines: 'hearing the headlines',
};

export interface ReadingLevelControlProps {
  level: ReadingLevel;
  onSelect: (level: ReadingLevel) => void;
  /** The form the answer in flight is being read in; null when nothing of the
   *  current answer is speaking. */
  spokenKind: ReadingLevel | null;
  /** Set when a digest could not be produced and the turn was read in full
   *  instead — the fallback is stated, never silent. */
  fallbackNote?: string | null;
}

export function ReadingLevelControl({
  level,
  onSelect,
  spokenKind,
  fallbackNote = null,
}: ReadingLevelControlProps) {
  return (
    <div className="flex flex-col items-center gap-2" data-testid="reading-level">
      <div
        role="group"
        aria-label="Reading level"
        className="inline-flex rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-1"
      >
        {READING_LEVELS.map((option) => {
          const active = option === level;
          return (
            <button
              key={option}
              type="button"
              data-testid={`reading-level-${option}`}
              aria-pressed={active}
              onClick={() => onSelect(option)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors select-none touch-manipulation ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800'
              }`}
            >
              {READING_LEVEL_LABEL[option]}
            </button>
          );
        })}
      </div>

      <div
        data-testid="reading-level-indicator"
        role="status"
        aria-live="polite"
        className="text-xs text-gray-500 dark:text-gray-400"
      >
        Reading level: {READING_LEVEL_LABEL[level]}
        {spokenKind ? ` — ${SPOKEN_KIND_LABEL[spokenKind]}` : ''}
      </div>

      <div data-testid="reading-level-hint" className="text-[11px] text-gray-400 dark:text-gray-500">
        The transcript has the full text — speech is an enhancement over it.
      </div>

      {fallbackNote && (
        <div
          data-testid="reading-level-fallback"
          role="alert"
          className="text-[11px] text-amber-600 dark:text-amber-400"
        >
          {fallbackNote}
        </div>
      )}
    </div>
  );
}
