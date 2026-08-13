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

export type CommandCodeModel = (typeof COMMAND_CODE_MODELS)[number];
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
  const version = stdout.match(/(?:Command\s+Code\s+)?v?(\d+(?:\.\d+){2})/i)?.[1] ?? 'unknown';
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
  /** Bound startup discovery so a broken executable cannot wedge readiness. */
  timeoutMs?: number;
  /** Restrict effort discovery to the freshly advertised exact ids. */
  models?: readonly CommandCodeRuntimeModel[];
  /**
   * Legacy shadow probing checks every known effort value. Browser discovery
   * can use one invalid-value probe and parse the CLI's supported-values list.
   */
  probeAllValues?: boolean;
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
    const version = parsed.version === 'unknown'
      ? versionProbe.stdout.trim().match(/(?:v)?(\d+(?:\.\d+){2})/)?.[1] ?? 'unknown'
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
    for (const model of models) {
      const supported: CommandCodeEffort[] = [];
      let unknown = false;
      let defaultEffort: CommandCodeEffort | undefined;

      if (options.probeAllValues === false) {
        try {
          const probe = await runDiscoveryCommand(
            executablePath,
            ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--trust', '--skip-onboarding', '--no-auto-update', '--effort', '__pi_web_ui_capability_probe__'],
            options.timeoutMs,
            environment,
            true,
          );
          const parsed = parseSupportedEfforts(probe.stdout, probe.stderr);
          if (parsed) supported.push(...parsed);
          else if (isNoAdjustableEffort(probe.stdout, probe.stderr)) {
            // Explicitly non-adjustable; this is a valid capability result.
          } else {
            unknown = true;
          }
        } catch {
          unknown = true;
        }
      } else {
        for (const effort of COMMAND_CODE_EFFORT_LEVELS) {
          try {
            const probe = await runDiscoveryCommand(
              executablePath,
              ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--trust', '--skip-onboarding', '--no-auto-update', '--effort', effort],
              options.timeoutMs,
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
        defaultEffort = supported.includes('medium') ? 'medium' : supported[0];
      }

      const effortLevels = [...new Set(supported)];
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

function parseSupportedEfforts(stdout: string, stderr: string): CommandCodeEffort[] | undefined {
  const diagnostics = `${stdout}\n${stderr}`;
  const match = diagnostics.match(/supported:\s*([^.!?\r\n]+)/i);
  if (!match) return undefined;
  const values = match[1].split(',').map((value) => value.trim().toLowerCase());
  const supported = values.filter((value): value is CommandCodeEffort => (COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(value));
  return supported.length > 0 ? supported : [];
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
