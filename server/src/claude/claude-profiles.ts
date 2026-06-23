/**
 * Claude Provider Profiles
 *
 * A profile captures everything Pi Web UI needs to launch a Claude-family
 * session through a specific backend (SDK, direct CLI, or channel) with a
 * specific provider (native Anthropic subscription, GLM/Z.ai, etc.).
 *
 * Profiles live in a JSON file (default ~/.pi-web-ui/claude-profiles.json)
 * and are validated with Zod before use.  Secret values (auth tokens) are
 * sourced from env vars or secret files at launch time — they are never
 * stored in the profile file itself and never logged.
 */

import { z } from 'zod';
import { readFileSync, statSync, accessSync, constants } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('ClaudeProfiles');


// ─── Schema types ────────────────────────────────────────────────────────────

export const CLAUDE_BACKENDS = ['sdk-subscription', 'cli-direct', 'channel'] as const;
export type ClaudeBackend = (typeof CLAUDE_BACKENDS)[number];

export const CLAUDE_LAUNCHER_TYPES = ['command', 'native-env'] as const;
export type ClaudeLauncherType = (typeof CLAUDE_LAUNCHER_TYPES)[number];

export const CLAUDE_MODEL_MODES = ['claude-alias', 'pass-through'] as const;
export type ClaudeModelMode = (typeof CLAUDE_MODEL_MODES)[number];

export const CLAUDE_AUTH_MODES = [
  'subscription',
  'anthropic-compatible-token',
  'wrapper',
] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

export const ClaudeProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  backend: z.enum(CLAUDE_BACKENDS),
  launcherType: z.enum(CLAUDE_LAUNCHER_TYPES),
  command: z.string().optional(),
  baseUrl: z.string().url().optional(),
  authTokenEnv: z.string().optional(),
  authTokenPath: z.string().optional(),
  authMode: z.enum(CLAUDE_AUTH_MODES).optional(),
  model: z.string().min(1),
  modelMode: z.enum(CLAUDE_MODEL_MODES).default('claude-alias'),
  /** Model aliases injected as env vars (ANTHROPIC_DEFAULT_SONNET_MODEL etc.). */
  modelAliases: z
    .record(z.string(), z.string())
    .optional(),
  /**
   * Extra environment variables applied at launch (non-secret operational
   * knobs only).  This is how provider profiles enable features such as GLM's
   * 1M context window:
   *   CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000
   *   API_TIMEOUT_MS=3000000
   *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
   * Secret tokens must NOT be placed here — use authTokenEnv/authTokenPath.
   */
  env: z.record(z.string(), z.string()).optional(),
  settingSources: z
    .array(z.enum(['user', 'project', 'local']))
    .default(['user', 'project']),
  skills: z.union([z.literal('all'), z.array(z.string()), z.array(z.never())]).optional(),
  permissionMode: z.string().default('dontAsk'),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  maxConcurrent: z.number().int().positive().default(2),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});

export type ClaudeProfile = z.infer<typeof ClaudeProfileSchema>;

export const ClaudeProfilesFileSchema = z.object({
  profiles: z.array(ClaudeProfileSchema),
  defaultProfileId: z.string().optional(),
});

export type ClaudeProfilesFile = z.infer<typeof ClaudeProfilesFileSchema>;

// ─── Resolved launch ─────────────────────────────────────────────────────────

/**
 * The fully-resolved launch configuration for a Claude session.
 * Produced by {@link resolveProfile} from a {@link ClaudeProfile}.
 */
