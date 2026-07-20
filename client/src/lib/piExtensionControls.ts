export type RuntimeSdkType = 'pi' | 'claude' | 'opencode' | 'antigravity' | null | undefined;

export function isPiSlashCommandAllowedWhileStreaming(
  draft: string,
  isStreaming: boolean,
  sdkType: RuntimeSdkType,
): boolean {
  return isStreaming && sdkType === 'pi' && draft.trimStart().startsWith('/');
}

export function shouldPauseGoalOnStop(
  sdkType: RuntimeSdkType,
  goalStatus: string | undefined,
): boolean {
  if (!goalStatus) return false;
  const normalized = goalStatus.trim().toLowerCase();
  const isActive = normalized === 'wrapping-up' || normalized.startsWith('running');
  if (!isActive) return false;
  // Pi: user triggers /goal pause-now slash command before abort.
  // OpenCode: server pauses goal state automatically on abort (no extra client action needed).
  return sdkType === 'pi' || sdkType === 'opencode';
}

export type GoalControlAction = 'pause' | 'resume' | 'clear';

/** Pi goal controls are extension commands; OpenCode has a server-side control path. */
export function getGoalControlCommand(
  sdkType: RuntimeSdkType,
  action: GoalControlAction,
): string | null {
  if (sdkType !== 'pi') return null;
  if (action === 'pause') return '/goal pause-now';
  return `/goal ${action}`;
}

export interface GoalTag {
  /** Whether an actionable goal is active and the tag should be shown. */
  active: boolean;
  /** Short human label: "running…", "running", "paused", "wrapping up…". */
  label: string;
  /** True when the goal is paused or wrapping up. */
  paused: boolean;
  /** True when the goal is actively making progress (drives the live pulse). */
  pulsing: boolean;
  /** Agent run number from the status text, when available. */
  run: number | null;
}

const INACTIVE_GOAL_TAG: GoalTag = {
  active: false,
  label: '',
  paused: false,
  pulsing: false,
  run: null,
};

/**
 * Derive a compact, live goal indicator from the goal-engine extension status.
 *
 * The server only re-emits the goal status after each agent turn (and on
 * attach), so the stored text reflects the last completed turn. By combining it
 * with the session's live `isStreaming` flag we can show a pulsing "running…"
 * state during the long, silent model-thinking gaps that otherwise make an
 * actively-progressing goal look frozen.
 */
export function deriveGoalTag(
  goalStatus: string | undefined,
  isStreaming: boolean,
): GoalTag {
  if (!goalStatus) return INACTIVE_GOAL_TAG;
  const text = goalStatus.trim();
  if (!text) return INACTIVE_GOAL_TAG;
  if (/\bidle\b/i.test(text)) return INACTIVE_GOAL_TAG;

  const wrapping = /wrapping/i.test(text);
  const paused = wrapping || /paus/i.test(text);
  const runMatch = text.match(/run\s+(\d+)/i);
  const run = runMatch ? Number(runMatch[1]) : null;

  const pulsing = isStreaming && !paused;
  let label: string;
  if (pulsing) label = 'running…';
  else if (wrapping) label = 'wrapping up…';
  else if (paused) label = 'paused';
  else label = 'running';

  return { active: true, label, paused, pulsing, run };
}
