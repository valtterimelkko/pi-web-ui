/**
 * Cross-runtime goal function (contract 1.27.0) — Command Code projection.
 *
 * Combines the server-side goal record (what the launcher armed) with the
 * goal-runner mod's state file (the runtime truth channel) into the canonical
 * projection. The mod's state file wins for runtime status; the record fills
 * in what the mod does not know (auto-continue, cleared marker).
 */

import type { SessionGoalProjection } from './types.js';

export interface CommandCodeGoalRecordLike {
  objective?: string;
  maxTurns?: number;
  verifier?: string;
  verifyCommand?: string;
  modelVerifier?: string;
  autoContinue?: boolean;
  status?: string;
  pausedReason?: string;
  clearedAt?: number;
  [key: string]: unknown;
}

export interface CommandCodeGoalModStateLike {
  objective?: string;
  status?: string;
  pausedReason?: string;
  turns?: number;
  continuations?: number;
  verifications?: Array<{ kind?: string; ok?: boolean; detail?: string }>;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  [key: string]: unknown;
}

export function projectCommandCodeGoal(
  record: CommandCodeGoalRecordLike | null,
  modState: CommandCodeGoalModStateLike | null,
  modAvailable: boolean,
): SessionGoalProjection {
  if (!modAvailable) return { supported: false, status: 'unknown' };

  // Cleared is a record-level truth (the mod never writes after a clear).
  if (record?.status === 'cleared' || record?.clearedAt !== undefined) {
    return {
      supported: true,
      status: 'cleared',
      objective: typeof record.objective === 'string' ? record.objective : undefined,
      autoContinue: record.autoContinue !== false,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      runtimeState: { record, modState: modState ?? null },
    };
  }
  if (!record && !modState) {
    // Runtime enabled, no goal armed yet — honest idle.
    return { supported: true, status: 'idle', autoContinue: true };
  }

  const objective = modState?.objective ?? record?.objective;
  const verificationLog = Array.isArray(modState?.verifications) ? modState.verifications : [];
  const lastVerification = verificationLog[verificationLog.length - 1];
  const status = modState?.status ?? record?.status ?? 'running';

  let canonical: SessionGoalProjection['status'];
  let pausedReason: string | null = null;
  switch (status) {
    case 'completed':
      canonical = 'achieved';
      break;
    case 'failed':
      canonical = 'failed';
      break;
    case 'paused':
      canonical = 'paused';
      pausedReason = modState?.pausedReason ?? 'user';
      break;
    case 'cleared':
      canonical = 'cleared';
      break;
    case 'running':
      canonical = record?.status === 'paused' ? 'paused' : 'running';
      pausedReason = record?.status === 'paused' ? (record.pausedReason ?? 'user') : null;
      break;
    default:
      canonical = 'unknown';
  }

  return {
    supported: true,
    status: canonical,
    objective,
    runs: typeof modState?.turns === 'number' ? modState.turns : undefined,
    maxRuns: typeof record?.maxTurns === 'number' ? record.maxTurns : null,
    verification: lastVerification
      ? { status: lastVerification.ok ? 'passed' : 'failed', message: lastVerification.detail ?? null }
      : undefined,
    pausedReason,
    autoContinue: record?.autoContinue !== false,
    startedAt: (typeof modState?.startedAt === 'number' ? modState.startedAt : undefined)
      ?? (typeof record?.startedAt === 'number' ? record.startedAt : null),
    completedAt: typeof modState?.completedAt === 'number' ? modState.completedAt : null,
    runtimeState: { record, modState: modState ?? null },
  };
}
