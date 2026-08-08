import path from 'node:path';
import { COMMAND_CODE_MODELS, type CommandCodeModel } from './command-code-model-catalog.js';

export const COMMAND_CODE_EXECUTION_INSTANCE_ID = 'commandcode-default' as const;
export type CommandCodeExecutionInstanceId = typeof COMMAND_CODE_EXECUTION_INSTANCE_ID;
export type CommandCodePermissionProfile = 'agent-os-7f-root-readonly' | 'implementation-child-wide';

export interface CommandCodeRuntimeConfig {
  enabled: boolean;
  executablePath: string;
  stateDir: string;
  allowedCwdRoots: string[];
  maxTurns: number;
  maxPromptBytes: number;
  maxWallTimeMs: number;
  maxStdoutLineBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  processGraceMs: number;
  concurrency: number;
  expectedVersion: string;
}

export interface CommandCodeArgOptions {
  executablePath: string;
  model: CommandCodeModel;
  maxTurns: number;
  permissionProfile: CommandCodePermissionProfile;
  nativeSessionId?: string;
  effort?: string;
}

export interface CommandCodeProfile {
  readonly name: CommandCodePermissionProfile;
  readonly args: readonly string[];
}

const ROOT_PROFILE: CommandCodeProfile = {
  name: 'agent-os-7f-root-readonly',
  args: ['--trust', '--skip-onboarding', '--no-auto-update', '--plan'],
};
const CHILD_PROFILE: CommandCodeProfile = {
  name: 'implementation-child-wide',
  args: ['--yolo', '--trust', '--skip-onboarding', '--no-auto-update'],
};

export function getCommandCodeProfile(profile: CommandCodePermissionProfile): CommandCodeProfile {
  return profile === ROOT_PROFILE.name ? ROOT_PROFILE : CHILD_PROFILE;
}

export function buildCommandCodeArgs(options: CommandCodeArgOptions): string[] {
  if (!path.isAbsolute(options.executablePath)) {
    throw new Error('Command Code executable path must be absolute');
  }
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 100) {
    throw new Error('Command Code maxTurns must be an integer from 1 to 100');
  }
  if (!COMMAND_CODE_MODELS.includes(options.model)) {
    throw new Error(`Command Code model is not allowlisted: ${String(options.model)}`);
  }
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', options.model,
    '--max-turns', String(options.maxTurns),
    ...getCommandCodeProfile(options.permissionProfile).args,
  ];
  if (options.effort) args.push('--effort', options.effort);
  if (options.nativeSessionId) args.push('--resume', options.nativeSessionId);
  return args;
}

export function defaultCommandCodeConfig(overrides: Partial<CommandCodeRuntimeConfig> = {}): CommandCodeRuntimeConfig {
  const stateDir = overrides.stateDir ?? path.join(process.env.HOME || '/tmp', '.pi-web-ui', 'command-code');
  return {
    enabled: false,
    executablePath: '/root/.npm-global/bin/cmd',
    stateDir,
    allowedCwdRoots: overrides.allowedCwdRoots ?? [path.dirname(stateDir)],
    maxTurns: 8,
    maxPromptBytes: 100_000,
    maxWallTimeMs: 15 * 60_000,
    maxStdoutLineBytes: 512 * 1024,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    processGraceMs: 2_000,
    concurrency: 1,
    expectedVersion: '1.15.0',
    ...overrides,
  };
}
