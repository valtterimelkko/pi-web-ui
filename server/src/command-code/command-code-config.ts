import path from 'node:path';
import {
  assertCommandCodeEffort,
  assertCommandCodeModel,
  type CommandCodeEffort,
  type CommandCodeRuntimeModel,
} from './command-code-model-catalog.js';

export const COMMAND_CODE_EXECUTION_INSTANCE_ID = 'commandcode-default' as const;
export type CommandCodeExecutionInstanceId = typeof COMMAND_CODE_EXECUTION_INSTANCE_ID;
export type CommandCodePermissionProfile = 'agent-os-7f-root-readonly' | 'implementation-child-wide' | 'browser-contained';

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
  /** Legacy diagnostic override; readiness follows live discovery and never pins this value. */
  expectedVersion?: string;
  /** Browser exposure is separately gated from the Internal API shadow runtime. */
  browserEnabled?: boolean;
  /** Agent OS shadow routes remain separately gated from browser sessions. */
  shadowEnabled?: boolean;
  /** Explicit exact model allowlist; empty keeps browser containment unavailable. */
  browserAllowedModels?: string[];
  /** Explicit browser workspace roots; unlike shadow roots this never defaults to server state. */
  browserAllowedCwdRoots?: string[];
  /** Browser-only credential; never falls back to the operator's auth file. */
  browserAuthFile?: string;
  /** Server-owned bubblewrap binary used for browser-contained sessions. */
  browserSandboxExecutablePath?: string;
  /** Additional read-only runtime roots needed inside the browser sandbox. */
  browserRuntimeRoots?: string[];
}

export interface CommandCodeArgOptions {
  executablePath: string;
  model: CommandCodeRuntimeModel;
  maxTurns: number;
  permissionProfile: CommandCodePermissionProfile;
  nativeSessionId?: string;
  effort?: CommandCodeEffort;
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
  // This shadow profile is only reachable through the attested Agent OS path.
  args: ['--yolo', '--trust', '--skip-onboarding', '--no-auto-update'],
};
/** Browser callers can select this name only; they cannot select raw argv. */
const BROWSER_PROFILE: CommandCodeProfile = {
  name: 'browser-contained',
  // Browser sessions are launched inside the server-owned filesystem/process
  // boundary; the CLI itself remains in plan/read-only permission mode.
  args: ['--trust', '--skip-onboarding', '--no-auto-update', '--plan'],
};

export function getCommandCodeProfile(profile: CommandCodePermissionProfile): CommandCodeProfile {
  if (profile === ROOT_PROFILE.name) return ROOT_PROFILE;
  if (profile === CHILD_PROFILE.name) return CHILD_PROFILE;
  if (profile === BROWSER_PROFILE.name) return BROWSER_PROFILE;
  throw new Error(`Unknown Command Code permission profile: ${String(profile)}`);
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
  if (!assertCommandCodeModel(options.model)) {
    throw new Error(`Command Code model is not an exact allowlisted executable route: ${options.model}`);
  }
  assertCommandCodeEffort(options.model, options.effort);
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
    maxTurns: 8,
    maxPromptBytes: 100_000,
    maxWallTimeMs: 15 * 60_000,
    maxStdoutLineBytes: 512 * 1024,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    processGraceMs: 2_000,
    concurrency: 1,
    browserEnabled: false,
    shadowEnabled: overrides.shadowEnabled ?? overrides.enabled ?? false,
    browserAllowedModels: [],
    browserAllowedCwdRoots: [],
    browserAuthFile: undefined,
    browserSandboxExecutablePath: '/usr/bin/bwrap',
    browserRuntimeRoots: [],
    ...overrides,
  };
}
