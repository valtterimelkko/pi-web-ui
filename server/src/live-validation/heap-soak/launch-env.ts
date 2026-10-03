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
 * Runtime env keys the SUPERVISOR unit's processes read while the run is in
 * flight (lanes.ts's selection + Gate 1's quota seam + keep-server). The
 * transient supervisor unit starts from systemd's MANAGER environment plus an
 * explicit allowlist — anything not passed here silently reverts to its
 * default inside the supervisor (found live in E2a-1: HEAP_SOAK_LANES=A was
 * set on the launcher process but never propagated, so the run's supervisor
 * still dispatched the disabled lane B).
 */
const SUPERVISOR_PASSTHROUGH_KEYS = [
  'HEAP_SOAK_LANES',
  'HEAP_SOAK_MAX_CONCURRENT',
  'HEAP_SOAK_FORCE_BAD_LANE',
  'HEAP_SOAK_INJECT_QUOTA_SEQUENCE',
  'HEAP_SOAK_KEEP_SERVER',
] as const;

/** The subset of `env` the supervisor unit must receive (only keys that are set). */
export function supervisorEnvPassthrough(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SUPERVISOR_PASSTHROUGH_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

const CREDENTIALISH_KEY = /(token|secret|password|credential|apikey|api_key|authorization)/i;

/**
 * Correction 02: unit evidence (systemctl show Environment lines) may be
 * written into the retained run dir — credential-ish KEY=value pairs get their
 * VALUE replaced with REDACTED (a token FILE path is not a secret value and
 * survives; the file itself must not exist in evidence — see
 * scripts/e2a-soak/assert-evidence-clean.ts).
 */
export function redactEnvironmentForEvidence(text: string): string {
  const redactAssignments = (chunk: string): string =>
    chunk.replace(/([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, (whole, key: string, value: string) => {
      if (!CREDENTIALISH_KEY.test(key)) return whole;
      return `${key}=${/path|file|dir/i.test(key) ? value : 'REDACTED'}`;
    });
  // Parent FINAL correction 03: `systemctl show` prints `Environment=K1=v1 K2=v2`.
  // Strip the property prefix first, or the regex reads `Environment` as the key
  // and `K1=v1` as its value, leaking the FIRST assignment unredacted.
  return text
    .split('\n')
    .map((line) => {
      const m = /^(Environment=)(.*)$/.exec(line);
      return m ? `${m[1]}${redactAssignments(m[2])}` : redactAssignments(line);
    })
    .join('\n');
}

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
