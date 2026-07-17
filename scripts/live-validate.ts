#!/usr/bin/env npx tsx
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import { listScenarioIds, runScenario, scenarioRegistry } from '../server/src/live-validation/scenarios.js';
import { resolveValidationTarget } from '../server/src/live-validation/validation-safety.js';
import type { ValidationRuntime } from '../server/src/live-validation/types.js';

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    runtime: (get('--runtime') ?? 'claude') as ValidationRuntime | 'all',
    scenario: get('--scenario') ?? 'smoke',
    cwd: get('--cwd'),
    model: get('--model'),
    json: argv.includes('--json'),
    list: argv.includes('--list'),
    socketPath: get('--socket'),
    tokenPath: get('--token-path'),
    allowProduction: argv.includes('--allow-production'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log(JSON.stringify({ scenarios: listScenarioIds() }, null, 2));
    return;
  }

  const target = resolveValidationTarget({
    socketPath: args.socketPath,
    tokenPath: args.tokenPath,
    allowProduction: args.allowProduction,
  });

  if (target.usingProductionServer) {
    console.error('[live-validate] WARNING: using the running production Pi Web UI Internal API because --allow-production was supplied.');
  }
  const cwd = args.cwd ?? (target.usingProductionServer
    ? process.cwd()
    : path.join(path.dirname(target.socketPath), 'workspace'));
  if (!target.usingProductionServer) mkdirSync(cwd, { recursive: true });

  const client = new InternalApiClient({
    socketPath: target.socketPath,
    tokenPath: target.tokenPath,
  });
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
        cwd,
        model: args.model,
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
        const identity = [
          result.runId ? `run=${result.runId}` : null,
          result.model ? `model=${result.model}` : null,
          result.backendMode ? `backend=${result.backendMode}` : null,
          result.executionInstanceId ? `exec=${result.executionInstanceId}` : null,
          result.durationMs !== undefined ? `durationMs=${result.durationMs}` : null,
        ].filter(Boolean);
        if (identity.length > 0) console.log(`   evidence: ${identity.join(' ')}`);
        if (result.eventCounts) console.log(`   events: ${JSON.stringify(result.eventCounts)}`);
        for (const warning of result.cleanupWarnings ?? []) console.log(`   cleanup warning: ${warning}`);
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
