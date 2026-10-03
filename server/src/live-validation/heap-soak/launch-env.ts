/**
 * Launcher switches for the E2 bounded soak (E2a-1), read from the
 * environment so the launch command carries them and no CLI surface
 * changes. Every reader is pure and fail-closed: an invalid value refuses
 * the launch rather than silently booting with today's default.
 */

export const RUNTIME_MAX_SEC_ENV_KEY = 'HEAP_SOAK_RUNTIME_MAX_SEC';

/** Below a minute a runtime bound would fight the harness's own startup, not act as a backstop. */
const MIN_RUNTIME_MAX_SEC = 60;

/**
 * `HEAP_SOAK_RUNTIME_MAX_SEC`: a `RuntimeMaxSec` backstop applied to the
 * run's transient units so an arm cannot outlive its window even if its own
 * teardown is killed (E2 containment rule: hard MemoryMax + RuntimeMaxSec).
 * Unset ⇒ undefined ⇒ no property (the historic behaviour).
 */
export function soakRuntimeMaxSec(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = (env[RUNTIME_MAX_SEC_ENV_KEY] ?? '').trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${RUNTIME_MAX_SEC_ENV_KEY} must be a whole number of seconds (got ${JSON.stringify(raw)})`);
  }
  if (value < MIN_RUNTIME_MAX_SEC) {
    throw new Error(`${RUNTIME_MAX_SEC_ENV_KEY} must be at least ${MIN_RUNTIME_MAX_SEC} seconds (got ${value})`);
  }
  return value;
}

export const VIEW_ONLY_SUBSCRIBE_ENV_KEY = 'HEAP_SOAK_VIEW_ONLY_SUBSCRIBE';

const VIEW_ONLY_ON_VALUES = new Set(['on', 'true', '1']);

/**
 * `HEAP_SOAK_VIEW_ONLY_SUBSCRIBE`: when on/true/1, the disposable server is
 * booted with `PI_WEB_UI_VIEW_ONLY_SUBSCRIBE=on` — the production setting
 * since wave J — so the soak exercises the view-only subscribe path exactly
 * as production does. Returns the env entries to add (empty when unset).
 * Any other non-blank value throws: a typo must not silently boot the soak
 * with the flag off while the run claims production fidelity.
 */
export function viewOnlySubscribeServerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = (env[VIEW_ONLY_SUBSCRIBE_ENV_KEY] ?? '').trim().toLowerCase();
  if (raw === '') return {};
  if (!VIEW_ONLY_ON_VALUES.has(raw)) {
    throw new Error(`${VIEW_ONLY_SUBSCRIBE_ENV_KEY} accepts on|true|1 (got ${JSON.stringify(raw)})`);
  }
  return { PI_WEB_UI_VIEW_ONLY_SUBSCRIBE: 'on' };
}
