/**
 * Credential scope for the isolated agent dir (E2a-1, parent condition in
 * 01-answer.md).
 *
 * The binding rule (E2 common brief; agent-os-child §3) is to copy only the
 * approved route's credential. The harness's historic full copy carried every
 * provider's credential — which is exactly how the unauthorised OpenRouter
 * call in smoke 1 became possible (the server boot log advertised every
 * provider "with auth"). When `HEAP_SOAK_CREDENTIAL_PROVIDERS` is set, the
 * isolated agent dir is reduced to those providers' credentials:
 *
 *  - `auth.json` keeps only the allowed providers' entries;
 *  - `models.json` drops any provider entry that carries an `apiKey` for a
 *    non-allowed provider (entries without credentials stay — they are just
 *    model catalogue data);
 *  - boot is refused unless every allowed provider still has a credential in
 *    one of the two files — the run depends on it.
 *
 * Unset ⇒ no scoping (the historic behaviour). All functions are pure and
 * unit-tested on synthetic shapes; no real secret is ever read by tests.
 */

export const CREDENTIAL_PROVIDERS_ENV_KEY = 'HEAP_SOAK_CREDENTIAL_PROVIDERS';

/** undefined when unset/blank (no scoping); otherwise the trimmed provider list. Fail-closed on empty tokens. */
export function parseAllowedProviders(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = (env[CREDENTIAL_PROVIDERS_ENV_KEY] ?? '').trim();
  if (raw === '') return undefined;
  const parts = raw.split(',').map((s) => s.trim());
  const empty = parts.filter((p) => p === '');
  if (empty.length > 0) {
    throw new Error(`${CREDENTIAL_PROVIDERS_ENV_KEY} contains an empty provider name (check for stray commas): ${JSON.stringify(raw)}`);
  }
  return parts;
}

/** auth.json reduced to the allowed providers' entries (input untouched). */
export function scopeAuthJson(auth: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const keep = new Set(allowed);
  return Object.fromEntries(Object.entries(auth).filter(([provider]) => keep.has(provider)));
}

export interface ScopedModelsResult {
  scoped: Record<string, unknown>;
  /** Provider entries that were dropped BECAUSE they carried an apiKey for a non-allowed provider. */
  droppedCredentialProviders: string[];
}

/** True when any key named `apiKey`/`api_key` appears anywhere inside the value. */
function carriesCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesCredentialKey);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === 'apiKey' || k === 'api_key' || carriesCredentialKey(v));
  }
  return false;
}

/**
 * models.json reduced: provider entries carrying an `apiKey` survive only for
 * allowed providers; credential-free entries (model catalogue data) stay.
 *
 * Correction 02 (Luna r1 major): a credential hiding in any TOP-LEVEL field
 * other than `providers` (e.g. `legacy.apiKey`, or nested `legacy.auth.api_key`)
 * used to be spread through unchanged — fail-open. It is now REJECTED: scope
 * refuses rather than silently dropping or spreading a credential-bearing
 * field. Sibling provider entries INSIDE `providers` legitimately carry
 * apiKeys in the real store and keep the drop-or-keep behaviour.
 */
export function scopeModelsJson(models: Record<string, unknown>, allowed: readonly string[]): ScopedModelsResult {
  for (const [field, value] of Object.entries(models)) {
    if (field === 'providers') continue;
    if (carriesCredentialKey(value)) {
      throw new Error(`models.json carries a credential key (apiKey/api_key) in the top-level field "${field}" outside "providers" — refusing to scope it; remove the field from the source file or move it under providers`);
    }
  }
  const providers = models.providers;
  if (typeof providers !== 'object' || providers === null) {
    return { scoped: {}, droppedCredentialProviders: [] };
  }
  const keep = new Set(allowed);
  const dropped: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const [provider, entry] of Object.entries(providers as Record<string, unknown>)) {
    const carriesApiKey = typeof entry === 'object' && entry !== null && 'apiKey' in entry;
    if (carriesApiKey && !keep.has(provider)) {
      dropped.push(provider);
      continue;
    }
    kept[provider] = entry;
  }
  return { scoped: { ...models, providers: kept }, droppedCredentialProviders: dropped };
}

/** Refuses to run when an allowed provider has no credential in either file — the scoped run depends on it. */
export function assertAllowedProviderPresent(
  auth: Record<string, unknown>,
  allowed: readonly string[],
  models?: Record<string, unknown>,
): void {
  const modelsProviders = (typeof models?.providers === 'object' && models.providers !== null)
    ? models.providers as Record<string, unknown>
    : {};
  const missing = allowed.filter((provider) => {
    const inAuth = typeof auth[provider] === 'object' && auth[provider] !== null;
    const inModels = typeof modelsProviders[provider] === 'object'
      && modelsProviders[provider] !== null
      && 'apiKey' in (modelsProviders[provider] as Record<string, unknown>);
    return !inAuth && !inModels;
  });
  if (missing.length > 0) {
    throw new Error(`scoped agent dir has no credential for allowed provider(s): ${missing.join(', ')} — the scoped run depends on them; fix HEAP_SOAK_CREDENTIAL_PROVIDERS or the source agent dir`);
  }
}
