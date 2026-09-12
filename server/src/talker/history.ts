/**
 * Bounded rolling conversation history (plan §10.9, non-negotiable 6).
 *
 * Rules, all structural:
 *   - Entries are whole turns; trimming only ever drops whole oldest entries
 *     (a turn boundary), never mid-exchange.
 *   - While a proposal is alive the history may only trim down to a generous
 *     pending floor — the propose→confirm window is protected far beyond any
 *     realistic gap, while growth stays bounded (a chatter-heavy conversation
 *     where every utterance is a candidate must not grow without bound).
 *   - With nothing pending, the window trims to the tight floor.
 *   - No LLM summariser in v1: a dropped turn is a visible absence; a bad
 *     summary is a silent, persistent failure (plan §10.9).
 */

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  kind: 'operator' | 'talker' | 'mechanical';
  turn: number;
}

export interface TalkerHistoryOptions {
  /** Trim trigger with nothing pending. */
  maxEntries?: number;
  /** Trim target with nothing pending. */
  keepEntries?: number;
  /** Trim trigger while a proposal is alive. */
  maxEntriesWhenPending?: number;
  /** Trim target while a proposal is alive. */
  keepEntriesWhenPending?: number;
}

const DEFAULTS = {
  maxEntries: 30,
  keepEntries: 16,
  maxEntriesWhenPending: 60,
  keepEntriesWhenPending: 40,
} as const;

export class TalkerHistory {
  private list: HistoryEntry[] = [];
  private readonly opts;

  constructor(opts?: TalkerHistoryOptions) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  append(entry: HistoryEntry): void {
    this.list.push(entry);
  }

  entries(): readonly HistoryEntry[] {
    return this.list;
  }

  get length(): number {
    return this.list.length;
  }

  /**
   * Trim at a turn boundary. `hasPending` must reflect the live proposal at
   * this boundary. Returns the number of entries dropped.
   */
  maybeTrim(hasPending: boolean): number {
    const max = hasPending ? this.opts.maxEntriesWhenPending : this.opts.maxEntries;
    const keep = hasPending ? this.opts.keepEntriesWhenPending : this.opts.keepEntries;
    if (this.list.length <= max) return 0;
    const target = Math.max(0, Math.min(keep, max));
    const drop = this.list.length - target;
    if (drop <= 0) return 0;
    this.list.splice(0, drop);
    return drop;
  }
}
