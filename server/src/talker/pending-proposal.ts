/**
 * Harness state for relay authorisation (plan §10.9): the pending proposal,
 * the verbatim operator utterance it refers to, and the release history.
 *
 * This is the module that makes a spoken "yes" safe rather than fragile: which
 * instruction a confirmation refers to is resolved HERE, by object reference —
 * never from conversation history, never by the model.
 *
 * Design note (H1): the candidate is the most recent unreleased operator
 * utterance. A confirmation releases it verbatim. The model has no write
 * access to any of this state.
 */

const DEFAULT_UTTERANCE_LOG_LIMIT = 50;
const DEFAULT_MAX_PENDING_AGE_TURNS = 6;
const DEFAULT_RELEASED_HISTORY_LIMIT = 5;

export interface VerbatimUtterance {
  id: number;
  text: string;
  /** Talker turn index at which the operator said this. */
  turn: number;
}

export interface PendingProposal {
  utteranceId: number;
  /** The operator's verbatim words — exactly what a confirmation releases. */
  text: string;
  createdTurn: number;
  ageTurns: number;
}

export interface ReleasedRecord {
  utteranceId: number;
  text: string;
  /** Human-readable delivery outcome, e.g. "delivered (steer)". */
  outcome: string;
  turn: number;
}

/** Bounded server-side verbatim log of the operator's own utterances. */
export class UtteranceLog {
  private records: VerbatimUtterance[] = [];
  private nextId = 1;
  private readonly limit: number;

  constructor(opts?: { limit?: number }) {
    this.limit = opts?.limit ?? DEFAULT_UTTERANCE_LOG_LIMIT;
  }

  record(text: string, turn: number): VerbatimUtterance {
    const rec: VerbatimUtterance = { id: this.nextId++, text, turn };
    this.records.push(rec);
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit);
    }
    return rec;
  }

  resolve(id: number): VerbatimUtterance | null {
    return this.records.find(r => r.id === id) ?? null;
  }

  recent(n: number): VerbatimUtterance[] {
    return this.records.slice(-n);
  }

  get size(): number {
    return this.records.length;
  }
}

export class PendingProposalStore {
  private current: PendingProposal | null = null;
  private released: ReleasedRecord[] = [];
  private readonly maxPendingAgeTurns: number;
  private readonly releasedHistoryLimit: number;

  constructor(opts?: { maxPendingAgeTurns?: number; releasedHistoryLimit?: number }) {
    this.maxPendingAgeTurns = opts?.maxPendingAgeTurns ?? DEFAULT_MAX_PENDING_AGE_TURNS;
    this.releasedHistoryLimit = opts?.releasedHistoryLimit ?? DEFAULT_RELEASED_HISTORY_LIMIT;
  }

  get pending(): PendingProposal | null {
    return this.current;
  }

  get lastReleased(): ReleasedRecord | null {
    return this.released[this.released.length - 1] ?? null;
  }

  /**
   * Record an operator utterance as the candidate a confirmation would
   * release. Replaces any existing candidate: the most recent instruction is
   * the one a "yes" refers to.
   */
  recordCandidate(text: string, turn: number, utteranceId: number): void {
    this.current = { utteranceId, text, createdTurn: turn, ageTurns: 0 };
  }

  /** Age the live candidate at each turn boundary; expire stale ones. */
  tickTurn(turn: number): void {
    if (!this.current) return;
    this.current.ageTurns = turn - this.current.createdTurn;
    if (this.current.ageTurns >= this.maxPendingAgeTurns) {
      this.current = null;
    }
  }

  /**
   * Atomically consume the pending proposal for release. Returns null when
   * nothing is pending — a second "yes" after a release has nothing to act
   * on — and null when the candidate has outlived its lifetime, even if no
   * tick ever observed it. The send boundary itself enforces staleness: no
   * caller, however it reaches this method, can release an aged proposal.
   */
  takeForRelease(turn: number): PendingProposal | null {
    const pending = this.current;
    this.current = null;
    if (!pending) return null;
    // Age at release time — computed from the caller's turn, not the last
    // stored tick, so the boundary holds even for callers that never ticked.
    const age = Math.max(pending.ageTurns, turn - pending.createdTurn);
    if (age >= this.maxPendingAgeTurns) return null;
    return pending;
  }

  /** Clear the pending proposal (operator cancelled). True if there was one. */
  cancel(_reason: string, _turn: number): boolean {
    const had = this.current !== null;
    this.current = null;
    return had;
  }

  recordReleased(rec: ReleasedRecord): void {
    this.released.push(rec);
    if (this.released.length > this.releasedHistoryLimit) {
      this.released.splice(0, this.released.length - this.releasedHistoryLimit);
    }
  }

  releasedHistory(): ReleasedRecord[] {
    return [...this.released];
  }
}
