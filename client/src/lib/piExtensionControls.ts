export type RuntimeSdkType = 'pi' | 'claude' | 'opencode' | 'antigravity' | 'commandcode' | null | undefined;

export function isPiSlashCommandAllowedWhileStreaming(
  draft: string,
  isStreaming: boolean,
  sdkType: RuntimeSdkType,
): boolean {
  return isStreaming && sdkType === 'pi' && draft.trimStart().startsWith('/');
}

/**
 * Whether the composer accepts free text while the agent is streaming.
 *
 * Three runtimes have a steer path on this transport:
 * - Pi: native mid-run steering (Enter = steer, delivered after the current
 *   tool batch and before the next model call).
 * - Claude (SDK backend): streaming-input mode delivers the steer at the next
 *   tool boundary (CLI user-message priority 'next'); follow-up queues with
 *   priority 'later'.
 * - Command Code: no mid-run input channel — steer interrupts the run and
 *   delivers the text as the next prompt; follow-up queues server-side.
 * Other runtimes have no steer path yet, so their composers stay read-only
 * while streaming.
 */
const STEERABLE_SDK_TYPES = new Set<RuntimeSdkType>(['pi', 'claude', 'commandcode']);

export function canSteerWhileStreaming(
  isStreaming: boolean,
  sdkType: RuntimeSdkType,
): boolean {
  return isStreaming && STEERABLE_SDK_TYPES.has(sdkType);
}

/**
 * Whether a streaming free-text message can actually be sent. Attachments are
 * not part of the steer/follow_up wire frames, so uploads block the send until
 * the run finishes (they can still be attached for the next prompt).
 */
export function canSendStreamingText(
  isStreaming: boolean,
  sdkType: RuntimeSdkType,
  hasUploads: boolean,
): boolean {
  return canSteerWhileStreaming(isStreaming, sdkType) && !hasUploads;
}

export function shouldPauseGoalOnStop(
  sdkType: RuntimeSdkType,
  goalStatus: string | undefined,
): boolean {
  const kind = classifyGoalStatusText(goalStatus);
  const isActive = kind === 'running' || kind === 'wrapping-up';
  if (!isActive) return false;
  // Pi: user triggers /goal pause-now slash command before abort.
  // OpenCode: server pauses goal state automatically on abort (no extra client action needed).
  // Claude + Command Code (contract 1.27.0): a stop disarms the server-side
  // auto-continue loop / signals the goal-runner control file, so an aborted
  // goal stays stopped instead of the server re-launching it.
  return sdkType === 'pi' || sdkType === 'opencode' || sdkType === 'claude' || sdkType === 'commandcode';
}

export type GoalControlAction = 'pause' | 'resume' | 'clear';

/** Status kind recognised from a goal-engine status line. */
export type GoalStatusKind = 'running' | 'paused' | 'wrapping-up' | 'suggested' | 'failed' | 'unknown';

/**
 * Single recogniser for every goal-engine status-text grammar (Pi extension,
 * Internal API browser bridge, OpenCode bridge). Default-closed by design:
 * only the known live states (running / paused / wrapping-up / awaiting-input)
 * count as active — a pending suggestion, a terminal failure, an idle line, or
 * unrecognised text must never render as an actionable running goal, because
 * the pause/clear controls it enables answer "no goal" (2026-09-03 defect).
 */
export function classifyGoalStatusText(goalStatus: string | undefined | null): GoalStatusKind {
  if (!goalStatus) return 'unknown';
  const text = goalStatus.trim();
  if (!text) return 'unknown';
  if (/\bidle\b/i.test(text)) return 'unknown';
  if (/goal suggested|awaiting owner approval/i.test(text)) return 'suggested';
  if (/wrapping/i.test(text)) return 'wrapping-up';
  if (/paus/i.test(text) || /awaiting user input/i.test(text)) return 'paused';
  if (/✖/.test(text) || /\bfailed\b/i.test(text)) return 'failed';
  if (/\brunning\b/i.test(text)) return 'running';
  return 'unknown';
}

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
 *
 * Only recognised live states produce a tag; {@link classifyGoalStatusText}
 * owns the grammar so suggestion/failed/unknown lines can never enable the
 * pause/clear controls (they would answer "no goal").
 */
export function deriveGoalTag(
  goalStatus: string | undefined,
  isStreaming: boolean,
): GoalTag {
  const kind = classifyGoalStatusText(goalStatus);
  const paused = kind === 'paused' || kind === 'wrapping-up';
  if (kind !== 'running' && !paused) return INACTIVE_GOAL_TAG;

  const text = (goalStatus as string).trim();
  const runMatch = text.match(/run\s+(\d+)/i);
  const run = runMatch ? Number(runMatch[1]) : null;

  const pulsing = isStreaming && !paused;
  let label: string;
  if (kind === 'wrapping-up') label = 'wrapping up…';
  else if (pulsing) label = 'running…';
  else if (kind === 'paused') label = 'paused';
  else label = 'running';

  return { active: true, label, paused, pulsing, run };
}
