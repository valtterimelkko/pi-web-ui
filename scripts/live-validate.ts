#!/usr/bin/env npx tsx
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import { listScenarioIds, runScenario, scenarioRegistry } from '../server/src/live-validation/scenarios.js';
import type { ValidationRuntime } from '../server/src/live-validation/types.js';

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    runtime: (get('--runtime') ?? 'claude') as ValidationRuntime | 'all',
    scenario: get('--scenario') ?? 'smoke',
    cwd: get('--cwd') ?? process.cwd(),
    json: argv.includes('--json'),
    list: argv.includes('--list'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log(JSON.stringify({ scenarios: listScenarioIds() }, null, 2));
    return;
  }

  const client = new InternalApiClient();
  const capabilities = await client.getCapabilities();
  const runtimes: ValidationRuntime[] = args.runtime === 'all'
    ? (['pi', 'claude', 'opencode'] as ValidationRuntime[]).filter((runtime) => capabilities.runtimes[runtime].available)
    : [args.runtime];

  const scenarioIds = args.scenario === 'all' ? listScenarioIds() : [args.scenario];
  const results = [];

  for (const runtime of runtimes) {
    for (const scenarioId of scenarioIds) {
      const scenario = scenarioRegistry[scenarioId];
      if (!scenario) {
        throw new Error(`Unknown scenario: ${scenarioId}`);
      }
      const result = await runScenario({
        client,
        runtime,
        scenario,
        capabilities,
        cwd: args.cwd,
      });
      results.push(result);
      if (!args.json) {
        const badge = result.skipped ? '⏭️' : result.passed ? '✅' : '❌';
        console.log(`${badge} ${runtime}:${scenarioId}`);
        for (const assertion of result.assertions) {
          console.log(`   ${assertion.passed ? '✓' : '✗'} ${assertion.name}${assertion.details ? ` — ${assertion.details}` : ''}`);
        }
        if (result.reason) {
          console.log(`   reason: ${result.reason}`);
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  }

  const failed = results.filter((result) => !result.passed && !result.skipped);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('[live-validate] Fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
