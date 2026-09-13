/**
 * Harness state for relay authorisation (plan §10.9) and the operator's draft
 * (plan §4.2, interleaved composition): the accumulating verbatim record of
 * what the operator has said toward an instruction not yet released, the
 * confirmation window over it, and the release history.
 *
 * This is the module that makes a spoken "yes" safe rather than fragile: which
 * instruction a confirmation refers to is resolved HERE, by object reference —
 * never from conversation history, never by the model.
 *
 * Two objects, deliberately separated (plan §4.2):
 *
 *   - The DRAFT is the operator's composing thread. It accumulates verbatim
 *     parts held by object reference — never reconstructed from the utterance
 *     log window, never written by the model — and it is never expired,
 *     never silently replaced. It dies only two ways: released, or explicitly
 *     abandoned ("forget that").
 *   - The CONFIRMATION is the safety window. Ageing applies to it, not to the
 *     draft: when the operator has not touched the draft for
 *     maxPendingAgeTurns, the draft is marked needs-re-confirmation and the
 *     harness surfaces it — nothing is silently dropped, and nothing stale is
 *     released.
 *
 * The model has no write access to any of this state.
 */

const DEFAULT_UTTERANCE_LOG_LIMIT = 50;
const DEFAULT_MAX_PENDING_AGE_TURNS = 6;
const DEFAULT_RELEASED_HISTORY_LIMIT = 5;

export interface VerbatimUtterance {
  id: number;
  text: string;
  /** Talker turn index at which the operator said this. */
  turn: number;
  /** Set when a receipt ack (§4.1 rule 2) has covered this utterance. */
  acknowledged: boolean;
}

/** Which part of a multi-part draft a confirmation selects (§4.2 invariant 2). */
export type OrdinalPosition = 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'last';

export interface DraftSelection {
  kind: 'ordinal';
  position: OrdinalPosition;
}

/** One verbatim part of the operator's draft, held by object reference. */
export interface DraftUtteranceEntry {
  id: number;
  text: string;
  turn: number;
}

/** Harness view of the live draft (null when the operator is not composing). */
export interface DraftSnapshot {
  utterances: DraftUtteranceEntry[];
  ageTurns: number;
  needsReConfirmation: boolean;
}

/**
 * What a release consumes: verbatim text selected by id — never composed,
 * never paraphrased, never reconstructed from history.
 */
export interface TakenRelease {
  utteranceIds: number[];
  /** First released id — the anchor for release records (wire-stable shape). */
  utteranceId: number;
  text: string;
}

/** The draft's canonical verbatim text: parts joined in composition order. */
export function joinDraftText(utterances: ReadonlyArray<{ text: string }>): string {
  return utterances.map(u => u.text).join('\n');
}

/** Internal, mutable draft state. */
interface OperatorDraft {
  utterances: DraftUtteranceEntry[];
  createdTurn: number;
  /** Last turn the operator touched the draft (compose, select, re-confirm). */
  lastTouchedTurn: number;
  ageTurns: number;
  needsReConfirmation: boolean;
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
    const rec: VerbatimUtterance = { id: this.nextId++, text, turn, acknowledged: false };
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

  /** Recorded utterances not yet covered by a receipt ack (§4.1 rule 2). */
  unacknowledgedCount(): number {
    return this.records.reduce((n, r) => (r.acknowledged ? n : n + 1), 0);
  }

  /**
   * Atomically consume the receipt-ack condition (plan §4.1 rule 2): if any
   * recorded operator utterance is not yet acknowledged, mark the whole
   * outstanding set acknowledged and report ONE receipt due, returning how
   * many utterances it covers. Returns null when nothing is outstanding — so
   * the receipt fires at most once per relay, never once per utterance, and
   * repeated answer-ready moments cannot repeat it. Mirrors takeForRelease():
   * the condition is consumed by the take, not by observation.
   */
  takeReceipt(): number | null {
    const outstanding = this.records.filter(r => !r.acknowledged);
    if (outstanding.length === 0) return null;
    for (const rec of outstanding) rec.acknowledged = true;
    return outstanding.length;
  }
}

export class PendingProposalStore {
  /**
   * The operator's draft (§4.2). Held by object reference; never expires;
   * never silently replaced. Consumed only by takeForRelease() (release) and
   * cancel() (explicit abandon).
   */
  private draft: OperatorDraft | null = null;
  private released: ReleasedRecord[] = [];
  private readonly maxPendingAgeTurns: number;
  private readonly releasedHistoryLimit: number;

  constructor(opts?: { maxPendingAgeTurns?: number; releasedHistoryLimit?: number }) {
    this.maxPendingAgeTurns = opts?.maxPendingAgeTurns ?? DEFAULT_MAX_PENDING_AGE_TURNS;
    this.releasedHistoryLimit = opts?.releasedHistoryLimit ?? DEFAULT_RELEASED_HISTORY_LIMIT;
  }

  /**
   * Compatibility view for the wire's mechanical phase derivation (the
   * transport reads this store's `pending` truthiness to report 'proposed').
   * NOT the release source of truth — releases read the draft itself — and
   * never written by anyone.
   */
  get pending(): PendingProposal | null {
    const d = this.draft;
    if (!d || d.utterances.length === 0) return null;
    const last = d.utterances[d.utterances.length - 1];
    return {
      utteranceId: last.id,
      text: joinDraftText(d.utterances),
      createdTurn: d.createdTurn,
      ageTurns: d.ageTurns,
    };
  }

  get lastReleased(): ReleasedRecord | null {
    return this.released[this.released.length - 1] ?? null;
  }

