#!/usr/bin/env npx tsx
/**
 * Long-horizon live validation CLI.
 *
 * Drives a real subject agent session through the Internal API and waits for
 * declared, runtime-neutral conditions to fire over a long horizon — with no
 * human in the loop. The waiting is done by polling a durable server-side
 * watch, so the validator never holds a connection open and can survive a
 * server restart between polls.
 *
 * Modes:
 *   --mode daemon  (default)  start, then poll on a timer until done
 *   --mode start              create subject + watch + seed, persist state, exit
 *   --mode once               run a single poll on an existing --state file, exit
 *                             (exit 0 passed, 2 still running, 1 timeout/failed)
 *   --keep-watch              keep the server-side watch ledger after success/failure
 *   --allow-production        explicitly permit targeting the running production Web UI
 *
 * Conditions (repeatable, combined):
 *   --watch-event <type>      match a NormalizedEvent type (e.g. agent_end)
 *   --watch-tool <name>       match a tool call (e.g. Bash)
 *   --watch-text <substring>  match assistant text containing a substring
 *   --watch-json '<json>'     full WatchConditionSpec[] for advanced predicates
 *
 * Examples:
 *   npm run validate:long-horizon -- --subject pi --seed "Run: echo hi" \
 *     --watch-tool Bash --interval 5 --max-wait 120
 *   npm run validate:long-horizon -- --session <id> --mode once --state run.json
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import {
  finalize,
  loadState,
  runToCompletion,
  startRun,
  tick,
  type LongHorizonConfig,
  type StopWhen,
} from '../server/src/live-validation/long-horizon-runner.js';
import { resolveValidationTarget } from '../server/src/live-validation/validation-safety.js';
import type { WatchConditionSpec } from '../server/src/internal-api/types.js';
import type { ValidationRuntime } from '../server/src/live-validation/types.js';

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function collectAll(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  }
  return out;
}

function buildConditions(argv: string[]): WatchConditionSpec[] {
  const conditions: WatchConditionSpec[] = [];
  for (const json of collectAll(argv, '--watch-json')) {
    const parsed = JSON.parse(json) as WatchConditionSpec[];
    if (Array.isArray(parsed)) conditions.push(...parsed);
  }
  for (const eventType of collectAll(argv, '--watch-event')) {
    conditions.push({ type: 'event_type', eventType });
  }
  for (const toolName of collectAll(argv, '--watch-tool')) {
    conditions.push({ type: 'tool', toolName });
  }
  for (const contains of collectAll(argv, '--watch-text')) {
    conditions.push({ type: 'text', contains });
  }
  return conditions;
}

function logger(message: string): void {
  console.error(`[long-horizon] ${message}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = (getFlag(argv, '--mode') ?? 'daemon') as 'daemon' | 'start' | 'once';
  const asJson = argv.includes('--json');

  const target = resolveValidationTarget({
    socketPath: getFlag(argv, '--socket'),
    tokenPath: getFlag(argv, '--token-path'),
    allowProduction: argv.includes('--allow-production'),
  });

  if (target.usingProductionServer) {
    console.error('[long-horizon] WARNING: using the running production Pi Web UI Internal API because --allow-production was supplied.');
  }

  const client = new InternalApiClient({
    socketPath: target.socketPath,
    tokenPath: target.tokenPath,
  });

  // ── once: drive a single poll on an existing run-state file ──
  if (mode === 'once') {
    const statePath = getFlag(argv, '--state');
    if (!statePath) throw new Error('--mode once requires --state <path>');
    const state = await loadState(statePath);
    state.statePath = statePath;
    const result = await tick(state, client, logger);
    if (result.done) {
      await finalize(state, { client, conditions: state.conditions, statePath, logger, keepWatch: state.keepWatch });
    }
    if (asJson) console.log(JSON.stringify(state, null, 2));
    else console.error(`[long-horizon] ${state.status}: ${state.verdict ?? 'still running'}`);
    process.exit(state.status === 'passed' ? 0 : state.status === 'running' ? 2 : 1);
  }

  const conditions = buildConditions(argv);
  if (conditions.length === 0) {
    throw new Error('At least one condition is required (--watch-event / --watch-tool / --watch-text / --watch-json)');
  }

  const statePath = getFlag(argv, '--state')
    ?? path.join(homedir(), '.pi-web-ui', 'long-horizon-runs', `${randomUUID()}.json`);

  const config: LongHorizonConfig = {
    client,
    subjectRuntime: getFlag(argv, '--session') ? undefined : (getFlag(argv, '--subject') ?? 'pi') as ValidationRuntime,
    existingSessionId: getFlag(argv, '--session'),
    cwd: getFlag(argv, '--cwd') ?? process.cwd(),
    model: getFlag(argv, '--model'),
    seedPrompt: getFlag(argv, '--seed'),
    conditions,
    stopWhen: (getFlag(argv, '--stop') ?? 'all') as StopWhen,
    pin: !argv.includes('--pin-off'),
    label: getFlag(argv, '--label'),
    pollIntervalMs: Number(getFlag(argv, '--interval') ?? '30') * 1000,
    maxWaitMs: Number(getFlag(argv, '--max-wait') ?? '3600') * 1000,
    probePrompt: getFlag(argv, '--probe'),
    keepSubject: argv.includes('--keep'),
    keepWatch: argv.includes('--keep-watch'),
    statePath,
    logger,
  };

  // ── start: provision + seed, persist state, hand off to a scheduler ──
  if (mode === 'start') {
    const { state } = await startRun(config);
    if (asJson) console.log(JSON.stringify(state, null, 2));
    else {
      console.error(`[long-horizon] started run ${state.runId}`);
      console.error(`[long-horizon] subject=${state.subjectSessionId} state=${statePath}`);
      console.error(`[long-horizon] resume with: --mode once --state ${statePath}`);
    }
    process.exit(0);
  }

  // ── daemon: poll to completion in-process ──
  const finalState = await runToCompletion(config);
  if (asJson) {
    console.log(JSON.stringify(finalState, null, 2));
  } else {
    const badge = finalState.status === 'passed' ? '✅' : finalState.status === 'timeout' ? '⏱️' : '❌';
    console.error(`${badge} [long-horizon] ${finalState.status}: ${finalState.verdict ?? ''}`);
    if (finalState.probeAnswer) console.error(`[long-horizon] probe → ${finalState.probeAnswer.slice(0, 200)}`);
  }
  process.exit(finalState.status === 'passed' ? 0 : 1);
}

main().catch((error) => {
  console.error('[long-horizon] Fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
