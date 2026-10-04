import dotenv from 'dotenv';
import path from 'path';
import { parseBlockedPiProviders } from './internal-api/pi-provider-policy.js';
import { createHealthTelemetryConfig } from './observability/health-telemetry-config.js';
import { resolveMemoryJournalPolicyOptions } from './observability/memory-journal-policy.js';
import os from 'os';
import { MAX_HUMAN_PINNED_SESSIONS_PER_RUNTIME } from '@pi-web-ui/shared';

dotenv.config();

// ─── Pi streaming tool-argument budget (B3a) ───────────────────────────────

/** Lower bound (chars) for a configured streaming tool-argument cap. */
export const PI_TOOL_ARGS_MIN_CHARS_BOUND = 1024;
/** Upper bound (chars) for a configured streaming tool-argument cap. */
export const PI_TOOL_ARGS_MAX_CHARS_BOUND = 1024 * 1024;
/** Default per-tool-call cap (correction 02, 2026-09-29): re-decided by PACED
 *  live measurement on pristine pi-ai — 64 KB at ~90 deltas/s: p99 max 4 ms
 *  over 185 samples, zero ≥300 ms; at ~300 deltas/s: p99 max 10 ms over 52
 *  samples, zero ≥300 ms (both abort at the cap with RUN_BUDGET_EXCEEDED).
 *  Pacing is what real generation does: the collapse needs parse-time ×
 *  delta-rate ≥ 1, and 2.2 ms × 300/s stays well under saturation. The UNPACED
 *  lab worst case (p99 max 10.6 s from two starved samples, bounded by the
 *  abort; b3a/measure/corr03-64k-unpaced.json) is documented as a residual
 *  risk; an operator who prefers the tighter bound sets
 *  PI_TOOL_ARGS_MAX_CALL_CHARS=16384. 64 KB keeps parity with the removed
 *  patch and 0/5,633 observed false positives on real tool arguments. */
export const PI_TOOL_ARGS_DEFAULT_CALL_CHARS = 64 * 1024;
/** Default per-run (agent_start→agent_end) aggregate cap across tool calls. */
export const PI_TOOL_ARGS_DEFAULT_TURN_CHARS = 256 * 1024;

export interface ParsedToolArgsCap {
  value: number;
  /** Present (with a human-readable message) when the raw value was invalid and the fallback was used. */
  warning?: string;
}

/**
 * Parse one streaming tool-argument cap env value. Unlike the strict parse
 * helpers above, an invalid value must NEVER stop production from starting
 * (parent decision, B3a gate 2026-09-29): it reports a warning and falls back.
 * An explicit `0` disables the cap (used by tests/positive controls) and is
 * valid, warning-free.
 */
export function parseToolArgsCap(raw: string | undefined, fallback: number, name: string): ParsedToolArgsCap {
  return parseRunBudgetCap(raw, fallback, name, PI_TOOL_ARGS_MIN_CHARS_BOUND, PI_TOOL_ARGS_MAX_CHARS_BOUND);
}

export interface ResolvedToolArgsCaps {
  callChars: number;
  turnChars: number;
  warnings: string[];
}

/**
 * Resolve the per-call and per-run caps together. Invalid values fall back
 * individually; an inverted pair (turn cap below a nonzero call cap) resets
 * BOTH to the defaults with one warning. An explicit 0 on either side disables
 * that cap and is exempt from the ordering rule. Never throws.
 */
export function resolveToolArgsCaps(
  callRaw: string | undefined,
  turnRaw: string | undefined,
): ResolvedToolArgsCaps {
  const call = parseToolArgsCap(callRaw, PI_TOOL_ARGS_DEFAULT_CALL_CHARS, 'PI_TOOL_ARGS_MAX_CALL_CHARS');
  const turn = parseToolArgsCap(turnRaw, PI_TOOL_ARGS_DEFAULT_TURN_CHARS, 'PI_TOOL_ARGS_MAX_TURN_CHARS');
  const warnings = [call.warning, turn.warning].filter((w): w is string => w !== undefined);
  if (call.value > 0 && turn.value > 0 && turn.value < call.value) {
    warnings.push(
      `PI_TOOL_ARGS_MAX_TURN_CHARS=${turn.value} is below PI_TOOL_ARGS_MAX_CALL_CHARS=${call.value}; ` +
      `using the defaults (${PI_TOOL_ARGS_DEFAULT_CALL_CHARS}/${PI_TOOL_ARGS_DEFAULT_TURN_CHARS}).`,
    );
    return {
      callChars: PI_TOOL_ARGS_DEFAULT_CALL_CHARS,
      turnChars: PI_TOOL_ARGS_DEFAULT_TURN_CHARS,
      warnings,
    };
  }
  return { callChars: call.value, turnChars: turn.value, warnings };
}

// ─── Pi per-run output-token and streamed-byte budgets (B3b) ─────────────

/** Lower bound (tokens) for a configured per-run output-token cap. */
export const PI_RUN_BUDGET_MIN_OUTPUT_TOKENS = 1_000;
/** Upper bound (tokens) for a configured per-run output-token cap. */
export const PI_RUN_BUDGET_MAX_OUTPUT_TOKENS_BOUND = 10_000_000;
/** Lower bound (bytes) for a configured per-run streamed-byte cap. 64 KiB
 *  keeps the configured range wide enough to cover the measured realistic
 *  maximum (999,449) and tighter operator-chosen experiments. */
export const PI_RUN_BUDGET_MIN_STREAMED_BYTES = 64 * 1024;
/** Upper bound (bytes) for a configured per-run streamed-byte cap. */
export const PI_RUN_BUDGET_MAX_STREAMED_BYTES_BOUND = 1024 * 1024 * 1024;
/** Default per-run output-token cap (B3b, correction 01 re-derived on the
 *  guard's real run boundary): pi-agent-core's loop consumes queued
 *  follow-ups INSIDE one run, so persisted user-message segments were merged
 *  at a <2s follow-up gap (gap distribution is bimodal: 921 gaps <2s vs 1,223
 *  ≥30s in 735 files / 3,353 segments → 3,273 merged runs). Merged max
 *  267,569 tokens; worst case at a 30s merge 270,689. Rule: margin over the
 *  merged max, NEVER BELOW 2× → 1,000,000 (3.7×) — deliberately loose so a
 *  legitimate long agentic loop cannot trip this message-end cap; the
 *  streamed-byte cap is the live volume bound. */
