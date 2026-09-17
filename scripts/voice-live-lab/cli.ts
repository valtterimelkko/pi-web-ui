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

export type CliCommand = 'verify' | 'handshake' | 'baseline-dryrun' | 'help';

export interface CliOptions {
  command: CliCommand;
  attemptDir?: string;
  outputPath?: string;
  scenarioPath?: string;
  runsRoot?: string;
  attempts?: number;
  frameIntervalMs?: number;
  json?: boolean;
  requireFinalised?: boolean;
}

export const DEFAULT_RUNS_ROOT = '/root/agent-benchmarks/benchmarks/04-voice-live-lab/runs';
export const DEFAULT_SCENARIO_PATH =
  '/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/t1-s1-orchestration-voice.json';

export const USAGE = [
  'Voice Live Lab (Phase L0/L1/L2)',
  '',
  'Usage:',
  '  voice-live-lab verify <attemptDir> [--json] [--allow-unfinalised]',
  '  voice-live-lab handshake [--output <path>] [--json]',
  '  voice-live-lab baseline-dryrun [--scenario <path>] [--runs-root <dir>] [--attempts N] [--frame-interval-ms N] [--json]',
  '  voice-live-lab help',
  '',
  'Commands:',
  '  verify <attemptDir>   Re-check an attempt record offline; exit 1 on damage.',
  '  handshake             Probe Gemini Live models & judge endpoints; writes capabilities.json.',
  '  baseline-dryrun       Hermetic baseline-cascade attempt(s): scripted STT/TTS, real talker gate,',
  '                        immutable record + offline verify. No provider is called.',
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
  if (command === 'baseline-dryrun') {
    const opt = (name: string): string | undefined => {
      const idx = rest.indexOf(name);
      return idx !== -1 && rest[idx + 1] ? rest[idx + 1] : undefined;
    };
    const attemptsRaw = opt('--attempts');
    const frameRaw = opt('--frame-interval-ms');
    return {
      command: 'baseline-dryrun',
      scenarioPath: opt('--scenario') ?? DEFAULT_SCENARIO_PATH,
      runsRoot: opt('--runs-root') ?? DEFAULT_RUNS_ROOT,
      attempts: attemptsRaw ? Math.max(1, Number.parseInt(attemptsRaw, 10)) : 1,
      frameIntervalMs: frameRaw ? Math.max(1, Number.parseInt(frameRaw, 10)) : undefined,
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
}

export async function main(argv: string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.writeOut ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const verify = deps.verify ?? runVerify;
  const handshake = deps.handshake ?? runHandshake;
  const dryRun = deps.dryRun ?? runDryAttempt;

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
    const runId = `dryrun-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    const outcomes: Array<Record<string, unknown>> = [];
    let failures = 0;
    try {
      for (let index = 1; index <= (options.attempts ?? 1); index += 1) {
        const outcome = await dryRun(options.scenarioPath as string, {
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

  return 0;
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
