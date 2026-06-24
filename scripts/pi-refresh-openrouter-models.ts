#!/usr/bin/env npx tsx
/**
 * Weekly Pi/OpenRouter model-refresh runner.
 *
 * Thin client over the Pi Web UI internal API (Unix socket + bearer token). It
 * asks the running server to fetch the public OpenRouter model catalogue, cache
 * it, register it into the Pi SDK ModelRegistry, and report a snapshot diff.
 *
 * No secrets live here or in the repo: the token is read from
 * ~/.pi-web-ui/internal-api-token, the OpenRouter models endpoint is public, and
 * the response contains provider/model ids only. Auth for OpenRouter routing is
 * auto-detected by the Pi SDK from the OPENROUTER_API_KEY env var. Designed to be
 * invoked by a systemd timer / cron on a weekly cadence.
 *
 * Usage:
 *   npm run pi:refresh-models            # fetch + cache + register + diff
 *   npm run pi:refresh-models -- --json  # machine-readable output
 *
 * Exit codes: 0 success, 1 failure (fail closed — never silently no-op).
 */
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';

function parseArgs(argv: string[]) {
  return {
    json: argv.includes('--json'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new InternalApiClient();

  const result = await client.refreshPiOpenRouterModels();

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { diff } = result;
  console.log('Pi/OpenRouter model refresh complete:');
  console.log(`  generatedAt:      ${result.generatedAt}`);
  console.log(`  providers:        ${result.providerCount}`);
  console.log(`  models:           ${result.modelCount}`);
  console.log(`  cache warmed:     ${result.cacheWarmed}`);
  console.log(`  registered:       ${result.registered ? 'yes' : 'no (OPENROUTER_API_KEY not set)'}`);
  console.log(`  snapshot:         ${result.snapshotPath}`);

  if (!diff.changed) {
    console.log('  changes:          none');
    return;
  }
  console.log('  changes:');
  if (diff.addedProviders.length) console.log(`    + providers: ${diff.addedProviders.join(', ')}`);
  if (diff.removedProviders.length) console.log(`    - providers: ${diff.removedProviders.join(', ')}`);
  if (diff.addedModels.length) {
    console.log(`    + ${diff.addedModels.length} model(s)`);
    const preview = diff.addedModels.slice(0, 20);
    for (const m of preview) console.log(`        + ${m}`);
    if (diff.addedModels.length > preview.length) {
      console.log(`        ... and ${diff.addedModels.length - preview.length} more`);
    }
  }
  if (diff.removedModels.length) {
    console.log(`    - ${diff.removedModels.length} model(s)`);
    const preview = diff.removedModels.slice(0, 20);
    for (const m of preview) console.log(`        - ${m}`);
    if (diff.removedModels.length > preview.length) {
      console.log(`        ... and ${diff.removedModels.length - preview.length} more`);
    }
  }
}

main().catch((err) => {
  console.error('Pi/OpenRouter model refresh failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
