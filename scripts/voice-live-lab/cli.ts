#!/usr/bin/env node
/**
 * Voice Live Lab CLI (L0 + L1).
 *
 *   npx tsx scripts/voice-live-lab/cli.ts verify <attemptDir> [--json]
 *   npx tsx scripts/voice-live-lab/cli.ts handshake [--output <path>] [--json]
 *
 * `verify` is the offline trust boundary: it re-derives the mechanical facts
 * from an attempt record without a browser, a provider or the network, and
 * exits non-zero if the record is damaged, unfinalised or internally
 * inconsistent.
 *
 * `handshake` executes the Phase L1 capability and quota probes against
 * real Live models and judge endpoints, writing capabilities.json.
 */

import { verifyAttempt } from './lib/record.js';
import { runHandshake, type CapabilitiesReport } from './lib/handshake.js';
import { runDryAttempt } from './lib/baseline-dryrun.js';
import { runTier1DryAttempt, runTier1MeasuredAttempt } from './lib/tier1-dryrun.js';

export type CliCommand = 'verify' | 'handshake' | 'baseline-dryrun' | 'tier1-dryrun' | 'tier1-run' | 'help';

export interface CliOptions {
  command: CliCommand;
  attemptDir?: string;
  outputPath?: string;
  scenarioPath?: string;
  runsRoot?: string;
  attempts?: number;
  frameIntervalMs?: number;
  stabilityMs?: number;
  condition?: 'native' | 'sidecar';
  model?: string;
  whisperEndpoint?: string;
  runId?: string;
  json?: boolean;
  requireFinalised?: boolean;
}

export const DEFAULT_RUNS_ROOT = '/root/agent-benchmarks/benchmarks/04-voice-live-lab/runs';
export const DEFAULT_SCENARIO_PATH =
  '/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/t1-s1-orchestration-voice.json';

export const USAGE = [
  'Voice Live Lab (Phase L0/L1/L2/L4)',
  '',
  'Usage:',
  '  voice-live-lab verify <attemptDir> [--json] [--allow-unfinalised]',
  '  voice-live-lab handshake [--output <path>] [--json]',
  '  voice-live-lab baseline-dryrun [--scenario <path>] [--runs-root <dir>] [--attempts N] [--frame-interval-ms N] [--json]',
  '  voice-live-lab tier1-dryrun [--scenario <path>] [--runs-root <dir>] [--run-id <id>] [--attempts N] [--condition native|sidecar] [--stability-ms N] [--frame-interval-ms N] [--json]',
  '  voice-live-lab tier1-run --scenario <path> [--condition native|sidecar] [--model <id>] [--whisper-endpoint <url>] [--runs-root <dir>] [--json]   (needs GEMINI_API_KEY)',
  '  voice-live-lab help',
  '',
  'Commands:',
  '  verify <attemptDir>   Re-check an attempt record offline; exit 1 on damage.',
  '  handshake             Probe Gemini Live models & judge endpoints; writes capabilities.json.',
  '  baseline-dryrun       Hermetic baseline-cascade attempt(s): scripted STT/TTS, real talker gate,',
  '                        immutable record + offline verify. No provider is called.',
  '  tier1-dryrun          Hermetic GUARDED NATIVE attempt(s) (L4): scripted live client + scripted',
  '                        shadow ASR, real policy core, 400 ms commit rule, immutable record +',
  '                        offline verify. No provider is called (mode: dry-run).',
  '  tier1-run             One MEASURED tier-1 attempt against the real Gemini Live session',
  '                        (whisper shadow). Refuses without GEMINI_API_KEY.',
  '  help                  Show this message.',
].join('\n');

export function parseArgs(argv: string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command === 'verify') {
    const attemptDir = rest.find((value) => !value.startsWith('-'));
    if (!attemptDir) throw new Error('Usage: voice-live-lab verify <attemptDir>');
    return {
      command: 'verify',
      attemptDir,
      json: rest.includes('--json'),
      requireFinalised: !rest.includes('--allow-unfinalised'),
    };
  }
  if (command === 'handshake') {
    const outIdx = rest.indexOf('--output');
    const outputPath = outIdx !== -1 && rest[outIdx + 1] ? rest[outIdx + 1] : undefined;
    return {
      command: 'handshake',
      outputPath,
      json: rest.includes('--json'),
    };
  }
  if (command === 'baseline-dryrun' || command === 'tier1-dryrun' || command === 'tier1-run') {
    const opt = (name: string): string | undefined => {
      const idx = rest.indexOf(name);
      return idx !== -1 && rest[idx + 1] ? rest[idx + 1] : undefined;
    };
    const attemptsRaw = opt('--attempts');
    const frameRaw = opt('--frame-interval-ms');
    const stabilityRaw = opt('--stability-ms');
    const conditionRaw = opt('--condition');
    const condition = conditionRaw === 'sidecar' ? 'sidecar' : conditionRaw === 'native' ? 'native' : undefined;
    return {
      command,
      scenarioPath: opt('--scenario') ?? DEFAULT_SCENARIO_PATH,
      runsRoot: opt('--runs-root') ?? DEFAULT_RUNS_ROOT,
      runId: opt('--run-id'),
      attempts: attemptsRaw ? Math.max(1, Number.parseInt(attemptsRaw, 10)) : 1,
      frameIntervalMs: frameRaw ? Math.max(1, Number.parseInt(frameRaw, 10)) : undefined,
      stabilityMs: stabilityRaw ? Math.max(1, Number.parseInt(stabilityRaw, 10)) : undefined,
      condition,
      model: opt('--model'),
      whisperEndpoint: opt('--whisper-endpoint'),
      json: rest.includes('--json'),
    };
  }
  throw new Error(`Unknown command: ${command}`);
}

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