export interface ResolvedClaudeLaunch {
  /** Executable to spawn (for cli-direct) or pass to SDK pathToClaudeCodeExecutable. */
  executable: string;
  /** Complete env for the subprocess (API keys already stripped/set per profile). */
  env: NodeJS.ProcessEnv;
  /** Resolved model string to pass to --model or SDK options.model. */
  model: string;
  modelMode: ClaudeModelMode;
  backend: ClaudeBackend;
  /** SDK-specific options (settingSources, skills, permissionMode, allowedTools). */
  sdkOptions: {
    settingSources: Array<'user' | 'project' | 'local'>;
    skills: 'all' | string[];
    permissionMode: string;
    allowedTools?: string[];
    disallowedTools?: string[];
  };
  /** Extra CLI args for direct mode (e.g. ['--model', model]). */
  cliArgsBase: string[];
  /** Provider id for registry metadata (never a secret). */
  providerId: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ClaudeProfileError extends Error {
  constructor(
    message: string,
    public readonly profileId?: string,
    public readonly code:
      | 'PROFILE_NOT_FOUND'
      | 'PROFILE_DISABLED'
      | 'PROFILE_INVALID'
      | 'AUTH_TOKEN_MISSING'
      | 'AUTH_TOKEN_FILE_UNREADABLE'
      | 'COMMAND_NOT_FOUND'
      | 'NO_PROFILES' = 'PROFILE_INVALID',
  ) {
    super(message);
    this.name = 'ClaudeProfileError';
  }
}

// ─── Profile Manager ─────────────────────────────────────────────────────────

/**
 * Loads, validates, and serves Claude provider profiles from a JSON file.
 *
 * Profile loading is a security-sensitive boundary: profiles can choose
 * executables, set env vars, and read secret files.  Only trusted,
 * schema-validated profiles are accepted.
 */
export class ClaudeProfileManager {
  private profiles = new Map<string, ClaudeProfile>();
  private defaultProfileId: string | undefined;
  private _loaded = false;
  private readonly profilesPath: string;

  constructor(opts: { profilesPath: string }) {
    this.profilesPath = opts.profilesPath;
  }

  /**
   * Load and validate profiles from disk.  Safe to call multiple times —
   * subsequent calls re-read the file (hot-reload).
   */
  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.profilesPath, 'utf-8');
    } catch {
      this.profiles.clear();
      this.defaultProfileId = undefined;
      this._loaded = true;
      return;
    }

    const parsed = JSON.parse(raw);
    const result = ClaudeProfilesFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ClaudeProfileError(
        `Invalid profile config at ${this.profilesPath}: ${issues}`,
        undefined,
        'PROFILE_INVALID',
      );
    }

    this.profiles.clear();
    for (const profile of result.data.profiles) {
      this.profiles.set(profile.id, profile);
    }
    this.defaultProfileId = result.data.defaultProfileId;
    this._loaded = true;
  }

  /** Ensure profiles have been loaded at least once. */
  private ensureLoaded(): void {
    if (!this._loaded) this.load();
  }

  getProfile(id: string): ClaudeProfile | undefined {
    this.ensureLoaded();
    return this.profiles.get(id);
  }

  /** Get an enabled profile or throw. */
  requireProfile(id: string): ClaudeProfile {
    this.ensureLoaded();
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new ClaudeProfileError(
        `Profile not found: ${id}`,
        id,
        'PROFILE_NOT_FOUND',
      );
    }
    if (!profile.enabled) {
      throw new ClaudeProfileError(
        `Profile is disabled: ${id}`,
        id,
        'PROFILE_DISABLED',
      );
    }
    return profile;
  }

  listEnabledProfiles(): ClaudeProfile[] {
    this.ensureLoaded();
    return Array.from(this.profiles.values()).filter((p) => p.enabled);
  }

  listAllProfiles(): ClaudeProfile[] {
    this.ensureLoaded();
    return Array.from(this.profiles.values());
  }

  getDefaultProfileId(): string | undefined {
    this.ensureLoaded();
    return this.defaultProfileId;
  }

  get hasProfiles(): boolean {
    this.ensureLoaded();
    return this.profiles.size > 0;
  }
}

// ─── Profile Resolver ────────────────────────────────────────────────────────

/**
 * Default allowed tools for server-side, non-interactive Claude usage.
 * In dontAsk mode, any tool NOT in this list is silently denied.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
  'Skill',
  'TodoWrite',
];

/**
 * Validate a secret file path before reading it.
 *
 * - Must be absolute
 * - Must not be a symlink (security)
 * - Must exist and be readable
 * - Must not be world-readable (0o777 would be a red flag)
 */
