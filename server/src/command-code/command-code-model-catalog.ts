import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The two exact routes reserved for the Agent OS shadow workflow. They remain
 * intentionally narrow even though the browser catalogue is discovered live.
 */
export const COMMAND_CODE_MODELS = [
  'qwen/qwen3.8-max',
  'meta/muse-spark-1.2-contributor',
] as const;

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

export type CommandCodeModel = (typeof COMMAND_CODE_MODELS)[number];

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
export const COMMAND_CODE_EFFORT_LEVELS_BY_MODEL: Partial<Record<CommandCodeRuntimeModel, readonly CommandCodeEffort[]>> = {
  'qwen/qwen3.8-max': ['low', 'medium', 'xhigh'],
  'meta/muse-spark-1.2-contributor': [],
};
export const COMMAND_CODE_EFFORT_SOURCE = 'live-preflight' as const;

export interface CommandCodeEffortCapability {
  supportsEffort: boolean;
  effortLevels: CommandCodeEffort[];
  defaultEffort?: CommandCodeEffort;
  /** Unknown means discovery was inconclusive and must fail closed. */
  status: 'adjustable' | 'unavailable' | 'unknown';
  source: typeof COMMAND_CODE_EFFORT_SOURCE;
  capabilityHash: string;
}

export type CommandCodeEffortCapabilities = Record<CommandCodeRuntimeModel, CommandCodeEffortCapability>;

export interface CommandCodeModelDiscovery {
  version: string;
  models: CommandCodeRuntimeModel[];
  ambiguous: string[];
  /** Populated by the full startup discovery; omitted by the model-list parser. */
  effortCapabilities?: CommandCodeEffortCapabilities;
}

