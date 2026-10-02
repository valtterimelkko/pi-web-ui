// E2a-3 harness — production/disposable health-metrics parsing and phase summaries (arm 1 analysis).
// The health metrics file (~/.pi-web-ui/metrics/health-metrics.jsonl) carries one JSON object
// per line with atMs, lagP50Ms, lagP99Ms, lagMaxMs, mainThreadCpuPercentOfCore, activeTurns, …

/** Parse the JSONL health-metrics stream; malformed lines are skipped (rotation boundaries etc.). */
export function parseHealthJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object' && Number.isFinite(row.atMs)) rows.push(row);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

/** Rows with atMs in [t0Ms, t1Ms). */
export function sliceWindow(rows, t0Ms, t1Ms) {
  return rows.filter((r) => r.atMs >= t0Ms && r.atMs < t1Ms);
}

/** Nearest-rank percentile: sorted ascending, index ceil(p/100 * n) - 1. */
export function percentileNearestRank(values, p) {
  if (values.length === 0) throw new Error('percentile of empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/** Summarise one numeric field across rows: {n, p50, p99, max}. */
export function summariseField(rows, field) {
  const values = rows.map((r) => Number(r[field])).filter((v) => Number.isFinite(v));
  return {
    n: values.length,
    p50: percentileNearestRank(values, 50),
    p99: percentileNearestRank(values, 99),
    max: values.length ? Math.max(...values) : undefined,
  };
}

const FIELD_SHORT_NAMES = {
  lagP50Ms: 'lagP50',
  lagP99Ms: 'lagP99',
  lagMaxMs: 'lagMax',
  mainThreadCpuPercentOfCore: 'cpuMain',
};

/**
 * Summarise named phases: {before: [t0,t1], during: [t0,t1], after: [t0,t1]}.
 * Returns per phase {n, lagP50: {…}, lagP99: {…}, lagMax: {…}, cpuMain: {…}}.
 */
export function summarisePhases(rows, phases, fields = ['lagP50Ms', 'lagP99Ms', 'lagMaxMs', 'mainThreadCpuPercentOfCore']) {
  const out = {};
  for (const [name, [t0, t1]] of Object.entries(phases)) {
    const slice = sliceWindow(rows, t0, t1);
    const entry = { n: slice.length, window: [new Date(t0).toISOString(), new Date(t1).toISOString()] };
    for (const field of fields) entry[FIELD_SHORT_NAMES[field] ?? field] = summariseField(slice, field);
    out[name] = entry;
  }
  return out;
}
