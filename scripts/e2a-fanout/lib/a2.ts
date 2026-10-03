/** Parsing for the server's health-metrics JSONL (A2 telemetry). */
import type { A2Sample } from './types.ts';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse one JSONL line; returns null for junk (never throws). */
export function parseA2Line(line: string): A2Sample | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  let atMs = num(raw['atMs']);
  if (atMs === null && typeof raw['at'] === 'string') {
    const parsed = Date.parse(raw['at'] as string);
    if (Number.isFinite(parsed)) atMs = parsed;
  }
  if (atMs === null) return null;
  return {
    atMs,
    lagP50Ms: num(raw['lagP50Ms']),
    lagP99Ms: num(raw['lagP99Ms']),
    lagMaxMs: num(raw['lagMaxMs']),
    activeTurns: num(raw['activeTurns']),
    heapUsedBytes: num(raw['heapUsedBytes']),
    heapLimitBytes: num(raw['heapLimitBytes']),
    mainThreadCpuPercentOfCore: num(raw['mainThreadCpuPercentOfCore']),
    toolsSliceMemoryBytes: num(raw['toolsSliceMemoryBytes']),
  };
}

/** Parse a whole JSONL document, skipping junk lines. */
export function parseA2Jsonl(text: string): A2Sample[] {
  const out: A2Sample[] = [];
  for (const line of text.split('\n')) {
    const sample = parseA2Line(line);
    if (sample) out.push(sample);
  }
  return out;
}

export interface A2WindowSummary {
  count: number;
  lagP50MaxMs: number | null;
  lagP99MaxMs: number | null;
  lagMaxMs: number | null;
  maxActiveTurns: number | null;
  heapUsedMaxBytes: number | null;
  mainThreadCpuMaxPercentOfCore: number | null;
  toolsMemMaxBytes: number | null;
}

function maxOf(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

/** Summarise A2 samples inside [fromMs, toMs] (inclusive bounds on atMs). */
export function summariseA2(samples: A2Sample[], fromMs?: number, toMs?: number): A2WindowSummary {
  const inWindow = samples.filter((s) => (fromMs === undefined || s.atMs >= fromMs) && (toMs === undefined || s.atMs <= toMs));
  return {
    count: inWindow.length,
    lagP50MaxMs: maxOf(inWindow.map((s) => s.lagP50Ms)),
    lagP99MaxMs: maxOf(inWindow.map((s) => s.lagP99Ms)),
    lagMaxMs: maxOf(inWindow.map((s) => s.lagMaxMs)),
    maxActiveTurns: maxOf(inWindow.map((s) => s.activeTurns)),
    heapUsedMaxBytes: maxOf(inWindow.map((s) => s.heapUsedBytes)),
    mainThreadCpuMaxPercentOfCore: maxOf(inWindow.map((s) => s.mainThreadCpuPercentOfCore)),
    toolsMemMaxBytes: maxOf(inWindow.map((s) => s.toolsSliceMemoryBytes)),
  };
}