/** Exact, case-sensitive check for the two Agent OS shadow routes. */
export function assertCommandCodeModel(value: unknown): CommandCodeModel | undefined {
  return (COMMAND_CODE_MODELS as readonly string[]).includes(value as string)
    ? value as CommandCodeModel
    : undefined;
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
  const knownLevels = COMMAND_CODE_EFFORT_LEVELS_BY_MODEL[model];
  const allowed = knownLevels ?? COMMAND_CODE_EFFORT_LEVELS;
  if (!(allowed as readonly unknown[]).includes(value)) {
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
  /** Bound the complete hybrid effort catalogue discovery, not just one probe. */
  totalTimeoutMs?: number;
  /** Restrict effort discovery to the freshly advertised exact ids. */
  models?: readonly CommandCodeRuntimeModel[];
  /**
   * Legacy shadow probing checks every known effort value. Browser discovery
   * can use one invalid-value probe and parse the CLI's supported-values list.
   */
  probeAllValues?: boolean;
  /**
   * Exact policy models that still require exhaustive probes when the broader
   * discovered catalogue uses the bounded invalid-value probe.
   */
  probeAllValuesForModels?: readonly CommandCodeRuntimeModel[];
}

export interface CommandCodeDiscoveryRunner {
  (executablePath: string, options?: CommandCodeDiscoveryOptions): Promise<CommandCodeModelDiscovery>;
}

export const COMMAND_CODE_DISCOVERY_TIMEOUT_MS = 10_000;
export const COMMAND_CODE_DISCOVERY_TOTAL_TIMEOUT_MS = 120_000;

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

/**
 * Probe each exact model with each documented native effort value. A model that
 * rejects every value is explicitly non-adjustable; a timeout/spawn failure is
 * unknown and therefore remains fail-closed for session creation.
 */
export async function discoverCommandCodeEfforts(
  executablePath: string,
  options: CommandCodeDiscoveryOptions = {},
): Promise<{ capabilities: CommandCodeEffortCapabilities }> {
  return withIsolatedDiscoveryHome(async (homeDir) => {
    const environment = controlledDiscoveryEnvironment(homeDir);
    const capabilities = {} as CommandCodeEffortCapabilities;
    const models = options.models?.length ? [...options.models] : [...COMMAND_CODE_MODELS];
    const totalTimeoutMs = options.totalTimeoutMs ?? COMMAND_CODE_DISCOVERY_TOTAL_TIMEOUT_MS;
    if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) throw new Error('Command Code total discovery timeout must be positive');
    const deadline = Date.now() + totalTimeoutMs;
    const probeTimeout = (): number => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Command Code effort discovery timed out after ${totalTimeoutMs}ms`);
      return Math.min(options.timeoutMs ?? COMMAND_CODE_DISCOVERY_TIMEOUT_MS, remaining);
    };
    for (const model of models) {
      const supported: CommandCodeEffort[] = [];
      let unknown = false;
      let defaultEffort: CommandCodeEffort | undefined;

      const probeAllValues = options.probeAllValuesForModels?.includes(model)
        || options.probeAllValues !== false;
      if (!probeAllValues) {
        const result = await probeEffortList(
          executablePath,
          model,
          probeTimeout(),
          environment,
        );
        supported.push(...result.values);
        unknown ||= result.unknown;
        if (model === 'qwen/qwen3.8-max' && supported.includes('medium')) defaultEffort = 'medium';
      } else {
        for (const effort of COMMAND_CODE_EFFORT_LEVELS) {
          try {
            const probe = await runDiscoveryCommand(
              executablePath,
              ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--trust', '--skip-onboarding', '--no-auto-update', '--effort', effort],
              probeTimeout(),
              environment,
              true,
            );
            const result = classifyEffortProbe(probe);
            if (result === 'accepted') supported.push(effort);
            else if (result === 'unknown') unknown = true;
          } catch {
            unknown = true;
          }
        }
        // The exact shadow models are exhaustively probed, but also receive a
        // bounded invalid-value probe when the caller explicitly requests the
        // hybrid mode. This catches a CLI update that adds a new native value
        // instead of silently truncating it to the repository enum.
        if (options.probeAllValues === false && options.probeAllValuesForModels?.includes(model)) {
          const result = await probeEffortList(
            executablePath,
            model,
            probeTimeout(),
            environment,
          );
          unknown ||= result.unknown || result.values.some((effort) => !supported.includes(effort));
          supported.push(...result.values);
        }
        defaultEffort = supported.includes('medium') ? 'medium' : supported[0];
      }
      if (Date.now() >= deadline) throw new Error(`Command Code effort discovery timed out after ${totalTimeoutMs}ms`);

      // An inconclusive probe must not leave a plausible selector behind. Keep
      // the whole capability atomically fail-closed: unknown means no usable
      // levels, no default, and no native effort claim.
      const effortLevels = unknown ? [] : [...new Set(supported)];
      const status = unknown ? 'unknown' : effortLevels.length > 0 ? 'adjustable' : 'unavailable';
      const supportsEffort = effortLevels.length > 0 && !unknown;
      capabilities[model] = {
        supportsEffort,
        effortLevels,
        ...(supportsEffort && defaultEffort ? { defaultEffort } : {}),
        status,
        source: COMMAND_CODE_EFFORT_SOURCE,
        capabilityHash: effortCapabilityHash(model, { supportsEffort, effortLevels, status, ...(defaultEffort ? { defaultEffort } : {}) }),
      };
    }
    return { capabilities };
  });
}

async function runDiscoveryCommand(
  executablePath: string,
  args: string[],
  timeoutMs = COMMAND_CODE_DISCOVERY_TIMEOUT_MS,
  environment = controlledDiscoveryEnvironment(),
  allowNonZero = false,
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
      } else if (code !== 0 && !allowNonZero) {
        const error = new Error(`Command Code model discovery failed with exit ${code ?? signal ?? 'unknown'}`);
        (error as Error & { stderr?: string }).stderr = redactDiscoveryDiagnostics(stderr);
        finish(error);
      } else finish(undefined, code);
    });
  });
}

type EffortProbeClassification = 'accepted' | 'unsupported' | 'unknown';

interface ParsedSupportedEfforts {
  values: CommandCodeEffort[];
  unknown: boolean;
}

async function probeEffortList(
  executablePath: string,
  model: CommandCodeRuntimeModel,
  timeoutMs: number | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<ParsedSupportedEfforts> {
  try {
    const probe = await runDiscoveryCommand(
      executablePath,
      ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--trust', '--skip-onboarding', '--no-auto-update', '--effort', '__pi_web_ui_capability_probe__'],
      timeoutMs,
      environment,
      true,
    );
    const parsed = parseSupportedEfforts(probe.stdout, probe.stderr);
    if (parsed) return parsed;
    if (isNoAdjustableEffort(probe.stdout, probe.stderr)) return { values: [], unknown: false };
    return { values: [], unknown: true };
  } catch {
    return { values: [], unknown: true };
  }
}

function parseSupportedEfforts(stdout: string, stderr: string): ParsedSupportedEfforts | undefined {
  const diagnostics = `${stdout}\n${stderr}`;
  const match = diagnostics.match(/supported(?:\s+values?)?:\s*([^.!?\r\n]+)/i);
  if (!match) return undefined;
  const values = match[1]
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/^or\s+/, '').replace(/^['"`]+|['"`]+$/g, ''))
    .filter(Boolean);
  const supported = values.filter((value): value is CommandCodeEffort => (COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(value));
  return {
    values: [...new Set(supported)],
    unknown: values.some((value) => !(COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(value)),
  };
}

function isNoAdjustableEffort(stdout: string, stderr: string): boolean {
  return /no adjustable .*effort|effort not supported|does not support .*effort/i.test(`${stdout}\n${stderr}`);
}

function classifyEffortProbe(probe: { exitCode: number | null; stdout: string; stderr: string }): EffortProbeClassification {
  const diagnostics = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
  // Command Code exits through its auth gate after accepting a valid model /
  // effort pair. This is positive capability evidence, not an inference from
  // a successful model response.
  if (probe.exitCode === 3 || /authentication required|login required|not authenticated|missing credentials/.test(diagnostics)) return 'accepted';
  // `cmd -p` validates the native flag before it validates the query. In a
  // credential-scrubbed startup probe it may therefore emit this positive
  // acknowledgement and then stop with "no query provided". That is still
  // capability evidence, not a model-turn result.
  if (/reasoning effort set to\s+(?:low|medium|high|xhigh|max)\b/.test(diagnostics)) return 'accepted';
  if (/unsupported|not supported|no adjustable .*effort|invalid .*effort|unknown .*effort|invalid value|must be one of/.test(diagnostics)) return 'unsupported';
  if (probe.exitCode === 0) return 'accepted';
  return 'unknown';
}

function effortCapabilityHash(
  model: CommandCodeRuntimeModel,
  capability: Pick<CommandCodeEffortCapability, 'supportsEffort' | 'effortLevels' | 'defaultEffort' | 'status'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ model, ...capability }))
    .digest('hex');
}

async function withIsolatedDiscoveryHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-discovery-home-'));
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
