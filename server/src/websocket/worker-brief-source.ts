/**
 * The worker projection a LIVE voice lane is handed.
 *
 * This is the wiring the 2026-09-18 operator report was decided in: the lane was
 * given a status line and nothing about the work, so the talker answered "I don't
 * have access to the worker's session history" about a session the operator could
 * see in the UI. It lives in its own module because the composition beneath it
 * (talker registry → session file → brief policy) is covered by tests while the
 * mapping in between — which snapshot fields become the lane's brief, and which
 * runtime they are read as — was previously only visible by reading the code.
 *
 * It reads and returns; it holds no delivery capability and cannot send, confirm,
 * hold or release anything.
 */
import type { TalkerSessionRegistry } from '../talker/session-registry.js';
import type { VoiceRuntime } from '@pi-web-ui/shared';
import type { VoiceWorkerBrief } from './voice-live-mount.js';

/**
 * How deep into the session the lane's source goes. Deeper than the relay lane's
 * standing view (200), because the voice lane decides how much of the session the
 * model holds (`server/src/voice/worker-brief.ts`) and its retrieval tool reads
 * further back from this same source.
 */
export const WORKER_BRIEF_SOURCE_TAIL = 2_000;

export interface WorkerBriefSourceDeps {
  /** The same projection the relay lane uses (P20/P23), so both lanes agree. */
  talkerSessionRegistry: Pick<TalkerSessionRegistry, 'workerStateSnapshot'>;
}

/**
 * Build the live lane's worker-brief reader.
 *
 * `entries` is present ONLY when there is a conversation to hand over, because
 * the mount treats "no entries" and "an empty session" as different claims: it
 * injects a brief when it holds lines and otherwise records `worker_brief_empty`.
 * Failures are left to surface so the mount records `worker_brief_unavailable`
 * rather than being hidden one layer below the evidence meant to report them.
 */
export function createWorkerBriefSource(
  deps: WorkerBriefSourceDeps,
  historyTail: number = WORKER_BRIEF_SOURCE_TAIL
): (workerSessionId: string, runtime: VoiceRuntime) => Promise<VoiceWorkerBrief> {
  return async (workerSessionId: string, runtime: VoiceRuntime): Promise<VoiceWorkerBrief> => {
    // The LANE's runtime, not a hard-coded 'pi': a Claude or Antigravity lane read
    // as pi gets the wrong (or no) session and the model is told it has no access
    // (2026-09-22 report).
    const snapshot = await deps.talkerSessionRegistry.workerStateSnapshot(workerSessionId, runtime, { historyTail });
    const entries = snapshot.recentHistory;
    return {
      ...(snapshot.activity ? { activity: snapshot.activity } : {}),
      ...(entries && entries.length > 0 ? { entries, total: snapshot.historyTotal ?? entries.length } : {}),
    };
  };
}
