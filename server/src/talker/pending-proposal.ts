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
 * P25 — semi-verbatim relay: draft parts carry the RELAY text (the
 * operator's own words minus the channel and the disfluency, normalised
 * mechanically by relay-normalise.ts at append time — the model never
 * produces relay text), while the verbatim log below keeps the raw words
 * byte-for-byte and each part keeps `originalText` as the reversible record.
 *
 * Two objects, deliberately separated (plan §4.2):
 *
 *   - The DRAFT is the operator's composing thread. It accumulates the
 *     operator's parts held by object reference (P25: each part in relay
 *     form — see above) — never reconstructed from the utterance
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

import { normaliseRelayText, relayHasVisibleRemoval, repairRelaySeams, visibleRemovalFragments } from './relay-normalise.js';

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

/**
 * One part of the operator's draft, held by object reference. P25: `text` is
 * the RELAY text — the operator's own words minus the channel and the
 * disfluency (mechanically normalised at append time by relay-normalise.ts,
 * removal-only, model-free) — so the card shows exactly what a confirmation
 * will release. `originalText` keeps the operator's raw words when the
 * normalisation removed anything: the reversible record, so the original is
 * always recoverable. Absent when the part is stored byte-identical to what
 * was spoken.
 */
export interface DraftUtteranceEntry {
  id: number;
  text: string;
  turn: number;
  originalText?: string;
  /**
   * The exact pieces the relay normalisation removed when this part was
   * appended (relay-normalise.ts). Kept beside `originalText` so the card's
   * "taken out of your words" note can show the FRAGMENTS the harness
   * actually removed — never the operator's whole utterance. Empty/absent
   * when the part was stored byte-identical.
   */
  removals?: string[];
}

/**
 * Which bytes a release sends (card-contract brief, D2/R6/R7):
 *   - 'tidied'   the default — the relay text the card quoted;
 *   - 'original' the operator's raw words per part (`originalText ?? text`),
 *                reachable only through the confirm gesture.
 */
export type ReleaseVariant = 'tidied' | 'original';

/**
 * The card payload a `proposed` turn reports (R1–R5). Built by a pure helper
 * so the seam is unit-testable without the WebSocket handler, and so the
 * release path uses the same joins BY CONSTRUCTION.
 */
export interface ProposalDescriptor {
  /** The exact bytes a default Confirm releases (unchanged semantics). */
  text: string;
  /** True IFF tidying removed VISIBLE content. */
  cleaned: boolean;
  /** The removed FRAGMENTS only, joined — present only when cleaned. */
  removed?: string;
  /** The raw bytes an original-variant release sends — present only when cleaned. */
  original?: string;
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

/**
 * The draft's canonical relay text: parts joined in composition order (P25:
 * each part carries the RELAY text — the operator's words minus channel and
 * disfluency, normalised mechanically at draft time — so what a confirmation
 * releases is byte-identical to what the card showed).
 */
export function joinDraftText(utterances: ReadonlyArray<{ text: string }>): string {
  return utterances.map(u => u.text).join('\n');
}

/**
 * The draft's ORIGINAL text (R3): the same parts in the same order, each
 * `originalText ?? text`, joined with the same separator as the relay text —
 * exactly the bytes an 'original' release sends. A part with nothing removed
 * has no `originalText`; its raw words ARE its relay text.
 */
export function joinOriginalDraftText(
  utterances: ReadonlyArray<{ text: string; originalText?: string }>
): string {
  return utterances.map(u => u.originalText ?? u.text).join('\n');
}

/**
 * R1–R5 — the pure proposal descriptor.
 *
 * R1: `cleaned` is true iff at least one recorded removal contains a
 * non-whitespace character. A whitespace-only normalisation (trimmed trailing
 * newline, collapsed double space, closed space before punctuation) is NOT a
 * tidy, so the card's "your words, exactly" claim stays true.
 * R2: `removed` carries the recorded FRAGMENTS, visible ones only, joined —
 * never the whole utterance.
 * R3: `original` is the raw bytes an original-variant release sends, present
 * only when cleaned (there is a meaningful choice only then).
 * R4: nothing is invented — every field comes from bytes the store holds.
 */
export function describeProposal(utterances: readonly DraftUtteranceEntry[]): ProposalDescriptor {
  const text = joinDraftText(utterances);
  const removals = utterances.flatMap(u => u.removals ?? []);
  if (!relayHasVisibleRemoval(removals)) {
    // Byte-level change without a visible removal: not a tidy.
    return { text, cleaned: false };
  }
  const fragments = utterances.flatMap(u => visibleRemovalFragments(u.removals ?? []));
  const descriptor: ProposalDescriptor = { text, cleaned: true, original: joinOriginalDraftText(utterances) };
  if (fragments.length > 0) {
    // Joined once, with the same seam semantics the relay text itself gets,
    // so the note reads as the words that left rather than as raw strips.
    descriptor.removed = repairRelaySeams(fragments.join(' '));
  }
  return descriptor;
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
  /** The relay text (P25) — exactly what the card showed and what a
   *  confirmation releases. */
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
   *
   * P25 — the single choke point of the semi-verbatim relay: the part stores
   * the RELAY text — the operator's own words minus the channel and the
   * disfluency (relay-normalise.ts: mechanical, removal-only, model-free) —
   * so the transform happens BEFORE approval. The confirmation card, the
   * mechanical re-confirmation quote and the release all read this one text:
   * released bytes are byte-identical to the bytes the card showed, by
   * construction. The raw words stay in the verbatim log and in the part's
   * `originalText` (the reversible record); a clean utterance is stored
   * byte-identical and carries no `originalText`.
   */
  appendToDraft(utteranceId: number, text: string, turn: number): DraftSnapshot {
    const relay = normaliseRelayText(text);
    const entry: DraftUtteranceEntry = relay.changed
      ? { id: utteranceId, text: relay.text, turn, originalText: text, removals: relay.removals }
      : { id: utteranceId, text, turn };
    if (!this.draft) {
      this.draft = {
        utterances: [entry],
        createdTurn: turn,
        lastTouchedTurn: turn,
        ageTurns: 0,
        needsReConfirmation: false,
      };
    } else {
      this.draft.utterances.push(entry);
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
   *
   * `variant` (card-contract brief, R7) chooses WHICH bytes the one release
   * path sends: 'tidied' (default) is the relay text the card quoted;
   * 'original' is the raw bytes per part (`originalText ?? text`, same join).
   * The gates are identical either way — a lapsed draft, an ambiguous
   * selection and an empty draft refuse exactly as before.
   */
  takeForRelease(
    turn: number,
    selection?: DraftSelection,
    variant: ReleaseVariant = 'tidied'
  ): TakenRelease | null {
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
      text: variant === 'original' ? joinOriginalDraftText(selected) : joinDraftText(selected),
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
