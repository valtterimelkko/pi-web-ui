import { FLOOR_STATE_LABEL, type FloorView } from './voiceFloor';

/** Per-state styling — each state is distinguishable at a glance (§4.1:
 * the operator must always know who has the floor). */
const STATE_STYLES: Record<FloorView['state'], string> = {
  'you-have-the-floor':
    'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 border-red-300 dark:border-red-800',
  'talker-speaking':
    'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800',
  'working-silently':
    'bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-700',
  'answer-ready-held':
    'bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-800',
  idle:
    'bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-800',
};

/**
 * FloorBanner — the four-states indicator (plus the neutral idle state).
 * Renders what `deriveFloorState` computed; holds no state of its own.
 */
export function FloorBanner({ view }: { view: FloorView }) {
  return (
    <div
      data-testid="floor-banner"
      role="status"
      aria-live="polite"
      className={`inline-flex flex-wrap items-center justify-center gap-2 px-4 py-2 rounded-full border text-base font-medium transition-colors ${STATE_STYLES[view.state]}`}
    >
      <span
        aria-hidden="true"
        className={`w-2.5 h-2.5 rounded-full ${
          view.state === 'you-have-the-floor'
            ? 'bg-red-500 animate-pulse'
            : view.state === 'talker-speaking'
              ? 'bg-blue-500 animate-pulse'
              : view.state === 'working-silently'
                ? 'bg-gray-400'
                : view.state === 'answer-ready-held'
                  ? 'bg-violet-500'
                  : 'bg-gray-300 dark:bg-gray-600'
        }`}
      />
      <span data-testid="floor-state-label">{FLOOR_STATE_LABEL[view.state]}</span>
      {view.ducked && (
        <span
          data-testid="floor-ducked-badge"
          className="text-xs px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300"
        >
          speech ducked
        </span>
      )}
      {view.speechHeld && (
        <span
          data-testid="floor-held-badge"
          className="text-xs px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900 text-violet-700 dark:text-violet-300"
        >
          answer held
        </span>
      )}
    </div>
  );
}
