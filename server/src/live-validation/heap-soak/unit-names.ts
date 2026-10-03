/**
 * Soak systemd unit naming (E2a-1).
 *
 * COMMON-BRIEF-e2.md Host safety rule 1: every systemd unit a stress or proof
 * arm starts is named `e2a-<lane>-<what>`, because the E2 host guard's stop
 * rail halts exactly the `^e2a-` units on a hard trip — an arm not named that
 * way is outside its protection. The harness's historic prefix
 * (`pi-web-ui-soak`) stays the default so behaviour before E2 is unchanged;
 * an E2 run sets `HEAP_SOAK_UNIT_PREFIX=e2a-1` and gets `e2a-1-server-<run>`,
 * `e2a-1-supervisor-<run>` and the slice `e2a-1.slice`.
 */

export const UNIT_PREFIX_ENV_KEY = 'HEAP_SOAK_UNIT_PREFIX';

export const DEFAULT_SOAK_UNIT_PREFIX = 'pi-web-ui-soak';

/** Safe systemd unit-name fragment: starts alphanumeric, then [A-Za-z0-9._-], ≤ 64 chars. */
const UNIT_PREFIX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function resolveUnitPrefix(env: NodeJS.ProcessEnv): string {
  const raw = (env[UNIT_PREFIX_ENV_KEY] ?? '').trim();
  if (raw === '') return DEFAULT_SOAK_UNIT_PREFIX;
  if (!UNIT_PREFIX_PATTERN.test(raw)) {
    throw new Error(`${UNIT_PREFIX_ENV_KEY} must be a safe systemd unit-name fragment (${UNIT_PREFIX_PATTERN}; got ${JSON.stringify(raw)})`);
  }
  return raw;
}

/** The unit-name prefix for this run's transient units (default `pi-web-ui-soak`). */
export function soakUnitPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return resolveUnitPrefix(env);
}

/** The grouping slice for the run's units — named after the prefix so a guard stop rail that matches the prefix also matches the slice. */
export function soakSliceName(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveUnitPrefix(env)}.slice`;
}

/** The disposable server unit's name for a run id. */
export function serverUnitName(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveUnitPrefix(env)}-server-${runId}`;
}

/** The sampler/driver supervisor unit's name for a run id. */
export function supervisorUnitName(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveUnitPrefix(env)}-supervisor-${runId}`;
}
