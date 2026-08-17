import path from 'node:path';
import { assertCommandCodeEffort, type CommandCodeEffort, type CommandCodeRuntimeModel } from './command-code-model-catalog.js';

export const COMMAND_CODE_EXECUTION_INSTANCE_ID = 'commandcode-default' as const;
export type CommandCodeExecutionInstanceId = typeof COMMAND_CODE_EXECUTION_INSTANCE_ID;

/**
 * The one permission profile: server-owned full-trust flags, matching the
 * trust level of the other four runtimes (OpenCode allow-all, Antigravity
 * --dangerously-skip-permissions). Callers never choose argv, executables,
 * env or profiles — this constant is the whole policy.
 */
export const COMMAND_CODE_ARGS = ['--trust', '--skip-onboarding', '--no-auto-update', '--yolo'] as const;

export interface CommandCodeRuntimeConfig {
  enabled: boolean;
  executablePath: string;
  stateDir: string;
  /** Private per-session native home root; never the operator's shared home. */
  nativeHomeDir: string;
  allowedCwdRoots: string[];
  maxTurns: number;
  maxPromptBytes: number;
  maxWallTimeMs: number;
  maxStdoutLineBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  processGraceMs: number;
  concurrency: number;
}

export interface CommandCodeArgOptions {
  executablePath: string;
  model: CommandCodeRuntimeModel;
  maxTurns: number;
  nativeSessionId?: string;
  effort?: CommandCodeEffort;
}

export function buildCommandCodeArgs(options: CommandCodeArgOptions): string[] {
  if (!path.isAbsolute(options.executablePath)) {
    throw new Error('Command Code executable path must be absolute');
  }
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 100) {
    throw new Error('Command Code maxTurns must be an integer from 1 to 100');
  }
  if (!isValidCommandCodeRuntimeModel(options.model)) {
    throw new Error(`Command Code model is not a valid exact runtime id: ${String(options.model)}`);
  }
  assertCommandCodeEffort(options.model, options.effort);
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', options.model,
    '--max-turns', String(options.maxTurns),
    ...COMMAND_CODE_ARGS,
  ];
  if (options.effort) args.push('--effort', options.effort);
  if (options.nativeSessionId) args.push('--resume', options.nativeSessionId);
  return args;
}

function isValidCommandCodeRuntimeModel(value: unknown): value is CommandCodeRuntimeModel {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[a-z0-9][a-z0-9._/-]*$/.test(value);
}

export function defaultCommandCodeConfig(overrides: Partial<CommandCodeRuntimeConfig> = {}): CommandCodeRuntimeConfig {
  const stateDir = overrides.stateDir ?? path.join(process.env.HOME || '/tmp', '.pi-web-ui', 'command-code');
  return {
    enabled: false,
    executablePath: '/root/.npm-global/bin/cmd',
    stateDir,
    nativeHomeDir: overrides.nativeHomeDir ?? path.join(stateDir, 'native-home'),
    allowedCwdRoots: overrides.allowedCwdRoots ?? [path.dirname(stateDir)],
    maxTurns: 100,
    maxPromptBytes: 100_000,
    maxWallTimeMs: 15 * 60_000,
    maxStdoutLineBytes: 512 * 1024,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    processGraceMs: 2_000,
    concurrency: 1,
    ...overrides,
  };
}