export const PI_RUN_BUDGET_DEFAULT_OUTPUT_TOKENS = 1_000_000;
/** Default per-run streamed-byte cap over all streamed assistant output
 *  (text + thinking + tool-call arguments; UTF-8 bytes; B3b correction 01:
 *  merged-run max 999,449, worst case at a 30s merge 1,050,331; B3c re-sized
 *  the default from live measurement: 8 MiB's worst measured end-of-run
 *  stall was 209 ms — over the frozen <200 ms sizing rule — so 4 MiB, whose
 *  worst measured stall was 132 ms over 5 runs; 3.99× the real merged max,
 *  ≥2× rule). This is the LIVE mid-stream bound: usage tokens are only
 *  reported at message end, bytes stream per delta. */
export const PI_RUN_BUDGET_DEFAULT_STREAMED_BYTES = 4 * 1024 * 1024;

/**
 * Parse one per-run budget cap env value (B3b). Same contract as B3a's
 * `parseToolArgsCap`: unset/blank falls back, an explicit `0` disables,
 * anything invalid or out of `[min, max]` reports a warning and falls back —
 * configuration never stops startup. Bounds are per-dimension (tokens vs
 * bytes), so they are parameters here; `parseToolArgsCap` delegates to this
 * with the tool-argument bounds.
 */
export function parseRunBudgetCap(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): ParsedToolArgsCap {
  if (raw === undefined || raw.trim() === '') return { value: fallback };
  const trimmed = raw.trim();
  if (trimmed === '0') return { value: 0 };
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return { value: fallback, warning: `${name}='${raw}' is not a valid cap; using ${fallback}.` };
  }
  const value = Number(trimmed);
  if (value < min || value > max) {
    return {
      value: fallback,
      warning: `${name}=${value} is outside the supported range [${min}, ${max}]; using ${fallback}.`,
    };
  }
  return { value };
}

export interface ResolvedRunBudgetCaps {
  outputTokens: number;
  streamedBytes: number;
  warnings: string[];
}

/**
 * Resolve the per-run output-token and streamed-byte caps together (B3b).
 * The two dimensions are independent (no ordering rule): each invalid value
 * falls back individually with one warning. Never throws.
 */
export function resolveRunBudgetCaps(
  outputRaw: string | undefined,
  streamedRaw: string | undefined,
): ResolvedRunBudgetCaps {
  const output = parseRunBudgetCap(
    outputRaw, PI_RUN_BUDGET_DEFAULT_OUTPUT_TOKENS, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS',
    PI_RUN_BUDGET_MIN_OUTPUT_TOKENS, PI_RUN_BUDGET_MAX_OUTPUT_TOKENS_BOUND,
  );
  const streamed = parseRunBudgetCap(
    streamedRaw, PI_RUN_BUDGET_DEFAULT_STREAMED_BYTES, 'PI_RUN_BUDGET_MAX_STREAMED_BYTES',
    PI_RUN_BUDGET_MIN_STREAMED_BYTES, PI_RUN_BUDGET_MAX_STREAMED_BYTES_BOUND,
  );
  return {
    outputTokens: output.value,
    streamedBytes: streamed.value,
    warnings: [output.warning, streamed.warning].filter((w): w is string => w !== undefined),
  };
}

// ─── Logging configuration (observability) ──────────────────────────────────

/**
 * Ordered log severity levels, most severe first.
 *
 * Semantics:
 * - `error` — failures needing attention.
 * - `warn`  — recoverable anomalies.
 * - `info`  — lifecycle milestones (default).
 * - `debug` — per-operation detail.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/**
 * Parse a `LOG_LEVEL` env value into a known level. Unset/blank/invalid values
 * fall back to `fallback` (default `info`). Case-insensitive.
 *
 * Extracted as a pure function so the resolution is unit-testable without
 * manipulating process.env at import time.
 */
export function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(raw);
}

export function parseNonnegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number(raw);
}

/** A fraction in (0, 1]; throws on anything else (fail loudly at startup). */
export function parseFraction(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number in (0, 1].`);
  }
  return value;
}

/**
 * B2 heap- and lag-aware admission knobs. Unset → undefined, so the
 * controller's evidence-based defaults apply (heap 0.75/0.65 of
 * heap_size_limit, 64 MiB per turn; lag 300 ms sustained over 2 A2 readings,
 * recovery at half the threshold unless set).
 */
export function resolveAdmissionHeapLagEnv(env: NodeJS.ProcessEnv = process.env): {
  internalApiAdmissionHeapPressureFraction?: number;
  internalApiAdmissionHeapRecoveryFraction?: number;
  internalApiAdmissionReservedHeapBytesPerTurn?: number;
  internalApiAdmissionLagThresholdMs?: number;
  internalApiAdmissionLagRecoveryMs?: number;
  internalApiAdmissionLagSustainedReadings?: number;
  /** Lag knobs that were invalid and fell back to the derived defaults (logged at load). */
  internalApiAdmissionConfigWarnings?: string[];
} {
  const warnings: string[] = [];
  const int = (name: string): number | undefined => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? undefined : parsePositiveInteger(raw, 1, name);
  };
  // Correction 01 (brief amendment): the lag knobs never stop startup; an
  // invalid value warns and falls back to the derived default.
  const lagInt = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    if (!/^[1-9]\d*$/.test(raw.trim())) {
      warnings.push(`${name}='${raw}' is not a positive integer; using the derived default.`);
      return undefined;
    }
    return Number(raw.trim());
  };
  const heapMb = int('INTERNAL_API_ADMISSION_HEAP_RESERVED_MB_PER_TURN');
  return {
    internalApiAdmissionHeapPressureFraction: parseFraction(env.INTERNAL_API_ADMISSION_HEAP_PRESSURE_FRACTION, 'INTERNAL_API_ADMISSION_HEAP_PRESSURE_FRACTION'),
    internalApiAdmissionHeapRecoveryFraction: parseFraction(env.INTERNAL_API_ADMISSION_HEAP_RECOVERY_FRACTION, 'INTERNAL_API_ADMISSION_HEAP_RECOVERY_FRACTION'),
    internalApiAdmissionReservedHeapBytesPerTurn: heapMb === undefined ? undefined : heapMb * 1024 * 1024,
    internalApiAdmissionLagThresholdMs: lagInt('INTERNAL_API_ADMISSION_LAG_P99_MS'),
    internalApiAdmissionLagRecoveryMs: lagInt('INTERNAL_API_ADMISSION_LAG_RECOVERY_MS'),
    internalApiAdmissionLagSustainedReadings: lagInt('INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS'),
    internalApiAdmissionConfigWarnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Rate-limit cap. Accepts both documented names: RATE_LIMIT_MAX (legacy,
 * undocumented in env files) and RATE_LIMIT_MAX_REQUESTS (what every env file
 * actually set — historically never read, so the cap silently stayed at the
 * default). RATE_LIMIT_MAX wins when both are present.
 */
export function resolveRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.RATE_LIMIT_MAX ?? env.RATE_LIMIT_MAX_REQUESTS, 100, 'RATE_LIMIT');
}

/** Auto-archive sessions idle longer than this many days (0 disables). */
export function resolveAutoArchiveDays(env: NodeJS.ProcessEnv = process.env): number {
  return parseNonnegativeInteger(env.SESSION_AUTO_ARCHIVE_DAYS, 30, 'SESSION_AUTO_ARCHIVE_DAYS');
}

/**
 * Cleanup dry-run gate. Defaults to true so the first production pass reports
 * what it WOULD archive and delete without acting; flip explicitly via
 * SESSION_CLEANUP_DRY_RUN=false once counts look sane.
 */
export function resolveCleanupDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_CLEANUP_DRY_RUN !== 'false';
}

/** Minimum days a session must dwell archived before retention delete is eligible. */
export function resolveRetentionMinDwellDays(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.SESSION_RETENTION_MIN_DWELL_DAYS, 7, 'SESSION_RETENTION_MIN_DWELL_DAYS');
}

export function parseAbsolutePath(raw: string | undefined, fallback: string, name: string): string {
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

export function parseAbsolutePathList(raw: string | undefined, fallback: string[], name: string): string[] {
  const values = raw === undefined || raw.trim() === '' ? fallback : raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one absolute path.`);
  return values.map((value) => parseAbsolutePath(value, value, name));
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : fallback;
}

