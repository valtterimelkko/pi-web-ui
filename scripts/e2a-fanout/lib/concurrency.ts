/**
 * 08-correction Phase 2: own-work concurrency from receipt intervals.
 * The same sweep method as the parent's/reviewer's recomputation: an interval
 * is open at its start and closed at its end ([start, end)); the peak is the
 * maximum number of simultaneously open intervals, with the instant it occurs.
 */
export interface ReceiptInterval {
  start: number;
  end: number;
}

export interface ConcurrencyPeak {
  peak: number;
  at: number | null;
}

export function peakConcurrentOwnTurns(intervals: ReceiptInterval[]): ConcurrencyPeak {
  const events: Array<{ t: number; delta: number }> = [];
  for (const iv of intervals) {
    events.push({ t: iv.start, delta: 1 });
    events.push({ t: iv.end, delta: -1 });
  }
  // Ends sort before starts at the same instant (interval closed at end).
  events.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.delta - b.delta));
  let open = 0;
  let peak = 0;
  let at: number | null = null;
  for (const e of events) {
    open += e.delta;
    if (open > peak) {
      peak = open;
      at = e.t;
    }
  }
  return { peak, at: intervals.length > 0 ? at : null };
}
