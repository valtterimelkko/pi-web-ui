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
 *
 * Correction 02 (Luna r2 new finding 1): records are RETIRED — once no
 * active or draining receipt for the session can still consult the record
 * (`hasConsultant`, manager-backed) the record is removed: an acked delete
 * with no consultant is retired at once, and a grace-released record is
 * removed after its release. Retirement keeps the map bounded for the
 * server's lifetime without ever stranding a second quarantined run of the
 * same deleted session (any such run keeps the consultant predicate true).
 */
export interface DeletedSessionCessationOptions {
  now?: () => number;
  /** Bounded grace for non-awaiting runtimes. Default 15 minutes. */
  graceMs?: number;
  /** Log sink seam for tests. Default: the shared logger. */
  log?: (line: string) => void;
  /**
   * Correction 02: whether any receipt (non-terminal run, or a draining /
   * quarantined entry) for this session can still consult its record.
   * Manager-backed in the wiring; a test may inject a fixed answer.
   * Default `() => true` (conservative: never retire for want of a consultant).
   */
  hasConsultant?: (sessionId: string) => boolean;
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
  private readonly hasConsultant: (sessionId: string) => boolean;

  constructor(options: DeletedSessionCessationOptions = {}) {
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? DELETION_CESSATION_GRACE_MS;
    this.log = options.log ?? ((line: string) => logger.warn(line));
    this.hasConsultant = options.hasConsultant ?? (() => true);
  }

  /** Record a deletion observed by the delete/dispose path. */
  record(sessionId: string, runtime: SessionRuntime, terminationAcked: boolean): void {
    // Correction 02 (+ parent verification): a delete that no receipt can
    // consult — acked or not — is never recorded: nothing would ever read it,
    // so it would only grow the map for the server's lifetime (the common case
    // is deleting an idle Claude/Antigravity child). Records whose consultant
    // settled through another path are pruned here too.
    this.pruneUnconsulted();
    if (!this.hasConsultant(sessionId)) {
      this.records.delete(sessionId);
      return;
    }
    this.records.set(sessionId, {
      runtime,
      deletedAtMs: this.now(),
      terminationAcked,
      graceReleaseLogged: false,
    });
  }

  /** Drop every record that no receipt can consult any more. */
  private pruneUnconsulted(): void {
    for (const id of Array.from(this.records.keys())) {
      if (!this.hasConsultant(id)) this.records.delete(id);
    }
  }

  /** Correction 02: whether a deletion record is currently held for a session. */
  has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  /** Correction 02: bounded-growth evidence — how many records are held. */
  retainedCount(): number {
    return this.records.size;
  }

  /**
   * Whether a deleted session's runtime has positive cessation evidence: an
   * awaited ack → immediately; otherwise only after the bounded grace (logged
   * once as a grace-release). Never-observed sessions are held.
   *
   * Correction 02: each consult also retires the record when no receipt can
   * consult it any more — acked records after answering, grace-pending ones
   * kept until their release, and past-grace ones removed with the release
   * decision they had reached (never re-released after retirement).
   */
  isQuiescent(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false; // fail-closed: deletion never observed
    const consultant = this.hasConsultant(sessionId);
    if (record.terminationAcked) {
      if (!consultant) this.records.delete(sessionId);
      return true;
    }
    if (this.now() - record.deletedAtMs < this.graceMs) return false;
    if (!record.graceReleaseLogged) {
      record.graceReleaseLogged = true;
      this.log(
        `grace-release: runtime=${record.runtime} session=${sessionId} released from the deletion cessation fence after ${this.graceMs}ms grace (no awaited termination acknowledgement)`,
      );
    }
    if (!consultant) this.records.delete(sessionId);
    return true;
  }
}