export function runVerify(attemptDir: string, options: { json?: boolean; requireFinalised?: boolean } = {}): CliResult {
  const requireFinalised = options.requireFinalised ?? true;
  const outcome = verifyAttempt(attemptDir, { requireFinalised });
  if (options.json) {
    return {
      code: outcome.ok ? 0 : 1,
      stdout: [JSON.stringify({ ok: outcome.ok, lines: outcome.lines, problems: outcome.problems }, null, 2)],
      stderr: [],
    };
  }
  return {
    code: outcome.ok ? 0 : 1,
    stdout: outcome.ok ? [`OK: ${attemptDir}`, ...outcome.lines] : [`FAILED: ${attemptDir}`],
    stderr: outcome.problems.map((problem) => `problem: ${problem}`),
  };
}

export interface CliDependencies {
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
  verify?: (attemptDir: string, options: { json?: boolean; requireFinalised?: boolean }) => CliResult;
  handshake?: (options: { outputPath?: string; log?: (line: string) => void }) => Promise<CapabilitiesReport>;
  dryRun?: typeof runDryAttempt;
  tier1DryRun?: typeof runTier1DryAttempt;
  tier1Run?: typeof runTier1MeasuredAttempt;
  apiKey?: () => string | undefined;
}

export async function main(argv: string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.writeOut ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const verify = deps.verify ?? runVerify;
  const handshake = deps.handshake ?? runHandshake;
  const dryRun = deps.dryRun ?? runDryAttempt;
  const tier1DryRun = deps.tier1DryRun ?? runTier1DryAttempt;
  const tier1Run = deps.tier1Run ?? runTier1MeasuredAttempt;
  const apiKey = deps.apiKey ?? (() => process.env.GEMINI_API_KEY);

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeErr(error instanceof Error ? error.message : String(error));
    writeErr(USAGE);
    return 2;
  }

  if (options.command === 'help') {
    writeOut(USAGE);
    return 0;
  }

  if (options.command === 'verify') {
    const result = verify(options.attemptDir as string, {
      json: options.json,
      requireFinalised: options.requireFinalised,
    });
    for (const line of result.stdout) writeOut(line);
    for (const line of result.stderr) writeErr(line);
    return result.code;
  }

  if (options.command === 'handshake') {
    try {
      const report = await handshake({
        outputPath: options.outputPath,
        log: options.json ? undefined : writeOut,
      });
      if (options.json) {
        writeOut(JSON.stringify(report, null, 2));
      } else {
        writeOut(`Handshake completed successfully. Status: ${report.rateLimits.status}`);
      }
      return report.rateLimits.status === 'ok' ? 0 : 1;
    } catch (error) {
      writeErr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (options.command === 'baseline-dryrun') {
    const runId = options.runId ?? `dryrun-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    return runAttempts(writeOut, writeErr, options, runId, async (scenarioPath, attemptOptions) => dryRun(scenarioPath, attemptOptions));
  }

  if (options.command === 'tier1-dryrun') {
    const runId = options.runId ?? `tier1-dryrun-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    return runAttempts(writeOut, writeErr, options, runId, (scenarioPath, attemptOptions) =>
      tier1DryRun(scenarioPath, {
        ...attemptOptions,
        condition: options.condition,
        stabilityMs: options.stabilityMs,
      })
    );
  }

  if (options.command === 'tier1-run') {
    const key = apiKey();
    if (!key) {
      writeErr('tier1-run refuses to start: GEMINI_API_KEY is not set (a measured run must never be unlabelled).');
      return 2;
    }
    const runId = options.runId ?? `tier1-measured-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    return runAttempts(writeOut, writeErr, options, runId, (scenarioPath, attemptOptions) =>
      tier1Run({
        ...attemptOptions,
        scenarioPath,
        apiKey: key,
        condition: options.condition,
        model: options.model,
        whisperEndpoint: options.whisperEndpoint,
      })
    );
  }

  return 0;
}

/** Shared attempt loop for the baseline/tier1 dry-run and measured commands. */
async function runAttempts(
  writeOut: (line: string) => void,
  writeErr: (line: string) => void,
  options: CliOptions,
  runId: string,
  run: (
    scenarioPath: string,
    attemptOptions: { runsRoot: string; runId: string; attemptId: string; frameIntervalMs?: number; quiet: true }
  ) => Promise<{ attempt: { attemptDir: string }; verifyOk: boolean; verifyProblems: string[]; turns: number; releases: number }>
): Promise<number> {
  const outcomes: Array<Record<string, unknown>> = [];
  let failures = 0;
  try {
    for (let index = 1; index <= (options.attempts ?? 1); index += 1) {
      const outcome = await run(options.scenarioPath as string, {
        runsRoot: options.runsRoot as string,
        runId,
        attemptId: `attempt-${String(index).padStart(2, '0')}`,
        frameIntervalMs: options.frameIntervalMs,
        quiet: true,
      });
      if (!outcome.verifyOk) failures += 1;
      writeOut(
        `${outcome.attempt.attemptDir} verify=${outcome.verifyOk ? 'ok' : 'FAILED'} ` +
          `turns=${outcome.turns} releases=${outcome.releases}`
      );
      for (const problem of outcome.verifyProblems) writeErr(`problem: ${problem}`);
      outcomes.push({
        attemptDir: outcome.attempt.attemptDir,
        verifyOk: outcome.verifyOk,
        verifyProblems: outcome.verifyProblems,
        turns: outcome.turns,
        releases: outcome.releases,
      });
    }
  } catch (error) {
    writeErr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.json) writeOut(JSON.stringify({ runId, attempts: outcomes }, null, 2));
  return failures === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('cli.ts');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
