import type { SessionRuntime } from '../types.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('DeletedSessionCessation');

/**
 * Correction 01 (Luna r1 finding 2): a missing registry entry is not proof of
 * runtime cessation. DELETE aborts Claude/OpenCode/Antigravity without
 * awaiting termination (OpenCode even clears `runningSessions` before the
 * remote abort is acknowledged), so treating "session gone" as quiescent
 * released admission slots while work was still executing.
 *
 * This tracker gates the missing-session branch of the quiescence wiring:
 *   - an awaited per-runtime termination acknowledgement (Pi's awaited
 *     `disposeLoadedSession`, Command Code's awaited delete) is positive
 *     cessation evidence immediately;
 *   - every other deleted runtime is held for a bounded grace (default
 *     15 minutes) after the deletion was observed, then released exactly
 *     once with a `grace-release` log naming the runtime. No permanent
 *     leak, and a bounded false-release window.
 * A session that disappears without having been recorded deleted is held
 * (fail-closed): the tracker is process-local and every delete records.
 */
export interface DeletedSessionCessationOptions {
  now?: () => number;
  /** Bounded grace for non-awaiting runtimes. Default 15 minutes. */
  graceMs?: number;
  /** Log sink seam for tests. Default: the shared logger. */
  log?: (line: string) => void;
}

interface DeletedRecord {
  runtime: SessionRuntime;
  deletedAtMs: number;
  terminationAcked: boolean;
  graceReleaseLogged: boolean;
}

export const DELETION_CESSATION_GRACE_MS = 15 * 60 * 1000;

export class DeletedSessionCessation {
  private readonly records = new Map<string, DeletedRecord>();
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly log: (line: string) => void;

  constructor(options: DeletedSessionCessationOptions = {}) {
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? DELETION_CESSATION_GRACE_MS;
    this.log = options.log ?? ((line: string) => logger.warn(line));
  }

  /** Record a deletion observed by the delete/dispose path. */
  record(sessionId: string, runtime: SessionRuntime, terminationAcked: boolean): void {
    this.records.set(sessionId, {
      runtime,
      deletedAtMs: this.now(),
      terminationAcked,
      graceReleaseLogged: false,
    });
  }

  /**
   * Whether a deleted session's runtime has positive cessation evidence: an
   * awaited ack → immediately; otherwise only after the bounded grace (logged
   * once as a grace-release). Never-observed sessions are held.
   */
  isQuiescent(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false; // fail-closed: deletion never observed
    if (record.terminationAcked) return true;
    if (this.now() - record.deletedAtMs < this.graceMs) return false;
    if (!record.graceReleaseLogged) {
      record.graceReleaseLogged = true;
      this.log(
        `grace-release: runtime=${record.runtime} session=${sessionId} released from the deletion cessation fence after ${this.graceMs}ms grace (no awaited termination acknowledgement)`,
      );
    }
    return true;
  }
}
