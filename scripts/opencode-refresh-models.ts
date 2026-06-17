#!/usr/bin/env npx tsx
/**
 * Weekly OpenCode model-refresh runner.
 *
 * Thin client over the Pi Web UI internal API (Unix socket + bearer token). It
 * asks the running server to warm the models.dev cache, recycle the OpenCode
 * backend (idle-aware — deferred while sessions run), and report a snapshot diff.
 *
 * No secrets live here or in the repo: the token is read from
 * ~/.pi-web-ui/internal-api-token, and the response contains provider/model ids
 * only. Designed to be invoked by a systemd timer / cron on a weekly cadence.
 *
 * Usage:
 *   npm run opencode:refresh-models                 # warm cache + idle-aware recycle
 *   npm run opencode:refresh-models -- --no-recycle # snapshot/diff only
 *   npm run opencode:refresh-models -- --no-warm    # skip `opencode models` warm
 *   npm run opencode:refresh-models -- --json       # machine-readable output
 *
 * Exit codes: 0 success, 1 failure (fail closed — never silently no-op).
 */
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';

function parseArgs(argv: string[]) {
  return {
    recycle: !argv.includes('--no-recycle'),
    warmCache: !argv.includes('--no-warm'),
    json: argv.includes('--json'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new InternalApiClient();

  const result = await client.refreshOpenCodeModels({
    warmCache: args.warmCache,
    recycle: args.recycle,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { diff } = result;
  console.log('OpenCode model refresh complete:');
  console.log(`  generatedAt:      ${result.generatedAt}`);
  console.log(`  providers:        ${result.providerCount}`);
  console.log(`  models:           ${result.modelCount}`);
  console.log(`  cache warmed:     ${result.cacheWarmed}`);
  console.log(`  recycled backend: ${result.recycled}${result.recycleDeferred ? ' (deferred — sessions running)' : ''}`);
  console.log(`  snapshot:         ${result.snapshotPath}`);

  if (!diff.changed) {
    console.log('  changes:          none');
    return;
  }
  console.log('  changes:');
  if (diff.addedProviders.length) console.log(`    + providers: ${diff.addedProviders.join(', ')}`);
  if (diff.removedProviders.length) console.log(`    - providers: ${diff.removedProviders.join(', ')}`);
  if (diff.addedModels.length) {
    console.log(`    + ${diff.addedModels.length} model(s):`);
    for (const m of diff.addedModels) console.log(`        + ${m}`);
  }
  if (diff.removedModels.length) {
    console.log(`    - ${diff.removedModels.length} model(s):`);
    for (const m of diff.removedModels) console.log(`        - ${m}`);
  }
}

main().catch((err) => {
  console.error('OpenCode model refresh failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
