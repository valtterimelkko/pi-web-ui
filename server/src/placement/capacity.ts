/**
 * D0 tools-slice telemetry reader: pure over an injected `read` so admission and the
 * observability sampler can be tested without a real cgroup tree, and so a missing
 * slice is reported as `unavailable` rather than fabricated (the repo's fail-open
 * cgroup-reading convention, cf. internal-api/cgroup-capacity.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlacementConfig } from './config.js';

export interface ToolsSliceMemory {
  currentBytes?: number;
  highBytes?: number;
  maxBytes?: number;
  oomKill?: number;
  highEvents?: number;
  source: 'tools-slice' | 'unavailable';
}

export type CgroupFileRead = (file: string) => string | undefined;

export function realCgroupRead(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parseMetric(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (!t || t === 'max') return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseEventCounter(events: string, key: string): number | undefined {
  const m = events.match(new RegExp(`^${key}\\s+(\\d+)`, 'm'));
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function readToolsSliceMemory(cfg: PlacementConfig, read: CgroupFileRead = realCgroupRead): ToolsSliceMemory {
  const base = cfg.toolsRoot;
  if (!base) return { source: 'unavailable' };
  const current = parseMetric(read(path.join(base, 'memory.current')));
  const max = parseMetric(read(path.join(base, 'memory.max')));
  if (current === undefined && max === undefined) return { source: 'unavailable' };
  const events = read(path.join(base, 'memory.events'));
  return {
    source: 'tools-slice',
    currentBytes: current,
    highBytes: parseMetric(read(path.join(base, 'memory.high'))),
    maxBytes: max,
    oomKill: events === undefined ? undefined : parseEventCounter(events, 'oom_kill'),
    highEvents: events === undefined ? undefined : parseEventCounter(events, 'high'),
  };
}

/** Count degrade lines appended by the wrapper / bash prefix line since server start. */
export function readDegradeCount(degradeFile: string, read: CgroupFileRead = realCgroupRead): number | null {
  const raw = read(degradeFile);
  if (raw === undefined) return 0;
  return raw.split('\n').filter((l) => l.trim().length > 0).length;
}

/** Append one degrade line (the "alarm loudly" signal); never throws. */
export function appendDegradeLine(cfg: PlacementConfig, group: string, reason: string): void {
  try {
    fs.mkdirSync(cfg.runtimeDir, { recursive: true });
    fs.appendFileSync(
      path.join(cfg.runtimeDir, 'degrade.log'),
      `${new Date().toISOString()} ${group} ${reason}\n`,
    );
  } catch {
    /* degrade recording must never break the caller */
  }
}
