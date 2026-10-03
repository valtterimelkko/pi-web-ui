/** Host samplers: /proc/meminfo, /proc/pressure, ps cgroup lines. */
import { readFileSync } from 'node:fs';
import { num } from './num.ts';

export function parseMemAvailableKb(meminfoText: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(meminfoText);
  return m ? Number(m[1]) : null;
}

export interface PressureWindow {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface PressureReading {
  some: PressureWindow;
  full: PressureWindow;
}

export function parsePressure(text: string): PressureReading {
  const parseLine = (line: string): PressureWindow => {
    const avg10 = num(Number(/avg10=([\d.]+)/.exec(line)?.[1]));
    const avg60 = num(Number(/avg60=([\d.]+)/.exec(line)?.[1]));
    const avg300 = num(Number(/avg300=([\d.]+)/.exec(line)?.[1]));
    return { avg10: avg10 ?? 0, avg60: avg60 ?? 0, avg300: avg300 ?? 0 };
  };
  const some = text.split('\n').find((l) => l.startsWith('some '));
  const full = text.split('\n').find((l) => l.startsWith('full '));
  return {
    some: some ? parseLine(some) : { avg10: 0, avg60: 0, avg300: 0 },
    full: full ? parseLine(full) : { avg10: 0, avg60: 0, avg300: 0 },
  };
}

export interface ProcRow {
  pid: number;
  cgroup: string;
  args: string;
}

/** One row of `ps -eo pid,cgroup,args -ww` (header skipped by the caller). */
export function parsePsCgroupLine(line: string): ProcRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isSafeInteger(pid)) return null;
  return { pid, cgroup: m[2] ?? '', args: m[3] ?? '' };
}

/** Processes whose cgroup path sits under `anchorFragment` (the placement proof). */
export function filterPlacedProcs(rows: ProcRow[], anchorFragment: string): ProcRow[] {
  return rows.filter((r) => r.cgroup.includes(anchorFragment));
}

export function readMemAvailableKb(): number | null {
  try {
    return parseMemAvailableKb(readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return null;
  }
}

export function readPressure(kind: 'cpu' | 'memory' | 'io'): PressureReading | null {
  try {
    return parsePressure(readFileSync(`/proc/pressure/${kind}`, 'utf8'));
  } catch {
    return null;
  }
}
