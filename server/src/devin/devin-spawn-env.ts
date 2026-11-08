import os from 'node:os';

/**
 * Plan D2 (frozen): spawn `devin acp` with an explicit allow-listed
 * environment — HOME, PATH, LANG, TERM, plus optional DEVIN_* the server sets
 * deliberately. The server's own environment is NEVER forwarded: hooks
 * inherit the spawning process's environment, and the trial proved a Claude
 * session's tokens leak into Devin hook logs when the full env is passed
 * (DEVIN-PARITY-PLAN §2, hook env row).
 */

export const DEVIN_ENV_ALLOWLIST: readonly string[] = ['HOME', 'PATH', 'LANG', 'TERM'];

/** True when a parent-env key may pass through: allow-listed verbatim or a
 *  DEVIN_* variable the server sets on purpose (e.g. DEVIN_PROJECT_DIR). */
export function isDevinEnvKeyAllowed(key: string): boolean {
  return DEVIN_ENV_ALLOWLIST.includes(key) || key.startsWith('DEVIN_');
}

/** Build the child environment. `homeOverride` (throwaway in tests and
 *  validation) wins over the parent's HOME; with no override the real home
 *  directory is used (plan D1: one Devin home in production). */
export function devinSpawnEnv(
  homeOverride: string | undefined,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isDevinEnvKeyAllowed(key)) env[key] = value;
  }
  env.HOME = homeOverride ?? os.homedir();
  if (!env.PATH || env.PATH.trim() === '') env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  if (!env.TERM) env.TERM = 'dumb';
  return env;
}
