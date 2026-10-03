/**
 * Production-settings snapshot parsing and the mirrored disposable-server
 * environment. Production values are read (read-only) from the unit's
 * Environment line and the live /capacity endpoint; the mirror names every
 * value it copies and states its two deliberate deviations (A2 cadence for
 * measurement resolution; PI_TOOLS_SLICE pointed at the lane's own anchor).
 */
import { num } from './num.ts';

export interface ProductionSettingsSnapshot {
  readAtMs: number;
  mainPid: number | null;
  source: string;
  /** Selected KEY=VALUE pairs from the unit environment (admission + placement + heap). */
  values: Record<string, string>;
  /** Authoritative live gate values, read from production GET /api/v1/capacity. */
  capacity: {
    lagThresholdMs: number;
    lagRecoveryMs: number;
    lagSustainedReadings: number;
    heapPressureFraction: number;
    heapRecoveryFraction: number;
    heapReservedBytesPerTurn: number;
    maxActiveTurns: number;
  } | null;
}

const ENV_KEYS = [
  'NODE_ENV',
  'NODE_OPTIONS',
  'PI_TOOLS_PLACEMENT',
  'PI_TOOLS_SLICE',
  'PI_MAX_SESSIONS',
  'INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS',
  'INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE',
  'INTERNAL_API_ADMISSION_MIN_HEADROOM_MB',
  'INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN',
  'INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN',
  'INTERNAL_API_ADMISSION_LAG_P99_MS',
  'INTERNAL_API_ADMISSION_LAG_RECOVERY_MS',
  'INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS',
  'OBSERVABILITY_METRICS_INTERVAL_MS',
] as const;

/**
 * Tokenise a systemd `Environment=A=B C="d e"` line. Shell-like quoting:
 * values may be unquoted, single- or double-quoted; `\"` inside double quotes
 * is an escaped quote. Keys stop at the first `=`.
 */
export function parseSystemctlEnvironment(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = 'Environment=';
  const start = line.indexOf(prefix);
  if (start < 0) return out;
  let i = start + prefix.length;
  const n = line.length;
  const at = (k: number): string => (k >= 0 && k < n ? line.charAt(k) : '');
  while (i < n) {
    while (i < n && /\s/.test(at(i))) i += 1;
    if (i >= n) break;
    let key = '';
    while (i < n && at(i) !== '=' && !/\s/.test(at(i))) {
      key += at(i);
      i += 1;
    }
    if (at(i) !== '=') {
      // A bare token without '=' — skip it.
      while (i < n && !/\s/.test(at(i))) i += 1;
      continue;
    }
    i += 1; // skip '='
    let value = '';
    if (at(i) === "'") {
      i += 1;
      while (i < n && at(i) !== "'") {
        value += at(i);
        i += 1;
      }
      i += 1; // closing quote
    } else if (at(i) === '"') {
      i += 1;
      while (i < n && at(i) !== '"') {
        let ch = at(i);
        if (ch === '\\') {
          i += 1;
          ch = at(i);
        }
        value += ch;
        i += 1;
      }
      i += 1;
    } else {
      while (i < n && !/\s/.test(at(i))) {
        value += at(i);
        i += 1;
      }
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Keep only the keys this harness mirrors, from a full environment record. */
export function selectMirrorKeys(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_KEYS) {
    if (env[k] !== undefined) out[k] = env[k] as string;
  }
  return out;
}

/** Extract the live gate values from a production /capacity body (null-safe). */
export function capacitySettingsFromCapacity(body: Record<string, unknown>): ProductionSettingsSnapshot['capacity'] {
  const lag = body['eventLoopLag'] as Record<string, unknown> | undefined;
  const heap = body['heap'] as Record<string, unknown> | undefined;
  const maxActiveTurns = num(body['maxActiveTurns']);
  if (!lag || !heap) return null;
  return {
    lagThresholdMs: num(lag['thresholdMs']) ?? 300,
    lagRecoveryMs: num(lag['recoveryMs']) ?? 150,
    lagSustainedReadings: num(lag['sustainedReadings']) ?? 2,
    heapPressureFraction: num(heap['pressureFraction']) ?? 0.75,
    heapRecoveryFraction: num(heap['recoveryFraction']) ?? 0.65,
    heapReservedBytesPerTurn: num(heap['reservedBytesPerTurn']) ?? 67_108_864,
    maxActiveTurns: maxActiveTurns ?? 16,
  };
}

export interface MirrorOptions {
  anchorUnit: string;
  /** A2 cadence for the disposable server: 1000 for fine resolution (production runs 30000). */
  metricsIntervalMs: number;
  /** Session-count headroom (production 20) so a max-sessions refusal can never masquerade as a lag-gate refusal. */
  maxSessions: number;
}

/**
 * The disposable server's environment: every production admission value by
 * name, placement on at OUR anchor, and the two stated deviations.
 */
export function mirrorServerEnv(snapshot: ProductionSettingsSnapshot, opts: MirrorOptions): Record<string, string> {
  const cap = snapshot.capacity;
  const prod = (key: string): Record<string, string> => {
    const v = snapshot.values[key];
    return v !== undefined ? { [key]: v } : {};
  };
  const env: Record<string, string> = {
    // Production unit env, mirrored by name.
    ...prod('INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS'),
    ...prod('INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE'),
    ...prod('INTERNAL_API_ADMISSION_MIN_HEADROOM_MB'),
    ...prod('INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN'),
    ...prod('INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN'),
    // Production heap cap.
    ...prod('NODE_OPTIONS'),
    // Lag gate pinned EXPLICITLY to the live /capacity values (they default to
    // 300/150/2; being explicit means upstream default drift cannot silently
    // change what this lane measures).
    INTERNAL_API_ADMISSION_LAG_P99_MS: String(cap?.lagThresholdMs ?? 300),
    INTERNAL_API_ADMISSION_LAG_RECOVERY_MS: String(cap?.lagRecoveryMs ?? 150),
    INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS: String(cap?.lagSustainedReadings ?? 2),
    INTERNAL_API_ADMISSION_HEAP_RESERVED_MB_PER_TURN: String(Math.round((cap?.heapReservedBytesPerTurn ?? 67_108_864) / (1024 * 1024))),
    // Placement: ON, but at the LANE'S OWN anchor (deviation, stated).
    PI_TOOLS_PLACEMENT: 'on',
    PI_TOOLS_SLICE: opts.anchorUnit,
    // Measurement resolution (deviation, stated): 1 s A2 cadence.
    OBSERVABILITY_METRICS_INTERVAL_MS: String(opts.metricsIntervalMs),
    // Session-count headroom (deviation, stated).
    PI_MAX_SESSIONS: String(opts.maxSessions),
  };
  return env;
}
