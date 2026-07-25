import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { parseGoalWidget, type GoalModel } from '../lib/goalModel';

/**
 * Per-session goal history.
 *
 * The goal extension clears its widget and status the moment a goal finishes,
 * so without this store every trace of a completed goal disappears from the UI
 * (and a session that ran several goals shows nothing at all afterwards). This
 * store keeps the last known projection of each goal, archives it when the goal
 * actually ends, and labels the outcome from the extension's own completion
 * notification. It never mutates extension state — it only remembers what was
 * already broadcast.
 *
 * Runtime-neutral on purpose: Pi emits these events through the extension UI
 * adapter and OpenCode through its server-side goal bridge, and both use the
 * same widget/status keys.
 */

/** How many finished goals are kept per session. */
export const GOAL_HISTORY_LIMIT = 5;

/** How many sessions keep goal history before the oldest are dropped. */
export const GOAL_SESSION_LIMIT = 25;

/** A completion notification only labels a goal archived in this window. */
const OUTCOME_MATCH_WINDOW_MS = 60_000;

export type GoalOutcome = 'achieved' | 'cleared' | 'ended';

export interface GoalRecord {
  /** Last parsed projection of the extension's widget payload. */
  model: GoalModel;
  /** Raw widget lines, kept so the panel can always fall back to the source. */
  lines: string[];
  /** Latest `extension_status` text, when the goal is live. */
  statusText: string | null;
  /** Whether the extension currently wants its widget shown. */
  widgetVisible: boolean;
  firstSeenAt: number;
  /** When the last widget payload arrived — i.e. the last run boundary. */
  updatedAt: number;
  endedAt: number | null;
  outcome: GoalOutcome | null;
  outcomeRuns: number | null;
}

export interface GoalSessionState {
  current: GoalRecord | null;
  history: GoalRecord[];
}

interface GoalStoreState {
  bySession: Record<string, GoalSessionState>;
}

interface GoalStoreActions {
  applyWidget: (sessionId: string, lines: string[]) => void;
  clearWidget: (sessionId: string) => void;
  applyStatus: (sessionId: string, text: string | undefined) => void;
  applyNotification: (sessionId: string, message: string) => void;
  getGoalView: (sessionId: string | null | undefined) => GoalSessionState;
  forgetSession: (sessionId: string) => void;
}

const EMPTY_VIEW: GoalSessionState = { current: null, history: [] };

const ACHIEVED = /goal achieved in (\d+) agent runs?/i;
const CLEARED = /goal cleared/i;

function sessionSlice(state: GoalStoreState, sessionId: string): GoalSessionState {
  return state.bySession[sessionId] ?? EMPTY_VIEW;
}

/** Bound the persisted map so long-lived browsers do not grow without limit. */
function boundSessions(bySession: Record<string, GoalSessionState>): Record<string, GoalSessionState> {
  const ids = Object.keys(bySession);
  if (ids.length <= GOAL_SESSION_LIMIT) return bySession;
  const lastTouched = (id: string): number => {
    const slice = bySession[id];
    return Math.max(slice.current?.updatedAt ?? 0, slice.history[0]?.endedAt ?? 0);
  };
  const keep = ids.sort((a, b) => lastTouched(b) - lastTouched(a)).slice(0, GOAL_SESSION_LIMIT);
  const next: Record<string, GoalSessionState> = {};
  for (const id of keep) next[id] = bySession[id];
  return next;
}

export const useGoalStore = create<GoalStoreState & GoalStoreActions>()(
  persist(
    (set, get) => ({
      bySession: {},

      applyWidget: (sessionId, lines) => {
        const model = parseGoalWidget(lines);
        if (!model) return;
        set((state) => {
          const slice = sessionSlice(state, sessionId);
          const now = Date.now();
          // A re-subscribe replays the server's last widget snapshot verbatim.
          // Re-stamping updatedAt would restart the continuation countdown from
          // the full interval, so an identical payload keeps the original time.
          const isReplay = slice.current !== null
            && slice.current.lines.length === lines.length
            && slice.current.lines.every((line, index) => line === lines[index]);
          const current: GoalRecord = slice.current
            ? { ...slice.current, model, lines, widgetVisible: true, updatedAt: isReplay ? slice.current.updatedAt : now }
            : {
                model,
                lines,
                statusText: null,
                widgetVisible: true,
                firstSeenAt: now,
                updatedAt: now,
                endedAt: null,
                outcome: null,
                outcomeRuns: null,
              };
          return {
            bySession: boundSessions({
              ...state.bySession,
              [sessionId]: { ...slice, current },
            }),
          };
        });
      },

      clearWidget: (sessionId) => {
        // A bare widget_cleared means the extension hid its widget (the user
        // toggled `/goal status`). The goal itself only ends when the status
        // text is cleared too, so nothing is archived here.
        set((state) => {
          const slice = sessionSlice(state, sessionId);
          if (!slice.current) return state;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...slice, current: { ...slice.current, widgetVisible: false } },
            },
          };
        });
      },

      applyStatus: (sessionId, text) => {
        set((state) => {
          const slice = sessionSlice(state, sessionId);
          if (text !== undefined) {
            if (!slice.current) return state;
            return {
              bySession: {
                ...state.bySession,
                [sessionId]: { ...slice, current: { ...slice.current, statusText: text } },
              },
            };
          }

          // Status cleared → the goal is over (achieved, cleared, or reset).
          if (!slice.current || !slice.current.model.objective) return state;
          const archived: GoalRecord = {
            ...slice.current,
            endedAt: Date.now(),
            outcome: 'ended',
            widgetVisible: false,
          };
          return {
            bySession: boundSessions({
              ...state.bySession,
              [sessionId]: {
                current: null,
                history: [archived, ...slice.history].slice(0, GOAL_HISTORY_LIMIT),
              },
            }),
          };
        });
      },

      applyNotification: (sessionId, message) => {
        const achieved = message.match(ACHIEVED);
        const cleared = CLEARED.test(message);
        if (!achieved && !cleared) return;
        set((state) => {
          const slice = sessionSlice(state, sessionId);
          const [latest, ...rest] = slice.history;
          if (!latest || latest.endedAt === null) return state;
          if (Date.now() - latest.endedAt > OUTCOME_MATCH_WINDOW_MS) return state;
          const patched: GoalRecord = {
            ...latest,
            outcome: achieved ? 'achieved' : 'cleared',
            outcomeRuns: achieved ? Number(achieved[1]) : latest.model.runs,
          };
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...slice, history: [patched, ...rest] },
            },
          };
        });
      },

      getGoalView: (sessionId) => {
        if (!sessionId) return EMPTY_VIEW;
        return get().bySession[sessionId] ?? EMPTY_VIEW;
      },

      forgetSession: (sessionId) => {
        set((state) => {
          if (!state.bySession[sessionId]) return state;
          const next = { ...state.bySession };
          delete next[sessionId];
          return { bySession: next };
        });
      },
    }),
    {
      name: 'pi-web-ui-goal-history',
      // Only the archived goals need to survive a reload; a live goal is
      // replayed by the server on reconnect (extension UI snapshot).
      partialize: (state) => ({
        bySession: Object.fromEntries(
          Object.entries(state.bySession)
            .map(([id, slice]) => [id, { current: null, history: slice.history }])
            .filter(([, slice]) => (slice as GoalSessionState).history.length > 0),
        ),
      }),
    },
  ),
);
