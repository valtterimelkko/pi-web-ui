import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { laneFloor } from './voiceLanes';
import { speechArbiter } from '../../lib/speechArbiter';
import { useSessionStore } from '../../store/sessionStore';
import { MAX_VOICE_LANES, type DriveModeLane } from '../../store/driveModeStore';

export interface LaneStripProps {
  lanes: DriveModeLane[];
  addressedSessionId: string | null;
  /** sessionId → the session's display name (never a number to remember). */
  labels: Record<string, string>;
  onAddress: (sessionId: string) => void;
  onAdd: () => void;
  onRemove: (sessionId: string) => void;
}

type LaneRowState = 'floor' | 'speaking' | 'queued' | 'working' | 'ready';

const ROW_STATE_LABEL: Record<LaneRowState, string> = {
  floor: 'You have the floor',
  speaking: 'Speaking',
  queued: 'Waiting to speak',
  working: 'Working silently',
  ready: 'Ready',
};

const ROW_STATE_CLASS: Record<LaneRowState, string> = {
  floor: 'text-red-700 dark:text-red-300 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950',
  speaking:
    'text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950',
  queued:
    'text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950',
  working: 'text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-900',
  ready: 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900',
};

/**
 * LaneStrip — the primary multi-lane control (§4.2): one row per lane with
 * its floor state at a glance, which lane is audible, one-tap addressing,
 * and the cap always visible ("2 of 3"). With fewer than two lanes it
 * renders NOTHING — single-lane use is the shipped surface, unchanged.
 *
 * The per-row states derive from state the tab already holds: the shared
 * arbiter (speech, queue, ducking — its tier-then-arrival order is the
 * cross-lane §4.4 queue) and the lane floor coordinator (capture, §4.4
 * rules 1–2). No scheduling happens here; this is observation and switching.
 */
export function LaneStrip({ lanes, addressedSessionId, labels, onAddress, onAdd, onRemove }: LaneStripProps) {
  const streaming = useSessionStore((s) => s.streamingSessions);
  const [, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const unsubscribeArbiter = speechArbiter.subscribe(bump);
    const unsubscribeFloor = laneFloor.subscribe(bump);
    return () => {
      unsubscribeArbiter();
      unsubscribeFloor();
    };
  }, []);

  if (lanes.length < 2) {
    // COLLAPSED: single-lane use is the shipped surface — no rows, no cap
    // counter. The only lane UI is the "+" affordance, the entry point to
    // the feature (the brief mandates a "+" that adds a second worker).
    return (
      <div className="w-full px-4 pt-3 flex justify-center" data-testid="lane-strip-collapsed">
        <button
          onClick={onAdd}
          aria-label="Add a lane"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          type="button"
        >
          <Plus className="w-3.5 h-3.5" />
          Add lane
        </button>
      </div>
    );
  }

  const capturingLane = laneFloor.capturingLaneId();
  const speakingLane = laneFloor.laneOfSpeechIntent();
  const arbiter = speechArbiter.getState();

  const labelOf = (sessionId: string) => labels[sessionId] ?? 'Worker';

  const rowStateOf = (sessionId: string): LaneRowState => {
    if (capturingLane === sessionId) return 'floor';
    if (speakingLane === sessionId) return 'speaking';
    if (arbiter.queued.some((queued) => queued.id.includes(sessionId))) return 'queued';
    if (streaming[sessionId]) return 'working';
    return 'ready';
  };

  return (
    <div
      data-testid="lane-strip"
      role="group"
      aria-label="Voice lanes"
      className="w-full px-4 pt-3 flex flex-col items-center gap-1"
    >
      <div className="w-full max-w-md flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400" data-testid="lane-cap">
          {lanes.length} of {MAX_VOICE_LANES}
        </span>
        <button
          onClick={onAdd}
          aria-label="Add a lane"
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          type="button"
        >
          <Plus className="w-3.5 h-3.5" />
          Add lane
        </button>
      </div>

      {lanes.map((lane) => {
        const state = rowStateOf(lane.sessionId);
        const addressed = lane.sessionId === addressedSessionId;
        return (
          <div key={lane.sessionId} className="w-full max-w-md flex items-center gap-2">
            <button
              data-testid="lane-row"
              data-lane-session={lane.sessionId}
              onClick={() => onAddress(lane.sessionId)}
              aria-current={addressed ? 'true' : undefined}
              className={`flex-1 flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-medium transition-colors text-left ${ROW_STATE_CLASS[state]} ${
                addressed ? 'ring-2 ring-blue-400 dark:ring-blue-600' : 'opacity-90 hover:opacity-100'
              }`}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`w-2 h-2 rounded-full shrink-0 ${
                  state === 'floor'
                    ? 'bg-red-500 animate-pulse'
                    : state === 'speaking'
                      ? 'bg-blue-500 animate-pulse'
                      : state === 'queued'
                        ? 'bg-violet-500'
                        : addressed
                          ? 'bg-blue-400'
                          : 'bg-gray-300 dark:bg-gray-600'
                }`}
              />
              <span className="truncate">{labelOf(lane.sessionId)}</span>
              <span className="ml-auto flex items-center gap-2 shrink-0">
                {capturingLane && capturingLane !== lane.sessionId && (
                  <span
                    data-testid="lane-floor-marker"
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300"
                  >
                    {labelOf(capturingLane)} has the floor
                  </span>
                )}
                <span data-testid="lane-state-label" className="text-xs">
                  {ROW_STATE_LABEL[state]}
                </span>
                {state === 'speaking' && arbiter.ducked && (
                  <span
                    data-testid="lane-ducked-badge"
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300"
                  >
                    ducked
                  </span>
                )}
              </span>
            </button>
            <button
              onClick={() => onRemove(lane.sessionId)}
              aria-label={`Close lane ${labelOf(lane.sessionId)}`}
              data-testid="lane-close"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}

    </div>
  );
}