// ─── Voice Mode engine selection (plan Phase 8) ──────────────────────────────

/**
 * Which engine serves the Voice Mode talker lane.
 * - `gemini-live` — the native-voice bridge (provider audio in/out);
 * - `cascade`     — the existing Gemma talker cascade (push-to-talk/typed), the
 *                   default until the operator enables the live engine.
 */
export type VoiceModeEngine = 'gemini-live' | 'cascade';

export const VOICE_MODE_ENGINES: readonly VoiceModeEngine[] = ['gemini-live', 'cascade'];

/**
 * Resolve `VOICE_MODE_ENGINE`. Unset/blank = `cascade` (today's behaviour —
 * no silent activation of the live path). An unknown value fails fast with a
 * clear message rather than falling back to a default the operator did not ask
 * for.
 */
export function resolveVoiceModeEngine(env: NodeJS.ProcessEnv = process.env): VoiceModeEngine {
  const raw = env.VOICE_MODE_ENGINE;
  if (raw === undefined || raw.trim() === '') return 'cascade';
  const value = raw.trim().toLowerCase();
  if ((VOICE_MODE_ENGINES as readonly string[]).includes(value)) return value as VoiceModeEngine;
  throw new Error(
    `VOICE_MODE_ENGINE must be one of ${VOICE_MODE_ENGINES.join('|')} (got '${raw}').`
  );
}

// ─── Per-component DEBUG namespaces ──────────────────────────────────────────

/**
 * A compiled `DEBUG` namespace filter.
 *
 * When {@link active} is `false` the filter is "off": every component is
 * allowed to emit (subject to {@link LOG_LEVEL}). When `active` is `true` only
 * components matching one of {@link patterns} are allowed; all others are
 * suppressed entirely. Matching is case-insensitive and supports `*` as a
 * wildcard for any sequence (e.g. `claude*`, `*`).
 */
export interface DebugNamespaceFilter {
  readonly active: boolean;
  readonly patterns: readonly string[];
  isEnabled(component: string): boolean;
}

/**
 * Compile a `DEBUG` env value (comma-separated component names with `*`
 * wildcards) into a {@link DebugNamespaceFilter}. Unset/blank → inactive
 * (respects `LOG_LEVEL` only). Example: `DEBUG=claude,opencode-sse`.
 */
export function parseDebugNamespaces(raw: string | undefined): DebugNamespaceFilter {
  const cleaned = (raw ?? '').trim();
  const patterns = cleaned ? cleaned.split(',').map((p) => p.trim()).filter(Boolean) : [];
  // No usable patterns (unset, blank, or only separators) → inactive: allow all
  // components per LOG_LEVEL. This also avoids the footgun where a stray comma
  // would otherwise suppress every component.
  if (patterns.length === 0) {
    return { active: false, patterns: [], isEnabled: () => true };
  }
  const testers = patterns.map(namespaceTester);
  return {
    active: true,
    patterns,
    isEnabled: (component: string) => testers.some((test) => test(component)),
  };
}

/** Build a case-insensitive, anchored matcher for one namespace pattern. */
function namespaceTester(pattern: string): (component: string) => boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (keep *)
    .replace(/\*/g, '.*'); // * → any sequence
  const re = new RegExp(`^${source}$`, 'i');
  return (component: string) => re.test(component);
}

// ─── Log output format ───────────────────────────────────────────────────────

/**
 * Log line rendering mode.
 * - `pretty` — human-readable text (default).
 * - `json`   — one JSON object per line for machine consumption.
 */
export type LogFormat = 'pretty' | 'json';

export const LOG_FORMATS: readonly LogFormat[] = ['pretty', 'json'];

/**
 * Parse a `LOG_FORMAT` env value. Unset/blank/invalid → `pretty`.
 */
