/**
 * Host-level pressure truth for execution admission.
 *
 * The service cgroup bounds only THIS process. Other host consumers (tmux,
 * external/stale agent processes, the kernel) sit outside it, so a service
 * cgroup can show ample headroom while the host is exhausted. This module
 * surfaces host-available memory and PSI (Pressure Stall Information) so the
 * admission layer can act on host-level pressure as a *separate* gate, and so
 * `/capacity` reports pressure truth that the cgroup alone cannot.
 *
 * Pure over injected inputs (`read`) for unit testing with virtual fixtures.
 * Never fabricates a value: missing/unreadable files surface as `undefined`.
 */
import { readFileSync } from 'fs';

export interface PressureAvg {
  /** 10s / 60s / 300s average percentage of time SOMETHING stalled. */
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface PsiResource {
  /** "some" = at least one task stalled; "full" = all tasks stalled. */
  some?: PressureAvg;
  full?: PressureAvg;
}

export interface ResolvedHostPressure {
  /** Host available memory (MemAvailable), when readable. */
  memAvailableBytes?: number;
  /** Host total memory (MemTotal), when readable. */
  memTotalBytes?: number;
  /** PSI summaries per resource, when readable. */
  psi?: { memory?: PsiResource; cpu?: PsiResource; io?: PsiResource };
  source: 'host';
}

export interface HostPressureOptions {
  /** Injectable file reader; returns contents or `undefined` when missing. */
  read?: (path: string) => string | undefined;
}

/** Parse one PSI line (`some avg10=.. avg60=.. avg300=.. total=..`). */
export function parsePsiLine(line: string | undefined): PressureAvg | undefined {
  if (!line) return undefined;
  const m = line.match(/avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/);
  if (!m) return undefined;
  const avg10 = Number(m[1]);
  const avg60 = Number(m[2]);
  const avg300 = Number(m[3]);
  if (![avg10, avg60, avg300].every(Number.isFinite)) return undefined;
  return { avg10, avg60, avg300 };
}

/** Extract a single `Key: <n> kB` value from meminfo → bytes. */
export function parseMemInfoKb(meminfo: string | undefined, key: string): number | undefined {
  if (!meminfo) return undefined;
  const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
  if (!m) return undefined;
  const kb = Number(m[1]);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined;
}

function readRealFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parsePsiFile(contents: string | undefined): PsiResource | undefined {
  if (!contents) return undefined;
  let some: PressureAvg | undefined;
  let full: PressureAvg | undefined;
  for (const line of contents.split('\n')) {
    if (line.startsWith('some')) some = parsePsiLine(line) ?? some;
    else if (line.startsWith('full')) full = parsePsiLine(line) ?? full;
  }
  if (!some && !full) return undefined;
  return { some, full };
}

/**
 * Resolve host-available memory + PSI summaries. Each field is `undefined`
 * when unreadable rather than fabricated.
 */
export function readHostPressure(options: HostPressureOptions = {}): ResolvedHostPressure {
  const read = options.read ?? readRealFile;
  const meminfo = read('/proc/meminfo');
  const memAvailableBytes = parseMemInfoKb(meminfo, 'MemAvailable');
  const memTotalBytes = parseMemInfoKb(meminfo, 'MemTotal');

  const memory = parsePsiFile(read('/proc/pressure/memory'));
  const cpu = parsePsiFile(read('/proc/pressure/cpu'));
  const io = parsePsiFile(read('/proc/pressure/io'));
  const psi = (memory || cpu || io) ? { memory, cpu, io } : undefined;

  return { memAvailableBytes, memTotalBytes, psi, source: 'host' };
}
