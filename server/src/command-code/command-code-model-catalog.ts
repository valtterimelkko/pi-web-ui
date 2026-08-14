import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Full catalogue observed from the current Command Code model listing.
 * Visibility follows this order; execution remains restricted to COMMAND_CODE_MODELS.
 * Runtime readiness follows the freshly discovered catalogue and effort evidence;
 * the observed CLI version is diagnostic only.
 */
export const COMMAND_CODE_FULL_MODEL_CATALOGUE = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'moonshotai/kimi-k3',
  'moonshotai/kimi-k2.7-code',
  'moonshotai/kimi-k2.7-code-highspeed',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2.5',
  'zai-org/glm-5.2',
  'zai-org/glm-5.2-fast',
  'zai-org/glm-5.1',
  'zai-org/glm-5',
  'minimaxai/minimax-m3',
  'minimaxai/minimax-m2.7',
  'minimaxai/minimax-m2.5',
  'xiaomi/mimo-v2.5-pro',
  'xiaomi/mimo-v2.5',
  'qwen/qwen3.8-max',
  'qwen/qwen3.7-max',
  'qwen/qwen3.7-plus',
  'qwen/qwen3.7-flash',
  'qwen/qwen3.6-max-preview',
  'qwen/qwen3.6-plus',
  'stepfun/step-3.7-flash',
  'stepfun/step-3.5-flash',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'poolside/laguna-s-2.1-free',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'google/gemini-3.7-flash',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-flash-lite',
  'sakana/fugu-ultra',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'xai/grok-4.5',
  'xai/grok-4.6',
] as const;

export type CommandCodeModel = string;

export type CommandCodeModelCatalogueValidation =
  | { valid: true }
  | { valid: false; reason: 'invalid_model' | 'duplicate_model' | 'missing_model' | 'extra_model' | 'reordered_model' };

/** Validate exact IDs, cardinality, uniqueness, and canonical order. */
export function validateCommandCodeModelCatalogue(
  models: readonly CommandCodeRuntimeModel[],
): CommandCodeModelCatalogueValidation {
  if (models.some((model) => typeof model !== 'string' || !/^[a-z0-9][a-z0-9._/-]*$/.test(model))) {
    return { valid: false, reason: 'invalid_model' };
  }
  if (new Set(models).size !== models.length) return { valid: false, reason: 'duplicate_model' };
  if (models.length < COMMAND_CODE_FULL_MODEL_CATALOGUE.length) return { valid: false, reason: 'missing_model' };
  if (models.length > COMMAND_CODE_FULL_MODEL_CATALOGUE.length) return { valid: false, reason: 'extra_model' };
  const expected = COMMAND_CODE_FULL_MODEL_CATALOGUE as readonly string[];
  if (models.some((model) => !expected.includes(model))) return { valid: false, reason: 'extra_model' };
  if (models.some((model, index) => model !== expected[index])) return { valid: false, reason: 'reordered_model' };
  return { valid: true };
}
/** A model id returned by the current Command Code catalogue. */
export type CommandCodeRuntimeModel = string;
export const COMMAND_CODE_VERSION = '1.19.0' as const;
export const COMMAND_CODE_PROVIDER = 'command-code' as const;

/** Native Command Code effort values are intentionally not the generic API thinking levels. */
export const COMMAND_CODE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CommandCodeEffort = (typeof COMMAND_CODE_EFFORT_LEVELS)[number];
export interface CommandCodeModelDiscovery {
  version: string;
  models: CommandCodeRuntimeModel[];
  ambiguous: string[];
}

/** Exact, case-sensitive check against a freshly advertised runtime catalogue. */
export function assertCommandCodeRuntimeModel(
  value: unknown,
  advertisedModels: readonly CommandCodeRuntimeModel[],
): CommandCodeRuntimeModel | undefined {
  return typeof value === 'string' && advertisedModels.includes(value) ? value : undefined;
}

export function assertCommandCodeEffort(model: CommandCodeRuntimeModel, value: unknown): CommandCodeEffort | undefined {
  if (value === undefined) return undefined;
  if (!(COMMAND_CODE_EFFORT_LEVELS as readonly unknown[]).includes(value)) {
    throw new Error(`Command Code effort '${String(value)}' is not supported for model ${model}`);
  }
  return value as CommandCodeEffort;
}

/**
 * Parse the public `cmd --list-models` text without importing Command Code.
 * Model rows begin with an exact id followed by a multi-space description;
 * headings, aliases and prose are ignored. Duplicate exact rows are reported
 * as ambiguous rather than silently deduplicated into a usable route.
 */
export function parseCommandCodeModelList(stdout: string): CommandCodeModelDiscovery {
  const version = parseCommandCodeVersion(stdout) ?? 'unknown';
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const ids = lines
    .map(parseAdvertisedModelId)
    .filter((value): value is CommandCodeRuntimeModel => value !== undefined);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const models = [...new Set(ids)];
  const ambiguous = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  return { version, models, ambiguous };
}

