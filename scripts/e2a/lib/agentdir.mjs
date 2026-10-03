// E2a-3 harness — isolated Pi agent dir for disposable-server children.
// Correction 01 item 3: the builders are FAIL-CLOSED. auth.json is rebuilt from a
// validated schema that holds ONLY the top-level `zai` entry (a wholesale copy once
// gave the disposable server 9 providers' credentials — 11-note); models.json keeps
// only providers.zai with no apiKey anywhere. Unknown credential-bearing shapes are
// rejected (the arm fails), never silently filtered.

import fs from 'node:fs';
import path from 'node:path';

export const AGENT_CONFIG_ENTRIES = ['auth.json', 'models.json', 'settings.json', 'extensions'];

const API_KEY_KEY = /api[_-]?key/i;

function findApiKeyAnywhere(path_, value, errors) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = `${path_}.${k}`;
      if (API_KEY_KEY.test(k)) errors.push(`apiKey-named key anywhere is a foreign schema: ${p}`);
      findApiKeyAnywhere(p, v, errors);
    }
  }
}

function findNestedProviders(path_, value, errors) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = `${path_}.${k}`;
      if (k === 'providers' && path_ !== '$') errors.push(`nested providers map at ${p}`);
      findNestedProviders(p, v, errors);
    }
  }
}

/**
 * Rebuild models.json from the validated shape: `{ providers: { zai } }` — the only
 * fields kept; no apiKey anywhere (stripped from the zai subtree and re-scanned).
 * Rejects (throws) on: a top-level apiKey, any apiKey outside providers.zai, a nested
 * providers map, or a missing zai entry. Unknown top-level fields are never spread.
 */
export function buildModelsJson(models) {
  const errors = [];
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error('models.json: not a credential-bearing object we can validate (no zai entry)');
  }
  if ('apiKey' in models) errors.push('top-level apiKey in models.json');
  findNestedProviders('$', models, errors);
  const zai = models.providers?.zai;
  if (!zai || typeof zai !== 'object') errors.push('no zai entry in providers');
  if (errors.length > 0) throw new Error(`models.json rejected: ${errors.join('; ')}`);
  const out = { providers: { zai: stripApiKeys(zai) } };
  if (API_KEY_KEY.test(JSON.stringify(out))) throw new Error('models.json rejected: an apiKey survived stripping');
  return out;
}

/**
 * Rebuild auth.json from the validated schema. The real store is a FLAT top-level
 * provider map (`{ zai: { type, key }, … }` — verified 01:5xZ against production's
 * file, key paths only). The rebuilt result holds ONLY the `zai` entry with its known
 * fields `{ type, key }` (verbatim strings — auth.json IS the credential). Fail-closed:
 * rejects (throws, failing the arm) on a top-level `apiKey`, ANY apiKey-named key
 * anywhere, a nested `providers` map, an absent zai entry, or unknown/missing fields
 * inside the zai entry.
 */
export function buildAuthJson(auth) {
  const errors = [];
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('auth.json rejected: not a credential store object (no zai entry)');
  }
  if ('apiKey' in auth) errors.push('top-level apiKey in auth.json');
  findNestedProviders('$', auth, errors);
  findApiKeyAnywhere('$', auth, errors);
  const zai = auth.zai;
  if (!zai || typeof zai !== 'object' || Array.isArray(zai)) {
    errors.push('no zai entry in auth.json');
  } else {
    for (const [k, v] of Object.entries(zai)) {
      if (k !== 'type' && k !== 'key') errors.push(`unknown field in zai entry: ${k}`);
      else if (typeof v !== 'string' || v === '') errors.push(`zai.${k} must be a non-empty string`);
    }
    if (!('type' in zai)) errors.push('zai.type missing');
    if (!('key' in zai)) errors.push('zai.key missing');
  }
  if (errors.length > 0) throw new Error(`auth.json rejected: ${errors.join('; ')}`);
  return { zai: { type: zai.type, key: zai.key } };
}

function stripApiKeys(value) {
  if (Array.isArray(value)) return value.map(stripApiKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^api_?key$/i.test(k)) continue;
      out[k] = stripApiKeys(v);
    }
    return out;
  }
  return value;
}

/** Refuse a destination that overlaps the production agent dir in either direction,
 *  including string-prefix siblings like `<prod>-copy` (conservative: credential copies). */
export function assertIsolatedAgentDir(destDir, productionDir) {
  const dest = path.resolve(destDir);
  const prod = path.resolve(productionDir).replace(/\/+$/, '');
  if (dest === prod) throw new Error(`isolated agent dir must not be the production agent dir: ${dest}`);
  if (dest.startsWith(prod + path.sep)) throw new Error(`isolated agent dir must not live inside the production agent dir: ${dest}`);
  if (dest.startsWith(prod)) throw new Error(`isolated agent dir must not share the production agent dir path prefix: ${dest}`);
  if (prod.startsWith(dest + path.sep) || prod.startsWith(dest)) throw new Error(`isolated agent dir must not contain the production agent dir: ${dest}`);
}

/**
 * Build the isolated agent dir: allowlist copy (auth.json, models.json
 * filtered to zai-without-apiKey, settings.json, extensions/). Read-only on
 * the source. Returns what was copied for the run log (never credential content).
 */
export function buildAgentDir({ destDir, sourceDir }) {
  assertIsolatedAgentDir(destDir, sourceDir);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const copied = [];
  const skippedMissing = [];
  for (const entry of AGENT_CONFIG_ENTRIES) {
    const src = path.join(sourceDir, entry);
    const dst = path.join(destDir, entry);
    if (!fs.existsSync(src)) {
      skippedMissing.push(entry);
      continue;
    }
    if (entry === 'models.json') {
      const filtered = buildModelsJson(JSON.parse(fs.readFileSync(src, 'utf8')));
      fs.writeFileSync(dst, `${JSON.stringify(filtered, null, 2)}\n`, { mode: 0o600 });
    } else if (entry === 'auth.json') {
      const filtered = buildAuthJson(JSON.parse(fs.readFileSync(src, 'utf8')));
      fs.writeFileSync(dst, `${JSON.stringify(filtered)}\n`, { mode: 0o600 });
    } else {
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }
    copied.push(entry);
  }
  return { agentDir: destDir, copied, skippedMissing };
}
