// E2a-3 harness — isolated Pi agent dir for disposable-server children.
// Mirrors scripts/heap-soak/agent-dir.ts (allowlist copy) but keeps ONLY the
// zai credential (COMMON-BRIEF-e2.md: "Copy only the zai credential") with
// apiKey entries stripped (credentials travel via auth.json, never models.json).

import fs from 'node:fs';
import path from 'node:path';

export const AGENT_CONFIG_ENTRIES = ['auth.json', 'models.json', 'settings.json', 'extensions'];

/** Keep only the `zai` provider; drop every apiKey field wherever it appears. */
export function filterModelsJson(models) {
  const providers = models?.providers;
  const out = { ...(models ?? {}), providers: {} };
  if (Array.isArray(providers)) return out; // unknown/legacy shape: keep nothing
  if (providers && typeof providers === 'object') {
    if (providers.zai && typeof providers.zai === 'object') {
      out.providers.zai = stripApiKeys(providers.zai);
    }
  }
  return out;
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
      const filtered = filterModelsJson(JSON.parse(fs.readFileSync(src, 'utf8')));
      fs.writeFileSync(dst, `${JSON.stringify(filtered, null, 2)}\n`, { mode: 0o600 });
    } else {
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }
    copied.push(entry);
  }
  return { agentDir: destDir, copied, skippedMissing };
}