function parseCommandCodeVersion(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:(?:command\s+code)(?:\s+cli)?(?:\s+version)?\s+|cmd(?:\s+version)?\s+)?v?(\d+(?:\.\d+){2})\s*$/i);
    if (match) return match[1];
  }
  return undefined;
}

function parseAdvertisedModelId(line: string): CommandCodeRuntimeModel | undefined {
  const trimmed = line.trim();
  // Catalogue rows have an exact lower-case model id followed by the CLI's
  // fixed multi-space description column. Headings, prose, aliases and
  // executable examples are not model advertisements.
  if (/^cmd\s+--model\b/i.test(trimmed)) return undefined;
  const match = trimmed.match(/^([a-z0-9][a-z0-9._/-]{0,255})[ ]{2,}\S/u);
  return match?.[1];
}

export interface CommandCodeDiscoveryOptions {
  /** Bound each child-process discovery probe so a broken executable cannot wedge readiness. */
  timeoutMs?: number;
}

export interface CommandCodeDiscoveryRunner {
  (executablePath: string, options?: CommandCodeDiscoveryOptions): Promise<CommandCodeModelDiscovery>;
}

export const COMMAND_CODE_DISCOVERY_TIMEOUT_MS = 10_000;

/** Startup-only model discovery. It uses an isolated home and never reads native auth/config files. */
export const discoverCommandCodeModels: CommandCodeDiscoveryRunner = async (executablePath, options = {}) => {
  return withIsolatedDiscoveryHome(async (homeDir) => {
    const environment = controlledDiscoveryEnvironment(homeDir);
    const versionProbe = await runDiscoveryCommand(executablePath, ['--no-auto-update', '--version'], options.timeoutMs, environment);
    const modelsProbe = await runDiscoveryCommand(executablePath, ['--no-auto-update', '--list-models'], options.timeoutMs, environment);
    const parsed = parseCommandCodeModelList(modelsProbe.stdout);
    const versionProbeVersion = parseCommandCodeVersion(versionProbe.stdout);
    if (parsed.version !== 'unknown' && versionProbeVersion !== undefined && parsed.version !== versionProbeVersion) {
      throw new Error(`Command Code version probes disagree: --version=${versionProbeVersion}, --list-models=${parsed.version}`);
    }
    const version = parsed.version === 'unknown'
      ? versionProbeVersion ?? 'unknown'
      : parsed.version;
    return { ...parsed, version };
  });
};

async function runDiscoveryCommand(
  executablePath: string,
  args: string[],
  timeoutMs = COMMAND_CODE_DISCOVERY_TIMEOUT_MS,
  environment = controlledDiscoveryEnvironment(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command Code discovery timeout must be positive');
  const child = spawn(executablePath, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 100_000); });
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    let settled = false;
    let timeoutError: Error | undefined;
    let timeoutFinalizer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      timeoutError = new Error(`Command Code model discovery timed out after ${timeoutMs}ms`);
      (timeoutError as Error & { stderr?: string }).stderr = redactDiscoveryDiagnostics(stderr);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const hardKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 250);
      hardKill.unref?.();
      // Prefer the child's `close` boundary so all pipes and descendants have
      // had a chance to observe termination, but retain a bounded fail-closed
      // fallback if a hostile child never closes its descriptors.
      timeoutFinalizer = setTimeout(() => finish(timeoutError), 500);
      timeoutFinalizer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    const finish = (error?: Error, code: number | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timeoutFinalizer) clearTimeout(timeoutFinalizer);
      if (error) reject(error);
      else resolve({ stdout, stderr, exitCode: code });
    };
    child.once('error', (error) => finish(timeoutError ?? (error instanceof Error ? error : new Error(String(error)))));
    // `close`, not `exit`, is the terminal stream boundary: stdout/stderr may
    // still flush after the child has exited but before their close events.
    child.once('close', (code, signal) => {
      if (timeoutError) {
        finish(timeoutError);
      } else if (code !== 0) {
        const error = new Error(`Command Code model discovery failed with exit ${code ?? signal ?? 'unknown'}`);
        (error as Error & { stderr?: string }).stderr = redactDiscoveryDiagnostics(stderr);
        finish(error);
      } else finish(undefined, code);
    });
  });
}

async function withIsolatedDiscoveryHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-discovery-home-'));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

const SAFE_DISCOVERY_ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TERM', 'NO_COLOR',
] as const;

function controlledDiscoveryEnvironment(homeDir?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_DISCOVERY_ENV_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  if (homeDir) {
    environment.HOME = homeDir;
    environment.XDG_CONFIG_HOME = path.join(homeDir, '.config');
    environment.XDG_DATA_HOME = path.join(homeDir, '.local', 'share');
    environment.XDG_CACHE_HOME = path.join(homeDir, '.cache');
  }
  return environment;
}

function redactDiscoveryDiagnostics(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .slice(-2_000);
}
