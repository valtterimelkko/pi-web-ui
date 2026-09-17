/**
 * The RELEASE object (Voice Mode execution plan, Phase 2 / Track A).
 *
 * One authorised delivery of exactly one proposal, with an idempotency key, a
 * target lane, a delivery outcome and a receipt timestamp (intent §16.4).
 *
 * APPEND-ONLY. Records are never edited or removed; a returned record is a
 * copy, and the store keeps the original. A confirmation that arrives twice
 * must never produce a second delivery: `record` refuses a proposal (or an
 * idempotency key) that already has a release — the duplicate confirmation is
 * answered with `duplicate_refusal` by the kernel, and this module is the last
 * line of that defence.
 *
 * UNKNOWN IS FIRST-CLASS. A timeout after submission is not a refusal:
 * `needsReconciliation()` reports every release whose latest outcome is
 * `unknown`, and `reconcile()` resolves it by appending a further record that
 * carries the same identity and points back at the unknown receipt. Blind
 * retries are therefore never the answer, and the unknown history survives.
 *
 * Pure in-memory, client-neutral (D7): no DOM/window, no transport, no I/O.
 */

export type ReleaseOutcome =
  | { status: 'delivered'; mechanism?: string; disclosure?: string }
  | { status: 'queued'; disclosure: string }
  | { status: 'refused'; reason: string }
  | { status: 'unknown'; reason: string };

export interface ReleaseRecord {
  proposalId: string;
  /** The proposal identity's content hash — the bytes this release carried. */
  sha256: string;
  idempotencyKey: string;
  targetLane: string;
  deliveryOutcome: ReleaseOutcome;
  receiptTimestamp: number;
  /**
   * Set on a reconciliation record only: the `receiptTimestamp` of the
   * `unknown` outcome it resolves. The unknown record itself stays in the log.
   */
  reconciledFrom?: number;
}

export type ReleaseRecordInput = Omit<ReleaseRecord, 'reconciledFrom'>;

/** A release already exists for this proposal or idempotency key. */
export class DuplicateReleaseError extends Error {
  readonly code = 'duplicate_release';

  constructor(proposalId: string, idempotencyKey: string) {
    super(`Duplicate release refused: proposal '${proposalId}' or key '${idempotencyKey}' was already released.`);
    this.name = 'DuplicateReleaseError';
  }
}

/** A reconciliation was attempted for a key that has no unknown outcome. */
export class ReconciliationStateError extends Error {
  readonly code = 'reconciliation_state';

  constructor(idempotencyKey: string, detail: string) {
    super(`Reconciliation refused for '${idempotencyKey}': ${detail}`);
    this.name = 'ReconciliationStateError';
  }
}

export class ReleaseNotFoundError extends Error {
  readonly code = 'release_not_found';

  constructor(idempotencyKey: string) {
    super(`No release recorded for idempotency key '${idempotencyKey}'.`);
    this.name = 'ReleaseNotFoundError';
  }
}

function copyRecord(rec: ReleaseRecord): ReleaseRecord {
  return { ...rec, deliveryOutcome: { ...rec.deliveryOutcome } };
}

export class ReleaseStore {
  private records: ReleaseRecord[] = [];

  /** True when this proposal has already been released (any outcome). */
  hasReleaseFor(proposalId: string): boolean {
    return this.records.some(rec => rec.proposalId === proposalId);
  }

  /** True when this idempotency key has already been used. */
  hasIdempotencyKey(idempotencyKey: string): boolean {
    return this.records.some(rec => rec.idempotencyKey === idempotencyKey);
  }

  /**
   * Append one release outcome. Throws `DuplicateReleaseError` when the
   * proposal or the idempotency key already has a record — an append-only
   * log that is idempotent by construction.
   */
  record(input: ReleaseRecordInput): ReleaseRecord {
    if (this.hasReleaseFor(input.proposalId) || this.hasIdempotencyKey(input.idempotencyKey)) {
      throw new DuplicateReleaseError(input.proposalId, input.idempotencyKey);
    }
    return this.append(input);
  }

  /** The most recent record for an idempotency key, or null. */
  latest(idempotencyKey: string): ReleaseRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].idempotencyKey === idempotencyKey) return copyRecord(this.records[i]);
    }
    return null;
  }

  /** The most recent record for a proposal, or null (the duplicate-confirmation receipt). */
  findByProposal(proposalId: string): ReleaseRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].proposalId === proposalId) return copyRecord(this.records[i]);
    }
    return null;
  }

  /**
   * Every release whose LATEST outcome is `unknown` — i.e. every delivery
   * that requires reconciliation rather than a blind retry.
   */
  needsReconciliation(): ReleaseRecord[] {
    const latestByKey = new Map<string, ReleaseRecord>();
    for (const rec of this.records) latestByKey.set(rec.idempotencyKey, rec);
    return [...latestByKey.values()]
      .filter(rec => rec.deliveryOutcome.status === 'unknown')
      .map(copyRecord);
  }

  /**
   * Resolve an unknown outcome by appending a reconciliation record that
   * carries the same identity. Refused when the key has no release, when the
   * latest outcome is not `unknown` (already settled), or when the requested
   * outcome is itself `unknown`.
   */
  reconcile(input: {
    idempotencyKey: string;
    deliveryOutcome: Exclude<ReleaseOutcome, { status: 'unknown' }>;
    receiptTimestamp: number;
  }): ReleaseRecord {
    const latest = this.latest(input.idempotencyKey);
    if (!latest) throw new ReleaseNotFoundError(input.idempotencyKey);
    if (latest.deliveryOutcome.status !== 'unknown') {
      throw new ReconciliationStateError(
        input.idempotencyKey,
        `latest outcome is '${latest.deliveryOutcome.status}', not 'unknown'`
      );
    }
    return this.append({
      proposalId: latest.proposalId,
      sha256: latest.sha256,
      idempotencyKey: latest.idempotencyKey,
      targetLane: latest.targetLane,
      deliveryOutcome: input.deliveryOutcome,
      receiptTimestamp: input.receiptTimestamp,
      reconciledFrom: latest.receiptTimestamp,
    });
  }

  /** The whole log, oldest first, as copies. */
  history(): ReleaseRecord[] {
    return this.records.map(copyRecord);
  }

  private append(rec: ReleaseRecord): ReleaseRecord {
    this.records.push(rec);
    return copyRecord(rec);
  }
}