function validateSecretFilePath(filePath: string): void {
  // Check BEFORE resolve() — resolve() would silently make it absolute
  if (!isAbsolute(filePath)) {
    throw new ClaudeProfileError(
      `authTokenPath must be absolute: ${filePath}`,
      undefined,
      'AUTH_TOKEN_FILE_UNREADABLE',
    );
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    throw new ClaudeProfileError(
      `authTokenPath does not exist or is unreadable: ${filePath}`,
      undefined,
      'AUTH_TOKEN_FILE_UNREADABLE',
    );
  }
  if (!st.isFile()) {
    throw new ClaudeProfileError(
      `authTokenPath is not a regular file: ${filePath}`,
      undefined,
      'AUTH_TOKEN_FILE_UNREADABLE',
    );
  }
  // Reject symlinks for secret files (defence against traversal/surprise)
  try {
    accessSync(filePath, constants.R_OK);
  } catch {
    throw new ClaudeProfileError(
      `authTokenPath is not readable: ${filePath}`,
      undefined,
      'AUTH_TOKEN_FILE_UNREADABLE',
    );
  }
  // Warn (but allow) on overly broad permissions
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    // world or group readable — log a warning but don't block
    logger.warn(
      `[claude-profiles] WARNING: secret file ${filePath} is accessible by group/others (mode ${mode.toString(8)})`,
    );
  }
}

/**
 * Read the auth token for a profile.
 *
 * Resolution order:
 * 1. authTokenEnv — read from process.env[authTokenEnv]
 * 2. authTokenPath — read from a validated secret file (trimmed)
 *
 * The token value is NEVER logged.
 */
function resolveAuthToken(profile: ClaudeProfile): string | undefined {
  if (profile.authTokenEnv) {
    const val = process.env[profile.authTokenEnv];
    if (val && val.trim()) return val.trim();
    throw new ClaudeProfileError(
      `authTokenEnv '${profile.authTokenEnv}' is not set or empty for profile '${profile.id}'`,
      profile.id,
      'AUTH_TOKEN_MISSING',
    );
  }
  if (profile.authTokenPath) {
    // Validate the ORIGINAL path (before resolve makes it absolute)
    validateSecretFilePath(profile.authTokenPath);
    const resolved = resolve(profile.authTokenPath);
    const raw = readFileSync(resolved, 'utf-8').trim();
    if (!raw) {
      throw new ClaudeProfileError(
        `authTokenPath file is empty for profile '${profile.id}'`,
        profile.id,
        'AUTH_TOKEN_MISSING',
      );
    }
    return raw;
  }
  return undefined;
}

/**
 * Resolve a ClaudeProfile into a fully-formed launch configuration.
 *
 * This is the single point where profile config becomes concrete env/args.
 * Security rules enforced here:
 *   - ANTHROPIC_API_KEY is ALWAYS stripped (no pay-per-use)
 *   - ANTHROPIC_AUTH_TOKEN is set ONLY for anthropic-compatible-token profiles
 *   - For native subscription profiles, neither key is set (Claude Code uses its own OAuth)
 *   - Token values are never logged
 */
