import { spawn } from 'node:child_process';

/** The only Command Code routes admitted by the first Internal API slice. */
export const COMMAND_CODE_MODELS = [
  'qwen/qwen3.8-max',
  'meta/muse-spark-1.2-contributor',
] as const;

export type CommandCodeModel = (typeof COMMAND_CODE_MODELS)[number];
export const COMMAND_CODE_VERSION = '1.15.0' as const;
export const COMMAND_CODE_PROVIDER = 'command-code' as const;

export interface CommandCodeModelDiscovery {
  version: string;
  models: CommandCodeModel[];
  ambiguous: string[];
}

/** Exact, case-sensitive route check. Aliases and friendly names are rejected. */
export function assertCommandCodeModel(value: unknown): CommandCodeModel | undefined {
  return (COMMAND_CODE_MODELS as readonly string[]).includes(value as string)
    ? value as CommandCodeModel
    : undefined;
}

/**
 * Parse the public `cmd --list-models` text without importing Command Code.
 * An exact id must occur exactly once to be considered advertised. The parser
 * intentionally ignores descriptions and short-name aliases.
 */
export function parseCommandCodeModelList(stdout: string): CommandCodeModelDiscovery {
  const version = stdout.match(/Command Code v(\d+(?:\.\d+){2})/i)?.[1] ?? 'unknown';
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const models: CommandCodeModel[] = [];
  const ambiguous: string[] = [];
  for (const expected of COMMAND_CODE_MODELS) {
    const matches = lines.filter((line) => new RegExp(`^${escapeRegExp(expected)}(?:\\s|$)`).test(line));
    if (matches.length === 1) models.push(expected);
    else if (matches.length > 1) ambiguous.push(expected);
  }
  return { version, models, ambiguous };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CommandCodeDiscoveryOptions {
  /** Bound startup discovery so a broken executable cannot wedge readiness. */
  timeoutMs?: number;
}

export interface CommandCodeDiscoveryRunner {
  (executablePath: string, options?: CommandCodeDiscoveryOptions): Promise<CommandCodeModelDiscovery>;
}

export const COMMAND_CODE_DISCOVERY_TIMEOUT_MS = 10_000;

/** Startup-only discovery. It never reads auth/config files. */
export const discoverCommandCodeModels: CommandCodeDiscoveryRunner = async (executablePath, options = {}) => {
  const versionProbe = await runDiscoveryCommand(executablePath, ['--no-auto-update', '--version'], options.timeoutMs);
  const modelsProbe = await runDiscoveryCommand(executablePath, ['--no-auto-update', '--list-models'], options.timeoutMs);
  const parsed = parseCommandCodeModelList(modelsProbe.stdout);
  const version = parsed.version === 'unknown'
    ? versionProbe.stdout.trim().match(/(?:v)?(\d+(?:\.\d+){2})/)?.[1] ?? 'unknown'
    : parsed.version;
  return { ...parsed, version };
};

async function runDiscoveryCommand(executablePath: string, args: string[], timeoutMs = COMMAND_CODE_DISCOVERY_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command Code discovery timeout must be positive');
  const child = spawn(executablePath, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: controlledDiscoveryEnvironment(),
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 100_000); });
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
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
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timeoutFinalizer) clearTimeout(timeoutFinalizer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
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
      } else finish();
    });
  });
}

const SAFE_DISCOVERY_ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TERM', 'NO_COLOR',
] as const;

function controlledDiscoveryEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_DISCOVERY_ENV_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function redactDiscoveryDiagnostics(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .slice(-2_000);
}