export function parseLogFormat(raw: string | undefined, fallback: LogFormat = 'pretty'): LogFormat {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  return (LOG_FORMATS as readonly string[]).includes(value) ? (value as LogFormat) : fallback;
}

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  /** Minimum severity emitted by the central logger. See {@link parseLogLevel}. */
  logLevel: LogLevel;
  /** Compiled `DEBUG` component-namespace filter. See {@link parseDebugNamespaces}. */
  debugNamespaces: DebugNamespaceFilter;
  /** Log line rendering mode. See {@link parseLogFormat}. */
  logFormat: LogFormat;
  /** Voice Mode engine selection (plan Phase 8). Default `cascade`. */
  voiceModeEngine: VoiceModeEngine;
  jwtSecret: string;
  jwtExpiresIn: string;
  allowedOrigins: string[];
  authPassword: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  sessionAutoArchiveDays: number;
  sessionCleanupDryRun: boolean;
  sessionRetentionMinDwellDays: number;
  /** Discovery hygiene (plan Phase 3): auto-archive a natively-discovered
   *  session older than this many days at discovery time; 0 disables. */
  sessionDiscoveryArchiveDays: number;
  piAgentDir: string;
  webUiPrefsPath: string;
  sessionDir: string | undefined;
  claudeSessionDir: string;
  sessionRegistryPath: string;
  /** Maximum Pi sessions kept resident in the MultiSessionManager (capacity
   *  scaling 2026-09: replaces the hardcoded cap of 4 that throttled
   *  multi-agent orchestration). */
  piMaxSessions: number;
  /** B3a: per-tool-call cap on streamed tool-argument chars; 0 disables. */
  piToolArgsMaxCallChars: number;
  /** B3a: per-run aggregate cap on streamed tool-argument chars; 0 disables. */
  piToolArgsMaxTurnChars: number;
  /** B3b: per-run cap on summed assistant output tokens; 0 disables. */
  piRunBudgetMaxOutputTokens: number;
  /** B3b: per-run cap on streamed assistant bytes (text + thinking + tool args); 0 disables. */
  piRunBudgetMaxStreamedBytes: number;
  maxClaudeProcesses: number;
  opencodeServerPort: number;
  opencodeServerHost: string;
  opencodeServerPassword: string;
  opencodeServerEnabled: boolean;
  opencodeWorkingDir: string;
  opencodeMaxSessions: number;
  opencodeIdleTimeoutMs: number;
  opencodeStaleStreamingMs: number;
  opencodeMaxPinnedSessions: number;
  opencodeCleanupIntervalMs: number;
  opencodeDebugRawEvents: boolean;
  opencodeTrustedPermissions: boolean;
  opencodePermissionApproveMode: 'once' | 'always';
  opencodeServerMaxUptimeMs: number;
  opencodeModelProviders: string;
  opencodeModelSnapshotPath: string;
  /** Surface the full OpenRouter catalogue in the Pi runtime path (refresh job). */
  piOpenrouterModelsEnabled: boolean;
  piOpenrouterModelsCachePath: string;
  piOpenrouterModelsSnapshotPath: string;
  internalApiEnabled: boolean;
  internalApiSocketPath: string;
  internalApiKey: string;
  internalApiTokenPath: string;
  internalApiWatchDir: string;
  /** Directory for persisted Internal-API run receipts. */
  internalApiRunReceiptDir: string;
  /** Idempotency replay window for accepted runs. */
  internalApiRunIdempotencyTtlMs: number;
  /** C2 (contract 1.57.0): start window for the run never-started watchdog (0 disables). */
  internalApiRunStartWindowMs: number;
  /** C2 (contract 1.57.0): post-terminal settle window bounding a synchronous
   *  dispatch's wait for its runtime after the receipt is terminal. */
  internalApiPostTerminalSettleMs: number;
  internalApiEventPayloadMaxBytes: number;
  internalApiEventRateLimitPerSec: number;
  /** WS-path memory robustness (2026-09-05): per-client outbound send bounds. */
  wsSendSoftCapBytes: number;
  wsSendHardCapBytes: number;
  wsSendPendingMaxBytes: number;
  wsSendLowWaterBytes: number;
  /** Directory for the durable API-pin expiry ledger. */
  internalApiPinDir: string;
  /** Default API-pin lifetime (ms). */
  internalApiPinDefaultTtlMs: number;
  /** Hard maximum API-pin lifetime (ms). */
  internalApiPinMaxTtlMs: number;
  /** How often the API-pin expiry sweep runs (ms). */
  internalApiPinExpiryIntervalMs: number;
  /** Optional total active-turn budget (CPU-derived when unset). */
  internalApiAdmissionMaxActiveTurns?: number;
  /** Slots held back from Internal API conductors for interactive Web UI work. */
  internalApiAdmissionInteractiveReserve?: number;
  /** Required measured cgroup/host memory headroom before dispatch. */
  internalApiAdmissionMinimumHeadroomBytes?: number;
  /** Host-available-memory floor; below it execution is refused with host_memory_pressure. */
  internalApiAdmissionHostMinimumHeadroomBytes?: number;
  /** Conservative projected memory reservation per admitted turn. */
  internalApiAdmissionReservedBytesPerTurn?: number;
  /** Conservative projected PID/task reservation per admitted turn. When
   * `pids.current + this > pids.max`, execution is refused with `pid_pressure`. */
  internalApiAdmissionReservedPidsPerTurn?: number;
  /** B2 heap/lag admission knobs (see resolveAdmissionHeapLagEnv). */
  internalApiAdmissionHeapPressureFraction?: number;
  internalApiAdmissionHeapRecoveryFraction?: number;
  internalApiAdmissionReservedHeapBytesPerTurn?: number;
  internalApiAdmissionLagThresholdMs?: number;
  internalApiAdmissionLagRecoveryMs?: number;
  internalApiAdmissionLagSustainedReadings?: number;
  internalApiAdmissionConfigWarnings?: string[];
  /** Pi providers hidden and denied for agent execution on the Internal API only. */
  internalApiBlockedPiProviders: string[];
  /** Feature-gated, server-local Command Code adapter. */
  commandCodeEnabled: boolean;
  commandCodeExecutablePath: string;
  commandCodeStateDir: string;
  commandCodeNativeHomeDir: string;
  commandCodeAllowedCwdRoots: string[];
  commandCodeMaxTurns: number;
  commandCodeMaxWallTimeMs: number;
  commandCodeConcurrency: number;
  /** Ephemeral validation mode: isolated, disposable instance for live validation (no destructive cleanup). */
  validationMode: boolean;
  validationDefaultCwd: string;
  dictationOpenaiApiKey: string;
  dictationVocabularyDbPath: string;
  ttsOpenaiApiKey: string;
  ttsModel: string;
  ttsOpenaiFallbackModel: string;
  openrouterApiKey: string;
  claudeChannelEnabled: boolean;
  claudeChannelPluginDir: string;
  claudeChannelWsPort: number;
  claudeChannelHookPort: number;
  claudeProfilesEnabled: boolean;
  claudeSdkEnabled: boolean;
  claudeDirectProfilesEnabled: boolean;
  claudeProfilesPath: string;
  claudeDefaultProfile?: string;
  claudeBackendDefault: 'sdk' | 'direct' | 'channel';
  piStaleStreamingMs: number;
  antigravityEnabled: boolean;
  antigravitySessionDir: string;
  /** Native direct-CLI session stores (read-only discovery). */
  commandCodeCliHomeDir: string;
  opencodeStorageDir: string;
  antigravityNativeConversationsDir: string;
  /** Parallel data root of the Antigravity desktop app (no "-cli" suffix).
   *  The desktop app and the CLI write disjoint conversation stores with the
   *  same layout (conversations/<uuid>.db + brain/<uuid>/...); native discovery
   *  scans both so a pasted desktop-app conversation id is findable. */
  antigravityNativeDesktopConversationsDir: string;
  antigravityDefaultModel: string;
  antigravityPromptTimeoutMs: number;
  antigravityIdleTimeoutMs: number;
  antigravityMaxSessions: number;
  antigravityMaxPinnedSessions: number;
  antigravityCleanupIntervalMs: number;
  antigravityHeartbeatIntervalMs: number;
  antigravityStallTimeoutMs: number;
  antigravityMaxAttempts: number;
  /** Background-task completion poll cadence (0 disables the watcher). */
  antigravityBackgroundWatchIntervalMs: number;
  /** Watch ceiling per task: after this long without a receipt the task is
   *  marked completed (timedOut flag) so the banner cannot hang forever. */
  antigravityBackgroundWatchMaxMs: number;
  notificationsEnabled: boolean;
  notificationsDir: string;
  notificationsDebounceMs: number;
  notificationsTailMaxChars: number;
  notificationsPublicBaseUrl?: string;
  notificationsMaxDeliveryAttempts: number;
  notificationsIngressPollMs: number;
  notificationsChannelTimeoutMs: number;
  // ─── A2 heap/lag telemetry (docs/OBSERVABILITY.md § Heap and lag telemetry) ──
  /** Whether the periodic health-metrics sampler runs (default true). */
  observabilityMetricsEnabled: boolean;
  /** Directory of the size-bounded rotating health-metrics file. */
  observabilityMetricsDir: string;
  /** Sampling cadence of the health-metrics file (ms). */
  observabilityMetricsIntervalMs: number;
  /** Rotation trigger: no metrics generation grows past this (bytes). */
  observabilityMetricsMaxFileBytes: number;
  /** Hard bound on kept generations, including the current file. */
  observabilityMetricsMaxFiles: number;
  /** Heap fraction of the real `heap_size_limit` that arms the heap alert. */
  observabilityHealthAlertHeapFraction: number;
  /** Heap fraction that clears the heap alert (hysteresis low water mark). */
  observabilityHealthAlertHeapRecoverFraction: number;
  /** Lag p99 (ms) that arms the event-loop alert. */
  observabilityHealthAlertLagP99Ms: number;
  /** Lag p99 (ms) that clears the event-loop alert. */
  observabilityHealthAlertLagRecoverMs: number;
  /** Resolved alert target (e.g. `ingress:<dir>`, `file:<path>`, `none`). */
  observabilityHealthAlertSink: string;
  /** `[MultiSessionManager] Memory:` significant-change threshold (MB). */
  observabilityMemoryJournalMinDeltaMb: number;
  /** `[MultiSessionManager] Memory:` heartbeat interval (ms). */
  observabilityMemoryJournalHeartbeatMs: number;
  /** Heartbeat line fires at or above this heap usage (MB). */
  observabilityMemoryJournalHeapMb: number;
  /** Heartbeat line fires above this resident-session count. */
  observabilityMemoryJournalSessions: number;
  telegramBotToken?: string;
  telegramChatId?: string;
}

