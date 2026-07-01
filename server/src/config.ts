import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

dotenv.config();

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
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : fallback;
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
  jwtSecret: string;
  jwtExpiresIn: string;
  allowedOrigins: string[];
  authPassword: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  piAgentDir: string;
  sessionDir: string | undefined;
  claudeSessionDir: string;
  sessionRegistryPath: string;
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
  /** Directory for the durable API-pin expiry ledger. */
  internalApiPinDir: string;
  /** Default API-pin lifetime (ms). */
  internalApiPinDefaultTtlMs: number;
  /** Hard maximum API-pin lifetime (ms). */
  internalApiPinMaxTtlMs: number;
  /** How often the API-pin expiry sweep runs (ms). */
  internalApiPinExpiryIntervalMs: number;
  /** Ephemeral validation mode: isolated, disposable instance for live validation (no destructive cleanup). */
  validationMode: boolean;
  dictationOpenaiApiKey: string;
  dictationVocabularyDbPath: string;
  ttsOpenaiApiKey: string;
  ttsModel: string;
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
  antigravityDefaultModel: string;
  antigravityPromptTimeoutMs: number;
  antigravityIdleTimeoutMs: number;
  antigravityMaxSessions: number;
  antigravityMaxPinnedSessions: number;
  antigravityCleanupIntervalMs: number;
  antigravityHeartbeatIntervalMs: number;
  antigravityStallTimeoutMs: number;
  antigravityMaxAttempts: number;
  notificationsEnabled: boolean;
  notificationsDir: string;
  notificationsDebounceMs: number;
  notificationsTailMaxChars: number;
  notificationsPublicBaseUrl?: string;
  notificationsMaxDeliveryAttempts: number;
  telegramBotToken?: string;
  telegramChatId?: string;
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  debugNamespaces: parseDebugNamespaces(process.env.DEBUG),
  logFormat: parseLogFormat(process.env.LOG_FORMAT),
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
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  piAgentDir: process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
  sessionDir: process.env.SESSION_DIR || undefined,
  claudeSessionDir: process.env.CLAUDE_SESSION_DIR || path.join(os.homedir(), '.pi-web-ui', 'claude-sessions'),
  sessionRegistryPath: process.env.SESSION_REGISTRY_PATH || path.join(os.homedir(), '.pi-web-ui', 'session-registry.json'),
  maxClaudeProcesses: parseInt(process.env.MAX_CLAUDE_PROCESSES || '10', 10),
  opencodeServerPort: parseInt(process.env.OPENCODE_SERVER_PORT || '4096', 10),
  opencodeServerHost: process.env.OPENCODE_SERVER_HOST || '127.0.0.1',
  opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD || '',
  opencodeServerEnabled: process.env.OPENCODE_ENABLED !== 'false',
  opencodeWorkingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
  opencodeMaxSessions: parseInt(process.env.OPENCODE_MAX_SESSIONS || '4', 10),
  opencodeIdleTimeoutMs: parseInt(process.env.OPENCODE_IDLE_TIMEOUT_MS || '1800000', 10),
  opencodeStaleStreamingMs: parseInt(process.env.OPENCODE_STALE_STREAMING_MS || '900000', 10),
  opencodeMaxPinnedSessions: parseInt(process.env.OPENCODE_MAX_PINNED_SESSIONS || '2', 10),
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
  internalApiPinDir: process.env.INTERNAL_API_PIN_DIR || path.join(os.homedir(), '.pi-web-ui', 'pins'),
  internalApiPinDefaultTtlMs: parseInt(process.env.INTERNAL_API_PIN_DEFAULT_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  internalApiPinMaxTtlMs: parseInt(process.env.INTERNAL_API_PIN_MAX_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10),
  internalApiPinExpiryIntervalMs: parseInt(process.env.INTERNAL_API_PIN_EXPIRY_INTERVAL_MS || String(5 * 60 * 1000), 10),
  validationMode: process.env.PI_WEB_UI_VALIDATION_MODE === 'true',
  dictationOpenaiApiKey: process.env.OPENAI_API_KEY || process.env.DICTATION_OPENAI_API_KEY || '',
  dictationVocabularyDbPath: process.env.DICTATION_VOCABULARY_DB_PATH || '/root/voicenotebot/streaming-dictation/backend/data/transcripts.db',
  ttsOpenaiApiKey: process.env.OPENAI_API_KEY || process.env.TTS_OPENAI_API_KEY || process.env.DICTATION_OPENAI_API_KEY || '',
  ttsModel: process.env.TTS_MODEL || 'tts-1',
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
  antigravityDefaultModel: process.env.ANTIGRAVITY_DEFAULT_MODEL || 'Gemini 3.5 Flash (Medium)',
  antigravityPromptTimeoutMs: parseInt(process.env.ANTIGRAVITY_PROMPT_TIMEOUT_MS || '600000', 10),
  antigravityIdleTimeoutMs: parseInt(process.env.ANTIGRAVITY_IDLE_TIMEOUT_MS || '1800000', 10),
  antigravityMaxSessions: parseInt(process.env.ANTIGRAVITY_MAX_SESSIONS || '4', 10),
  antigravityMaxPinnedSessions: parseInt(process.env.ANTIGRAVITY_MAX_PINNED_SESSIONS || '2', 10),
  antigravityCleanupIntervalMs: parseInt(process.env.ANTIGRAVITY_CLEANUP_INTERVAL_MS || '60000', 10),
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
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
};