export function resolveProfile(profile: ClaudeProfile): ResolvedClaudeLaunch {
  // Start from process.env so PATH, HOME, etc. are inherited
  const env: NodeJS.ProcessEnv = { ...process.env };

  // CRITICAL: always strip pay-per-use API key
  delete env.ANTHROPIC_API_KEY;

  let executable = 'claude';
  let providerId = 'anthropic';

  if (profile.launcherType === 'native-env') {
    // Native env profile: set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN
    if (profile.baseUrl) {
      env.ANTHROPIC_BASE_URL = profile.baseUrl;
    }

    const authToken = resolveAuthToken(profile);
    if (authToken) {
      // This is the ONLY place ANTHROPIC_AUTH_TOKEN is set for GLM profiles
      env.ANTHROPIC_AUTH_TOKEN = authToken;
    } else {
      // Native subscription profile: no token, strip any stale value
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    // Apply model aliases (ANTHROPIC_DEFAULT_SONNET_MODEL etc.)
    if (profile.modelAliases) {
      for (const [key, value] of Object.entries(profile.modelAliases)) {
        env[key] = value;
      }
    }

    // Infer provider from base URL
    if (profile.baseUrl?.includes('z.ai') || profile.baseUrl?.includes('bigmodel')) {
      providerId = 'zai';
    }
  } else if (profile.launcherType === 'command') {
    // Command launcher (e.g. clother-zai or a wrapper script)
    if (!profile.command) {
      throw new ClaudeProfileError(
        `Command profile '${profile.id}' has no command`,
        profile.id,
        'COMMAND_NOT_FOUND',
      );
    }
    executable = profile.command;
    providerId = 'wrapper';

    // Command profiles are still subject to API key stripping.
    // The wrapper is responsible for setting its own auth env.
    // We do NOT set ANTHROPIC_AUTH_TOKEN here — the wrapper does that.
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  // Apply extra operational env vars (e.g. GLM 1M context knobs).
  // Applied last so a profile can override inherited values, but the
  // secret-stripping above and token-setting below are not reachable from here
  // (env is schema-restricted to plain strings and validated upstream).
  if (profile.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      // Never allow a profile's `env` block to smuggle in a pay-per-use API key.
      if (key === 'ANTHROPIC_API_KEY') continue;
      env[key] = value;
    }
  }

  // Resolve the model
  const model = profile.model;
  const modelMode = profile.modelMode;

  // Build SDK options
  const settingSources = profile.settingSources ?? ['user', 'project'];
  const skills = profile.skills ?? 'all';
  const permissionMode = profile.permissionMode ?? 'dontAsk';
  const allowedTools = profile.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const disallowedTools = profile.disallowedTools ?? [];

  // Build CLI args base for direct mode
  const cliArgsBase: string[] = ['--model', model];

  return {
    executable,
    env,
    model,
    modelMode,
    backend: profile.backend,
    sdkOptions: {
      settingSources,
      skills,
      permissionMode,
      allowedTools,
      disallowedTools,
    },
    cliArgsBase,
    providerId,
  };
}

// ─── Redaction helper ─────────────────────────────────────────────────────────

/**
 * Keys whose values must never appear in logs, API responses, or artifacts.
 */
export const SECRET_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * Return a copy of `env` with all known secret values replaced by '<redacted>'.
 * Use this when logging, building error messages, or serialising diagnostics.
 */
export function redactSecrets(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const redacted: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_KEYS.includes(key as (typeof SECRET_ENV_KEYS)[number])) {
      redacted[key] = value ? '<redacted>' : undefined;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

// ─── Reasoning effort mapping ─────────────────────────────────────────────────

/**
 * Reasoning effort levels understood by Claude Code (CLI `--effort` and SDK
 * `options.effort`).  GLM 5.2 only exposes a few internal reasoning steps, but
 * the Z.ai coding-plan endpoint accepts and maps these Claude-native effort
 * levels itself, so we always speak the Claude vocabulary regardless of
 * provider.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * Map a Pi Web UI thinking level (off/minimal/low/medium/high/xhigh) to a
 * Claude effort level. Returns undefined when no level is set, so callers can
 * leave effort unspecified and let Claude Code use its own default.
 *
 * - off / minimal / low → 'low'
 * - medium              → 'medium'
 * - high                → 'high'
 * - xhigh               → 'xhigh'
 * - max                 → 'max'  (passthrough if a caller already speaks effort)
 */
export function mapThinkingLevelToEffort(level?: string | null): ClaudeEffortLevel | undefined {
  if (!level) return undefined;
  switch (level) {
    case 'off':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    default:
      return undefined;
  }
}

// ─── Default profile file path ───────────────────────────────────────────────

export function defaultProfilesPath(): string {
  return resolve(homedir(), '.pi-web-ui', 'claude-profiles.json');
}