/**
 * A2 journal-volume knobs for the `[MultiSessionManager] Memory:` line: log on
 * significant change plus a low-frequency heartbeat instead of on every 30 s
 * memory check (see docs/OBSERVABILITY.md). The resolver itself lives with the
 * policy so the Pi runtime can build one without importing this module.
 */
export { resolveMemoryJournalPolicyOptions } from './observability/memory-journal-policy.js';

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

// A2 telemetry: resolved once, fail-fast — an invalid threshold or a validation
// server pointed at the production metrics path must not boot silently wrong.
const healthTelemetryConfig = createHealthTelemetryConfig(process.env);
const memoryJournalOptions = resolveMemoryJournalPolicyOptions(process.env);

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  debugNamespaces: parseDebugNamespaces(process.env.DEBUG),
  logFormat: parseLogFormat(process.env.LOG_FORMAT),
  voiceModeEngine: resolveVoiceModeEngine(process.env),
  jwtSecret: isProduction 
    ? getRequiredEnvVar('JWT_SECRET')
    : (process.env.JWT_SECRET || 'dev-secret-change-in-production'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  allowedOrigins: process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'],
  authPassword: isProduction
    ? getRequiredEnvVar('AUTH_PASSWORD')
    : (process.env.AUTH_PASSWORD || 'dev-password'),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  rateLimitMax: resolveRateLimitMax(process.env),
  sessionAutoArchiveDays: resolveAutoArchiveDays(process.env),
  sessionCleanupDryRun: resolveCleanupDryRun(process.env),
  sessionRetentionMinDwellDays: resolveRetentionMinDwellDays(process.env),
  sessionDiscoveryArchiveDays: parseInt(process.env.SESSION_DISCOVERY_ARCHIVE_DAYS || '14', 10),
  piAgentDir: process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
  /** Browser preference metadata file. Overridable so disposable validation
   *  servers never touch the production prefs (see validation-server-env). */
  webUiPrefsPath: process.env.WEB_UI_PREFS_PATH || path.join(process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'web-ui-prefs.json'),
  sessionDir: process.env.SESSION_DIR || undefined,
  claudeSessionDir: process.env.CLAUDE_SESSION_DIR || path.join(os.homedir(), '.pi-web-ui', 'claude-sessions'),
  sessionRegistryPath: process.env.SESSION_REGISTRY_PATH || path.join(os.homedir(), '.pi-web-ui', 'session-registry.json'),
  piMaxSessions: parsePositiveInteger(process.env.PI_MAX_SESSIONS, 20, 'PI_MAX_SESSIONS'),
  // B3a: streamed tool-argument budget. Invalid/inverted values warn and fall
  // back to defaults at load time — configuration must never stop startup.
  ...((): { piToolArgsMaxCallChars: number; piToolArgsMaxTurnChars: number } => {
    const caps = resolveToolArgsCaps(process.env.PI_TOOL_ARGS_MAX_CALL_CHARS, process.env.PI_TOOL_ARGS_MAX_TURN_CHARS);
    for (const warning of caps.warnings) console.warn(`[config] ${warning}`);
    return { piToolArgsMaxCallChars: caps.callChars, piToolArgsMaxTurnChars: caps.turnChars };
  })(),
  // B3b: per-run output-token and streamed-byte budgets. Same never-stop-
  // startup contract as B3a: invalid values warn and fall back at load time.
  ...((): { piRunBudgetMaxOutputTokens: number; piRunBudgetMaxStreamedBytes: number } => {
    const caps = resolveRunBudgetCaps(process.env.PI_RUN_BUDGET_MAX_OUTPUT_TOKENS, process.env.PI_RUN_BUDGET_MAX_STREAMED_BYTES);
    for (const warning of caps.warnings) console.warn(`[config] ${warning}`);
    return { piRunBudgetMaxOutputTokens: caps.outputTokens, piRunBudgetMaxStreamedBytes: caps.streamedBytes };
  })(),
  maxClaudeProcesses: parseInt(process.env.MAX_CLAUDE_PROCESSES || '10', 10),
  opencodeServerPort: parseInt(process.env.OPENCODE_SERVER_PORT || '4096', 10),
  opencodeServerHost: process.env.OPENCODE_SERVER_HOST || '127.0.0.1',
  opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD || '',
  opencodeServerEnabled: process.env.OPENCODE_ENABLED !== 'false',
  opencodeWorkingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
  opencodeMaxSessions: parseInt(process.env.OPENCODE_MAX_SESSIONS || '4', 10),
  opencodeIdleTimeoutMs: parseInt(process.env.OPENCODE_IDLE_TIMEOUT_MS || '1800000', 10),
  opencodeStaleStreamingMs: parseInt(process.env.OPENCODE_STALE_STREAMING_MS || '900000', 10),
  opencodeMaxPinnedSessions: parseInt(process.env.OPENCODE_MAX_PINNED_SESSIONS || String(MAX_HUMAN_PINNED_SESSIONS_PER_RUNTIME), 10),
  opencodeCleanupIntervalMs: parseInt(process.env.OPENCODE_CLEANUP_INTERVAL_MS || '60000', 10),
  opencodeDebugRawEvents: process.env.OPENCODE_DEBUG_RAW_EVENTS === 'true',
  opencodeTrustedPermissions: process.env.OPENCODE_TRUSTED_PERMISSIONS === 'true',
  opencodePermissionApproveMode: process.env.OPENCODE_PERMISSION_APPROVE_MODE === 'once' ? 'once' : 'always',
  opencodeServerMaxUptimeMs: parseInt(process.env.OPENCODE_SERVER_MAX_UPTIME_MS || '86400000', 10),
  // Which OpenCode providers' models are surfaced in the web UI model picker.
  // Comma-separated provider ids (e.g. "zai-coding-plan,kilo,opencode"), or
  // "all"/"*" to expose every provider OpenCode reports. API keys never leave
  // OpenCode's own auth storage — Pi Web UI only reads /config/providers.
  opencodeModelProviders: (process.env.OPENCODE_MODEL_PROVIDERS?.trim() || 'zai-coding-plan,kilo,opencode'),
  // Host-side audit snapshot for the weekly model-refresh job (ids only, no secrets).
  opencodeModelSnapshotPath: process.env.OPENCODE_MODEL_SNAPSHOT_PATH || path.join(os.homedir(), '.pi-web-ui', 'opencode-model-snapshot.json'),
  // Surface the full OpenRouter gateway catalogue in the Pi runtime path. The
  // fetched catalogue (public model ids/metadata only) is cached here and
  // registered into the Pi SDK ModelRegistry. No secrets are stored: OpenRouter
  // is a built-in Pi SDK provider whose key is auto-detected from
  // OPENROUTER_API_KEY, and the registered config uses an env-reference.
  piOpenrouterModelsEnabled: process.env.PI_OPENROUTER_MODELS_ENABLED !== 'false',
  piOpenrouterModelsCachePath: process.env.PI_OPENROUTER_MODELS_CACHE_PATH || path.join(os.homedir(), '.pi-web-ui', 'pi-openrouter-models.json'),
  piOpenrouterModelsSnapshotPath: process.env.PI_OPENROUTER_MODELS_SNAPSHOT_PATH || path.join(os.homedir(), '.pi-web-ui', 'pi-openrouter-model-snapshot.json'),
  internalApiEnabled: process.env.INTERNAL_API_ENABLED !== 'false',
  internalApiSocketPath: process.env.INTERNAL_API_SOCKET_PATH || path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock'),
  internalApiKey: process.env.INTERNAL_API_KEY || '',
  internalApiTokenPath: process.env.INTERNAL_API_TOKEN_PATH || path.join(os.homedir(), '.pi-web-ui', 'internal-api-token'),
  internalApiWatchDir: process.env.INTERNAL_API_WATCH_DIR || path.join(os.homedir(), '.pi-web-ui', 'watches'),
  internalApiRunReceiptDir: process.env.INTERNAL_API_RUN_RECEIPTS_DIR || path.join(os.homedir(), '.pi-web-ui', 'run-receipts'),
  internalApiRunIdempotencyTtlMs: parseInt(process.env.INTERNAL_API_RUN_IDEMPOTENCY_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  internalApiRunStartWindowMs: parseNonnegativeInteger(process.env.INTERNAL_API_RUN_START_WINDOW_MS, 120 * 1000, 'INTERNAL_API_RUN_START_WINDOW_MS'),
  internalApiPostTerminalSettleMs: parseNonnegativeInteger(process.env.INTERNAL_API_POST_TERMINAL_SETTLE_MS, 10 * 1000, 'INTERNAL_API_POST_TERMINAL_SETTLE_MS'),
  internalApiEventPayloadMaxBytes: parseNonnegativeInteger(process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES, 256 * 1024, 'INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES'),
  internalApiEventRateLimitPerSec: parsePositiveInteger(process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC, 200, 'INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC'),
  // WS-path memory robustness (2026-09-05): per-client outbound send bounds.
  wsSendSoftCapBytes: parseNonnegativeInteger(process.env.WS_SEND_SOFT_CAP_BYTES, 4 * 1024 * 1024, 'WS_SEND_SOFT_CAP_BYTES'),
  wsSendHardCapBytes: parsePositiveInteger(process.env.WS_SEND_HARD_CAP_BYTES, 16 * 1024 * 1024, 'WS_SEND_HARD_CAP_BYTES'),
  wsSendPendingMaxBytes: parsePositiveInteger(process.env.WS_SEND_PENDING_MAX_BYTES, 8 * 1024 * 1024, 'WS_SEND_PENDING_MAX_BYTES'),
  wsSendLowWaterBytes: parseNonnegativeInteger(process.env.WS_SEND_LOW_WATER_BYTES, 256 * 1024, 'WS_SEND_LOW_WATER_BYTES'),
  internalApiPinDir: process.env.INTERNAL_API_PIN_DIR || path.join(os.homedir(), '.pi-web-ui', 'pins'),
  internalApiPinDefaultTtlMs: parseInt(process.env.INTERNAL_API_PIN_DEFAULT_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  internalApiPinMaxTtlMs: parseInt(process.env.INTERNAL_API_PIN_MAX_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10),
  internalApiPinExpiryIntervalMs: parseInt(process.env.INTERNAL_API_PIN_EXPIRY_INTERVAL_MS || String(5 * 60 * 1000), 10),
  internalApiAdmissionMaxActiveTurns: process.env.INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS
    ? parsePositiveInteger(process.env.INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS, 1, 'INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS')
    : undefined,
  internalApiAdmissionInteractiveReserve: process.env.INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE === undefined
    ? undefined
    : parseNonnegativeInteger(process.env.INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE, 1, 'INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE'),
  internalApiAdmissionMinimumHeadroomBytes: process.env.INTERNAL_API_ADMISSION_MIN_HEADROOM_MB
    ? parsePositiveInteger(process.env.INTERNAL_API_ADMISSION_MIN_HEADROOM_MB, 512, 'INTERNAL_API_ADMISSION_MIN_HEADROOM_MB') * 1024 * 1024
    : undefined,
  internalApiAdmissionHostMinimumHeadroomBytes: process.env.INTERNAL_API_ADMISSION_HOST_MIN_HEADROOM_MB
    ? parsePositiveInteger(process.env.INTERNAL_API_ADMISSION_HOST_MIN_HEADROOM_MB, 512, 'INTERNAL_API_ADMISSION_HOST_MIN_HEADROOM_MB') * 1024 * 1024
    : undefined,
  internalApiAdmissionReservedBytesPerTurn: process.env.INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN
    ? parsePositiveInteger(process.env.INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN, 256, 'INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN') * 1024 * 1024
    : undefined,
  internalApiAdmissionReservedPidsPerTurn: process.env.INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN
    ? parsePositiveInteger(process.env.INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN, 256, 'INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN')
    : undefined,
  ...((): ReturnType<typeof resolveAdmissionHeapLagEnv> => {
    const admission = resolveAdmissionHeapLagEnv(process.env);
    for (const warning of admission.internalApiAdmissionConfigWarnings ?? []) console.warn(`[config] ${warning}`);
    return admission;
  })(),
  internalApiBlockedPiProviders: parseBlockedPiProviders(process.env.INTERNAL_API_BLOCKED_PI_PROVIDERS),
  commandCodeEnabled: process.env.COMMAND_CODE_ENABLED === 'true',
  commandCodeExecutablePath: parseAbsolutePath(process.env.COMMAND_CODE_EXECUTABLE_PATH, '/root/.npm-global/bin/cmd', 'COMMAND_CODE_EXECUTABLE_PATH'),
  commandCodeStateDir: parseAbsolutePath(process.env.COMMAND_CODE_STATE_DIR, path.join(os.homedir(), '.pi-web-ui', 'command-code'), 'COMMAND_CODE_STATE_DIR'),
  commandCodeNativeHomeDir: parseAbsolutePath(process.env.COMMAND_CODE_NATIVE_HOME_DIR, path.join(os.homedir(), '.pi-web-ui', 'command-code-native-home'), 'COMMAND_CODE_NATIVE_HOME_DIR'),
  commandCodeAllowedCwdRoots: parseAbsolutePathList(process.env.COMMAND_CODE_ALLOWED_CWD_ROOTS, [path.dirname(parseAbsolutePath(process.env.COMMAND_CODE_STATE_DIR, path.join(os.homedir(), '.pi-web-ui', 'command-code'), 'COMMAND_CODE_STATE_DIR'))], 'COMMAND_CODE_ALLOWED_CWD_ROOTS'),
  commandCodeMaxTurns: parsePositiveInteger(process.env.COMMAND_CODE_MAX_TURNS, 100, 'COMMAND_CODE_MAX_TURNS'),
  commandCodeMaxWallTimeMs: parsePositiveInteger(process.env.COMMAND_CODE_MAX_WALL_TIME_MS, 15 * 60 * 1000, 'COMMAND_CODE_MAX_WALL_TIME_MS'),
  commandCodeConcurrency: parsePositiveInteger(process.env.COMMAND_CODE_CONCURRENCY, 1, 'COMMAND_CODE_CONCURRENCY'),
  validationMode: process.env.PI_WEB_UI_VALIDATION_MODE === 'true',
  validationDefaultCwd: process.env.PI_WEB_UI_VALIDATION_DEFAULT_CWD || process.cwd(),
  dictationOpenaiApiKey: process.env.OPENAI_API_KEY || process.env.DICTATION_OPENAI_API_KEY || '',
  dictationVocabularyDbPath: process.env.DICTATION_VOCABULARY_DB_PATH || '/root/voicenotebot/streaming-dictation/backend/data/transcripts.db',
  ttsOpenaiApiKey: process.env.OPENAI_API_KEY || process.env.TTS_OPENAI_API_KEY || process.env.DICTATION_OPENAI_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  ttsModel: process.env.TTS_MODEL || 'google/gemini-3.8-flash-lite-tts',
  ttsOpenaiFallbackModel: process.env.TTS_OPENAI_FALLBACK_MODEL || 'gpt-4o-mini-tts',
  claudeChannelEnabled: process.env.CLAUDE_CHANNEL_ENABLED === 'true',
  claudeChannelPluginDir: process.env.CLAUDE_CHANNEL_PLUGIN_DIR ?? path.resolve(process.cwd(), 'pi-claude-channel'),
  claudeChannelWsPort: parseInt(process.env.CLAUDE_CHANNEL_WS_PORT || '3100', 10),
  claudeChannelHookPort: parseInt(process.env.CLAUDE_CHANNEL_HOOK_PORT || '3101', 10),
  // Claude provider profiles (SDK + direct CLI)
  claudeProfilesEnabled: process.env.CLAUDE_PROFILES_ENABLED === 'true',
  claudeSdkEnabled: process.env.CLAUDE_SDK_ENABLED !== 'false',
  claudeDirectProfilesEnabled: process.env.CLAUDE_DIRECT_PROFILES_ENABLED !== 'false',
  claudeProfilesPath: process.env.CLAUDE_PROFILES_PATH ?? path.join(os.homedir(), '.pi-web-ui', 'claude-profiles.json'),
  claudeDefaultProfile: process.env.CLAUDE_DEFAULT_PROFILE || undefined,
  claudeBackendDefault: (process.env.CLAUDE_BACKEND_DEFAULT as 'sdk' | 'direct' | 'channel') || 'direct',
  piStaleStreamingMs: parseInt(process.env.PI_STALE_STREAMING_MS || '900000', 10),
  antigravityEnabled: process.env.ANTIGRAVITY_ENABLED !== 'false',
  antigravitySessionDir: process.env.ANTIGRAVITY_SESSION_DIR || path.join(os.homedir(), '.pi-web-ui', 'antigravity-sessions'),
  // Native (direct-CLI) session stores scanned read-only by GET /api/v1/sessions/native.
  commandCodeCliHomeDir: process.env.COMMAND_CODE_CLI_HOME_DIR || path.join(os.homedir(), '.commandcode'),
  opencodeStorageDir: process.env.OPENCODE_STORAGE_DIR || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage'),
  antigravityNativeConversationsDir: process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations'),
  antigravityNativeDesktopConversationsDir: process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'conversations'),
  antigravityDefaultModel: process.env.ANTIGRAVITY_DEFAULT_MODEL || 'Gemini 3.8 Flash (Medium)',
  antigravityPromptTimeoutMs: parseInt(process.env.ANTIGRAVITY_PROMPT_TIMEOUT_MS || '600000', 10),
  antigravityIdleTimeoutMs: parseInt(process.env.ANTIGRAVITY_IDLE_TIMEOUT_MS || '1800000', 10),
  antigravityMaxSessions: parseInt(process.env.ANTIGRAVITY_MAX_SESSIONS || '4', 10),
  antigravityMaxPinnedSessions: parseInt(process.env.ANTIGRAVITY_MAX_PINNED_SESSIONS || String(MAX_HUMAN_PINNED_SESSIONS_PER_RUNTIME), 10),
  antigravityCleanupIntervalMs: parseInt(process.env.ANTIGRAVITY_CLEANUP_INTERVAL_MS || '60000', 10),
  // Background-task completion watcher (plan: antigravity background task
  // surfacing). agy's headless stream never re-prompts when a backgrounded
  // run_command finishes, so the service polls the conversation's
  // .system_generated/messages dir while tasks are running.
  antigravityBackgroundWatchIntervalMs: parseInt(process.env.ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS || '5000', 10),
  antigravityBackgroundWatchMaxMs: parseInt(process.env.ANTIGRAVITY_BACKGROUND_WATCH_MAX_MS || String(2 * 60 * 60 * 1000), 10),
  // Liveness heartbeat cadence during an in-flight Antigravity turn. agy is a
  // batch subprocess (no native streaming), so the server emits a synthetic
  // stream_activity ping on this interval to keep the UI heartbeat fresh.
  antigravityHeartbeatIntervalMs: parseInt(process.env.ANTIGRAVITY_HEARTBEAT_INTERVAL_MS || '5000', 10),
  // Inactivity watchdog for the per-turn agy subprocess: if its --log-file
  // hasn't grown for this long, the model is very likely stuck in a slow,
  // self-inflicted local tool call rather than waiting on a live backend call
  // (root-caused 2026-07-01: agy losing track of its own workspace root and
  // falling back to a full-filesystem `find /` scan — see
  // docs/ANTIGRAVITY-INTEGRATION.md), so the turn is killed and retried
  // instead of waiting out the full print-timeout. Must stay below
  // antigravityPromptTimeoutMs for the watchdog to ever preempt it.
  antigravityStallTimeoutMs: parseInt(process.env.ANTIGRAVITY_STALL_TIMEOUT_MS || '300000', 10),
  // Bounded attempt count (including the first try) for a turn that stalls or
  // times out. A retry reuses whatever conversation state agy already
  // resolved (or starts fresh on a first turn) — see runPromptAsync().
  antigravityMaxAttempts: parseInt(process.env.ANTIGRAVITY_MAX_ATTEMPTS || '2', 10),
  notificationsEnabled: process.env.NOTIFICATIONS_ENABLED === 'true',
  notificationsDir: process.env.NOTIFICATIONS_DIR || path.join(os.homedir(), '.pi-web-ui', 'notifications'),
  notificationsDebounceMs: parseInt(process.env.NOTIFICATIONS_DEBOUNCE_MS || '1500', 10),
  notificationsTailMaxChars: parseInt(process.env.NOTIFICATIONS_TAIL_MAX_CHARS || '1200', 10),
  notificationsPublicBaseUrl: process.env.NOTIFICATIONS_PUBLIC_BASE_URL || undefined,
  notificationsMaxDeliveryAttempts: parseInt(process.env.NOTIFICATIONS_MAX_DELIVERY_ATTEMPTS || '5', 10),
  notificationsIngressPollMs: parsePositiveInteger(process.env.NOTIFICATIONS_INGRESS_POLL_MS, 5000, 'NOTIFICATIONS_INGRESS_POLL_MS'),
  notificationsChannelTimeoutMs: parsePositiveInteger(process.env.NOTIFICATIONS_CHANNEL_TIMEOUT_MS, 10000, 'NOTIFICATIONS_CHANNEL_TIMEOUT_MS'),
  observabilityMetricsEnabled: healthTelemetryConfig.enabled,
  observabilityMetricsDir: healthTelemetryConfig.dir,
  observabilityMetricsIntervalMs: healthTelemetryConfig.intervalMs,
  observabilityMetricsMaxFileBytes: healthTelemetryConfig.maxFileBytes,
  observabilityMetricsMaxFiles: healthTelemetryConfig.maxFiles,
  observabilityHealthAlertHeapFraction: healthTelemetryConfig.thresholds.heapFractionHigh,
  observabilityHealthAlertHeapRecoverFraction: healthTelemetryConfig.thresholds.heapFractionLow,
  observabilityHealthAlertLagP99Ms: healthTelemetryConfig.thresholds.lagP99HighMs,
  observabilityHealthAlertLagRecoverMs: healthTelemetryConfig.thresholds.lagP99LowMs,
  observabilityHealthAlertSink: healthTelemetryConfig.sinkDescription,
  observabilityMemoryJournalMinDeltaMb: memoryJournalOptions.minDeltaMb,
  observabilityMemoryJournalHeartbeatMs: memoryJournalOptions.heartbeatMs,
  observabilityMemoryJournalHeapMb: memoryJournalOptions.heartbeatHeapMb,
  observabilityMemoryJournalSessions: memoryJournalOptions.heartbeatSessions,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
};
