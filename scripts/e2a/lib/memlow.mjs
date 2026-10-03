// E2a-3 harness — memory cgroup parsing + MemoryLow eviction-contrast summariser (arm 3).

const GiB = 1024 ** 3;

/** Parse a memory.current byte count. */
export function parseMemoryCurrent(text) {
  const trimmed = String(text ?? '').trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`not a byte count: ${JSON.stringify(text)}`);
  return Number(trimmed);
}

/** Parse a memory.stat file into a flat {key: bytes} map (numeric values only). */
export function parseMemoryStat(text) {
  const stat = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\S+)\s+(\d+)(?:\s+(?:[kK]|native)?\d*)?$/.exec(line.trim());
    if (m) stat[m[1]] = Number(m[2]);
  }
  return stat;
}

function ratio(a, b) {
  if (!Number.isFinite(b) || b === 0) return NaN;
  return a / b;
}

/**
 * Summarise the arm-3 contrast between the protected sibling (memory.low set,
 * plus ancestor lows) and the unprotected one. A crisp contrast OR a clearly
 * explained null are both acceptable outcomes; this reports which one the
 * numbers show, so an unexplained null can never pass silently.
 */
export function summariseMemoryLowContrast({ low, free }) {
  const notes = [];
  const lowRetained = ratio(low.fileBytes, low.currentBytes + Number.EPSILON);
  const freeRetained = ratio(free.fileBytes, free.currentBytes + Number.EPSILON);

  const lowSlowRatio = ratio(low.rereadMs, low.rereadBaselineMs);
  const freeSlowRatio = ratio(free.rereadMs, free.rereadBaselineMs);

  // Crisp = the protected sibling's re-read stays close to baseline (its file
  // cache survived), while the unprotected one loses cache and/or slows down.
  const lowProtected = Number.isFinite(lowSlowRatio) && lowSlowRatio < 1.5;
  const cacheGap = free.fileBytes < 0.5 * low.fileBytes || freeSlowRatio > 2 * lowSlowRatio + 0.25;

  if (lowProtected && cacheGap) {
    notes.push(`protected sibling kept ${fmt(low.fileBytes)} file cache (re-read ${low.rereadMs} ms vs baseline ${low.rereadBaselineMs} ms) — protected`);
    notes.push(`unprotected sibling fell to ${fmt(free.fileBytes)} file cache (re-read ${free.rereadMs} ms vs baseline ${free.rereadBaselineMs} ms) — evicted`);
    notes.push(`memory.events low counters: protected ${low.lowEvents}, unprotected ${free.lowEvents}`);
    return { crispContrast: true, notes, lowRetained, freeRetained };
  }

  notes.push('no contrast: both siblings behaved the same under parent-level reclaim');
  notes.push(`protected: current ${fmt(low.currentBytes)}, file ${fmt(low.fileBytes)}, anon ${fmt(low.anonBytes)}, events.low ${low.lowEvents}, re-read ${low.rereadMs} ms (baseline ${low.rereadBaselineMs} ms)`);
  notes.push(`unprotected: current ${fmt(free.currentBytes)}, file ${fmt(free.fileBytes)}, anon ${fmt(free.anonBytes)}, events.low ${free.lowEvents}, re-read ${free.rereadMs} ms (baseline ${free.rereadBaselineMs} ms)`);
  notes.push(`proportional reclaim accounting may fall on the hog (D0.md §7b finding 5 saw footprints land equal at 165/165 MB) — explain with the elow chain before treating this as a defect`);
  return { crispContrast: false, notes, lowRetained, freeRetained };
}

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= GiB) return `${(n / GiB).toFixed(2)} GiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
