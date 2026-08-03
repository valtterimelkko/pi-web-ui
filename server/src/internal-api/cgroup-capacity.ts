/**
 * cgroup-v2 memory resolution for execution admission.
 *
 * The admission/capacity surface must report the memory that actually bounds THIS
 * process — its nested systemd service cgroup (e.g. `/system.slice/pi-web-ui.service`) —
 * not the cgroup-root or host aggregate. Reading the root previously made `/capacity`
 * advertise a host-sized limit while the real service lived under a much smaller
 * `MemoryMax`, which could amplify load by telling callers unsafe headroom exists.
 *
 * The resolver is pure over injected inputs (`selfCgroup`, `cgroupRoot`, `read`) so it
 * can be unit-tested with virtual filesystem fixtures, and it never fabricates a numeric
 * limit: `memory.max = max`, missing, or invalid telemetry falls back to the next source.
 */
import { readFileSync } from 'fs';
import { totalmem } from 'os';

export type CgroupMemorySource = 'service' | 'root' | 'process-rss';

export interface ResolvedMemoryCapacity {
  currentBytes: number;
  limitBytes: number;
  /** Memory.high (soft pressure boundary) when readable. */
  highBytes?: number;
  /** Where the numbers came from, so callers can act conservatively when it is not the service cgroup. */
  source: CgroupMemorySource;
}

export interface ResolvedPidsCapacity {
  current?: number;
  max?: number;
  source: CgroupMemorySource;
}

export interface CgroupResolverOptions {
  /** Injected `/proc/self/cgroup` contents. Defaults to the real file. */
  selfCgroup?: string;
  /** cgroup-v2 mount root. Default `/sys/fs/cgroup`. */
  cgroupRoot?: string;
  /** Injectable file reader returning file contents or `undefined` when missing/unreadable. */
  read?: (path: string) => string | undefined;
}

/** Default cgroup-v2 mount root. */
export const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';

/**
 * Parse a cgroup-v2 unified self line (`0::/path`) into the cgroup path.
 * Returns `undefined` for cgroup-v1 content, empty input, or any path containing
 * parent-directory traversal.
 */
export function parseSelfCgroupV2(line: string | undefined): string | undefined {
  if (!line) return undefined;
  for (const raw of line.split('\n')) {
    const match = raw.trim().match(/^0::(.*)$/);
    if (match) {
      const path = match[1];
      if (path && !path.includes('..')) return path;
    }
  }
  return undefined;
}

/**
 * Join the cgroup root with a relative cgroup path, rejecting anything that would
 * escape the root (traversal or an absolute hijack). Returns the safe filesystem path
 * or `undefined`.
 */
export function resolveCgroupFsPath(cgroupRoot: string, relative: string | undefined): string | undefined {
  if (!relative || relative.includes('..')) return undefined;
  const root = cgroupRoot.replace(/\/+$/, '');
  if (!root) return undefined;
  const joined = `${root}/${relative.replace(/^\/+/, '')}`;
  // Defence in depth: the resolved path must remain beneath the root.
  if (joined !== root && !joined.startsWith(`${root}/`)) return undefined;
  return joined;
}

/** Parse a cgroup metric file value. `max`, blank, or non-numeric → `undefined`. */
function readMetric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'max') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readRealFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Resolve the process's actual memory capacity, preferring (1) the nested service
 * cgroup, then (2) the cgroup-v2 root aggregate, then (3) process RSS / host RAM.
 * Each step requires both current and limit to be valid numbers before it is trusted;
 * otherwise it falls through rather than inventing a value.
 */
export function readServiceMemoryCapacity(options: CgroupResolverOptions = {}): ResolvedMemoryCapacity {
  const read = options.read ?? readRealFile;
  const root = (options.cgroupRoot ?? DEFAULT_CGROUP_ROOT).replace(/\/+$/, '');
  const selfPath = parseSelfCgroupV2(options.selfCgroup ?? readRealFileSafe('/proc/self/cgroup'));

  const serviceFsPath = selfPath ? resolveCgroupFsPath(root, selfPath) : undefined;
  if (serviceFsPath) {
    const current = readMetric(read(`${serviceFsPath}/memory.current`));
    const limit = readMetric(read(`${serviceFsPath}/memory.max`));
    if (current !== undefined && limit !== undefined) {
      const high = readMetric(read(`${serviceFsPath}/memory.high`));
      return { currentBytes: current, limitBytes: limit, highBytes: high, source: 'service' };
    }
  }

  const rootCurrent = readMetric(read(`${root}/memory.current`));
  const rootLimit = readMetric(read(`${root}/memory.max`));
  if (rootCurrent !== undefined && rootLimit !== undefined) {
    return { currentBytes: rootCurrent, limitBytes: rootLimit, highBytes: readMetric(read(`${root}/memory.high`)), source: 'root' };
  }

  return { currentBytes: process.memoryUsage().rss, limitBytes: totalmem(), source: 'process-rss' };
}

/**
 * Resolve task/PID capacity from the service cgroup (`pids.current`/`pids.max`).
 * `pids.max` may be `max` (effectively unbounded) — surfaced as `undefined` so callers
 * can treat an unbounded PID budget as a known-unknown rather than a fabricated number.
 */
export function readServicePidsCapacity(options: CgroupResolverOptions = {}): ResolvedPidsCapacity {
  const read = options.read ?? readRealFile;
  const root = (options.cgroupRoot ?? DEFAULT_CGROUP_ROOT).replace(/\/+$/, '');
  const selfPath = parseSelfCgroupV2(options.selfCgroup ?? readRealFileSafe('/proc/self/cgroup'));
  const serviceFsPath = selfPath ? resolveCgroupFsPath(root, selfPath) : undefined;
  const tryPath = serviceFsPath ?? root;
  const source: CgroupMemorySource = serviceFsPath ? 'service' : 'root';
  const current = readMetric(read(`${tryPath}/pids.current`));
  const max = readMetric(read(`${tryPath}/pids.max`));
  if (current === undefined && max === undefined) return { source: 'process-rss' };
  return { current, max, source };
}

function readRealFileSafe(path: string): string | undefined {
  // Kept as a named seam so the default resolver can be audited without an extra closure.
  return readRealFile(path);
}
