#!/usr/bin/env node
/**
 * Voice Live Lab CLI (L0).
 *
 *   npx tsx scripts/voice-live-lab/cli.ts verify <attemptDir> [--json]
 *
 * `verify` is the offline trust boundary: it re-derives the mechanical facts
 * from an attempt record without a browser, a provider or the network, and
 * exits non-zero if the record is damaged, unfinalised or internally
 * inconsistent. Later phases add `handshake`, `run`, `freeze` and `report`; the
 * argument surface is deliberately small until they exist.
 */

import { verifyAttempt } from './lib/record.js';

export type CliCommand = 'verify' | 'help';

export interface CliOptions {
  command: CliCommand;
  attemptDir?: string;
  json?: boolean;
  requireFinalised?: boolean;
}

export const USAGE = [
  'Voice Live Lab (Phase L0)',
  '',
  'Usage:',
  '  voice-live-lab verify <attemptDir> [--json] [--allow-unfinalised]',
  '  voice-live-lab help',
  '',
  'Commands:',
  '  verify <attemptDir>   Re-check an attempt record offline; exit 1 on damage.',
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
}

export async function main(argv: string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.writeOut ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const verify = deps.verify ?? runVerify;

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

  const result = verify(options.attemptDir as string, {
    json: options.json,
    requireFinalised: options.requireFinalised,
  });
  for (const line of result.stdout) writeOut(line);
  for (const line of result.stderr) writeErr(line);
  return result.code;
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