  /** Harness view of the live draft, or null when the operator is not composing. */
  snapshotDraft(): DraftSnapshot | null {
    const d = this.draft;
    if (!d || d.utterances.length === 0) return null;
    return {
      utterances: d.utterances.map(u => ({ ...u })),
      ageTurns: d.ageTurns,
      needsReConfirmation: d.needsReConfirmation,
    };
  }

  /**
   * True when the draft's confirmation window has lapsed as of `turn` —
   * computed from the caller's turn, not the last stored tick, so the boundary
   * holds even for callers that never ticked. The DRAFT is fine; only its
   * confirmation is stale.
   */
  isLapsed(turn: number): boolean {
    const d = this.draft;
    if (!d) return false;
    return Math.max(d.ageTurns, turn - d.lastTouchedTurn) >= this.maxPendingAgeTurns;
  }

  /**
   * Append an operator utterance to the draft. Accumulates — never replaces:
   * a second utterance holds both (supersession is loud, §4.2). Appending is
   * fresh operator engagement, so it re-arms the confirmation window.
   */
  appendToDraft(utteranceId: number, text: string, turn: number): DraftSnapshot {
    if (!this.draft) {
      this.draft = {
        utterances: [{ id: utteranceId, text, turn }],
        createdTurn: turn,
        lastTouchedTurn: turn,
        ageTurns: 0,
        needsReConfirmation: false,
      };
    } else {
      this.draft.utterances.push({ id: utteranceId, text, turn });
      this.draft.lastTouchedTurn = turn;
      this.draft.ageTurns = 0;
      this.draft.needsReConfirmation = false;
    }
    return this.snapshotDraft() as DraftSnapshot;
  }

  /**
   * Re-arm the confirmation window after the harness has surfaced the lapsed
   * draft and asked the operator whether they still want it (plan §4.2). The
   * surfacing itself is the re-confirmation offer; a fresh confirmation
   * against it resolves to exactly the quoted draft.
   */
  markResurfaced(turn: number): void {
    const d = this.draft;
    if (!d) return;
    d.lastTouchedTurn = turn;
    d.ageTurns = 0;
    d.needsReConfirmation = false;
  }

  /**
   * Age the draft's confirmation at each turn boundary. Marks the draft
   * needs-re-confirmation when the window lapses; NEVER drops the draft —
   * an interleaved conversation cannot age the operator's unfinished
   * instruction out of existence (plan §4.2).
   */
  tickTurn(turn: number): void {
    const d = this.draft;
    if (!d) return;
    d.ageTurns = Math.max(d.ageTurns, turn - d.lastTouchedTurn);
    if (d.ageTurns >= this.maxPendingAgeTurns) d.needsReConfirmation = true;
  }

  /**
   * Atomically consume the draft (or a selected part of it) for release.
   *
   * Returns null — with the draft INTACT but marked needs-re-confirmation —
   * when the confirmation window has lapsed as of `turn`: the send boundary
   * itself enforces staleness, so no caller, however it reaches this method,
   * can release text the operator has not re-confirmed after a gap. The old
   * behaviour consumed the candidate on this refusal; that consumption is
   * exactly the silent drop §4.2 removes.
   *
   * Returns null when nothing is pending (a second "yes" after a release has
   * nothing to act on) and when a selection cannot be resolved to an existing
   * part (an ambiguous selection never acts and changes nothing).
   */
  takeForRelease(turn: number, selection?: DraftSelection): TakenRelease | null {
    const d = this.draft;
    if (!d || d.utterances.length === 0) return null;
    const age = Math.max(d.ageTurns, turn - d.lastTouchedTurn);
    if (age >= this.maxPendingAgeTurns) {
      d.ageTurns = age;
      d.needsReConfirmation = true;
      return null;
    }
    let selected: DraftUtteranceEntry[];
    let remaining: DraftUtteranceEntry[];
    if (selection) {
      const idx = resolveOrdinalIndex(selection.position, d.utterances.length);
      if (idx === null) return null; // ambiguous — never acts
      selected = [d.utterances[idx]];
      remaining = d.utterances.filter((_, i) => i !== idx);
    } else {
      selected = d.utterances;
      remaining = [];
    }
    // Atomic consume: what is taken here cannot be taken again. A subset
    // release leaves the rest of the draft held, still requiring its own
    // confirmation.
    if (remaining.length === 0) {
      this.draft = null;
    } else {
      d.utterances = remaining;
    }
    return {
      utteranceIds: selected.map(u => u.id),
      utteranceId: selected[0].id,
      text: joinDraftText(selected),
    };
  }

  /**
   * Whether a selection would resolve against the current draft. An
   * unresolved selection is ambiguous: the harness clarifies instead of
   * acting, and the draft is untouched (§4.2 invariant 6).
   */
  canResolveSelection(selection: DraftSelection): boolean {
    const d = this.draft;
    if (!d) return false;
    return resolveOrdinalIndex(selection.position, d.utterances.length) !== null;
  }

  /** Clear the whole draft (operator abandoned it). True if there was one. */
  cancel(_reason: string, _turn: number): boolean {
    const had = this.draft !== null;
    this.draft = null;
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

/** Resolve an ordinal position to an index into the draft; null when it selects nothing. */
function resolveOrdinalIndex(position: OrdinalPosition, count: number): number | null {
  if (count === 0) return null;
  if (position === 'last') return count - 1;
  const order: OrdinalPosition[] = ['first', 'second', 'third', 'fourth', 'fifth'];
  const idx = order.indexOf(position);
  if (idx < 0 || idx >= count) return null;
  return idx;
}
