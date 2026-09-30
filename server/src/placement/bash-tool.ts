/**
 * D0 replacement bash tool (01-answer.md amendment D): the built-in definition built by
 * the SDK's own `createBashToolDefinition` with the session-settings-derived options
 * (`commandPrefix`, `shellPath`, environment exposure) plus our `spawnHook` — behaviour
 * equivalent apart from placement. Injected via `customTools`, which overrides the
 * built-in by name; the upstream-change alarm asserts that override still holds.
 */
import {
  createBashToolDefinition,
  type BashSpawnContext,
  type BashSpawnHook,
} from '@earendil-works/pi-coding-agent';
import type { PlacementConfig } from './config.js';
import { placementBashEnv, placementBashPrefixLine } from './spawn-wrap.js';

export const PLACEMENT_ENV_KEYS = [
  'PI_TOOLS_CG',
  'PI_TOOLS_ROOT',
  'PI_TOOLS_GROUP',
  'PI_TOOLS_MEM_MAX',
  'PI_TOOLS_MEM_HIGH',
  'PI_TOOLS_PIDS_MAX',
  'PI_TOOLS_SWAP_MAX',
  'PI_TOOLS_SHELL',
  'PI_TOOLS_DEGRADE_FILE',
] as const;

/** Identity when placement is off (returns the SAME context object — byte-identical). */
export function createPlacementSpawnHook(cfg: PlacementConfig, sessionId: string): BashSpawnHook {
  if (!cfg.enabled) return (ctx: BashSpawnContext) => ctx;
  const env = placementBashEnv(cfg, sessionId);
  if (!env) return (ctx: BashSpawnContext) => ctx;
  return (ctx: BashSpawnContext) => ({
    command: `${placementBashPrefixLine(cfg)}\n${ctx.command}`,
    cwd: ctx.cwd,
    env: { ...ctx.env, ...env },
  });
}

export interface PlacementBashToolOptions {
  cfg: PlacementConfig;
  sessionId: string;
  cwd: string;
  /** Session settings manager (same instance the session gets, so derived options match). */
  settings?: { getShellCommandPrefix?(): string | undefined; getShellPath?(): string | undefined } | undefined;
}

export function createPlacementBashToolDefinition(opts: PlacementBashToolOptions): ReturnType<typeof createBashToolDefinition> {
  const commandPrefix = opts.settings?.getShellCommandPrefix?.();
  const shellPath = opts.settings?.getShellPath?.();
  return createBashToolDefinition(opts.cwd, {
    commandPrefix: commandPrefix || undefined,
    shellPath: shellPath || undefined,
    exposeSessionEnvironment: true,
    spawnHook: createPlacementSpawnHook(opts.cfg, opts.sessionId),
  });
}

/**
 * Upstream-change alarm (runtime half): returns false — and callers log a warning plus a
 * degrade — when the session's active `bash` tool is not our definition (for example a
 * future SDK stopping `customTools` from overriding built-ins). Degrades to the built-in.
 */
export function isActiveBashOurs(session: { getToolDefinition(name: string): unknown }, ours: unknown): boolean {
  let active: unknown;
  try {
    active = session.getToolDefinition('bash');
  } catch {
    return false;
  }
  return active === ours;
}
