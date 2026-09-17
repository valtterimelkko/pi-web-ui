/**
 * L0 CLI tests. The CLI is the human/agent entry point to the verifier, so the
 * tests check argument handling and — more importantly — that a damaged record
 * produces a non-zero exit and an explanatory problem rather than a crash or a
 * cheerful "OK".
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, type LabEvent } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  RECORD_SCHEMA_VERSION,
  LAB_VERSION,
  createAttempt,
  eventLogPath,
  finaliseAttempt,
} from '../../../scripts/voice-live-lab/lib/record.js';
import { USAGE, main, parseArgs, runVerify, type CliDependencies } from '../../../scripts/voice-live-lab/cli.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-cli-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function events(withUsage: boolean): LabEvent[] {
  const list: LabEvent[] = [
    { seq: 1, tMs: 0, source: 'input', kind: EVENT.INPUT_FRAME, id: 'f1', payload: { index: 0, bytes: 640 } },
  ];
  if (withUsage) {
    list.push({ seq: 2, tMs: 50, source: 'provider', kind: EVENT.PROVIDER_USAGE, id: 'u1', payload: { totalTokenCount: 3 } });
  }
  return list;
}

function buildAttempt(condition: string, withUsage: boolean): string {
  const attemptDir = createAttempt(root, 'run-l0', condition, 'attempt-01').attemptDir;
  writeFileSync(
    eventLogPath(attemptDir),
    `${events(withUsage).map((event) => JSON.stringify(event)).join('\n')}\n`
  );
  finaliseAttempt(attemptDir, {
    schemaVersion: RECORD_SCHEMA_VERSION,
    labVersion: LAB_VERSION,
    runId: 'run-l0',
    condition,
    attemptId: 'attempt-01',
    createdAt: new Date().toISOString(),
    input: { declaredFrames: 1, declaredBytes: 640, frameBytes: 640 },
    requiredEventKinds: [EVENT.INPUT_FRAME, EVENT.PROVIDER_USAGE],
  });
  return attemptDir;
}

function collector(): { deps: CliDependencies; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { writeOut: (line) => out.push(line), writeErr: (line) => err.push(line) } };
}

describe('parseArgs', () => {
  it('parses verify with an attempt directory', () => {
    expect(parseArgs(['verify', '/tmp/x'])).toEqual({
      command: 'verify',
      attemptDir: '/tmp/x',
      json: false,
      requireFinalised: true,
    });
  });

  it('honours --json and --allow-unfinalised', () => {
    const parsed = parseArgs(['verify', '/tmp/x', '--json', '--allow-unfinalised']);
    expect(parsed.json).toBe(true);
    expect(parsed.requireFinalised).toBe(false);
  });

  it('defaults to help and rejects unknown or incomplete commands', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(() => parseArgs(['verify'])).toThrow(/Usage/);
    expect(() => parseArgs(['dance'])).toThrow(/Unknown command/);
  });
});

describe('verify command', () => {
  it('exits 0 and reports OK for a clean control', async () => {
    const attemptDir = buildAttempt('clean', true);
    const { deps, out, err } = collector();
    const code = await main(['verify', attemptDir], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/^OK:/);
    expect(err).toEqual([]);
  });

  it('exits 1 and explains the problem for a damaged record', async () => {
    const attemptDir = buildAttempt('damaged', false);
    const { deps, out, err } = collector();
    const code = await main(['verify', attemptDir], deps);
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/^FAILED:/);
    expect(err.join('\n')).toMatch(/required event kind missing: provider_usage/);
  });

  it('emits machine-parseable JSON on request', async () => {
    const attemptDir = buildAttempt('clean', true);
    const { deps, out } = collector();
    const code = await main(['verify', attemptDir, '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; problems: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.problems).toEqual([]);
  });

  it('reports an unfinalised attempt and can be told to allow it', () => {
    const attemptDir = createAttempt(root, 'run-l0', 'open', 'attempt-01').attemptDir;
    writeFileSync(
      eventLogPath(attemptDir),
      `${events(true).map((event) => JSON.stringify(event)).join('\n')}\n`
    );
    writeFileSync(
      path.join(attemptDir, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: RECORD_SCHEMA_VERSION,
        labVersion: LAB_VERSION,
        runId: 'run-l0',
        condition: 'open',
        attemptId: 'attempt-01',
        createdAt: new Date().toISOString(),
        input: { declaredFrames: 1, declaredBytes: 640, frameBytes: 640 },
        requiredEventKinds: [EVENT.INPUT_FRAME, EVENT.PROVIDER_USAGE],
      })}\n`
    );
    expect(runVerify(attemptDir).code).toBe(1);
    const relaxed = runVerify(attemptDir, { requireFinalised: false });
    expect(relaxed.code).toBe(0);
  });
});

describe('main dispatch', () => {
  it('prints usage and exits 0 for help', async () => {
    const { deps, out } = collector();
    expect(await main(['help'], deps)).toBe(0);
    expect(out.join('\n')).toBe(USAGE);
  });

  it('exits 2 with usage on an unknown command', async () => {
    const { deps, err } = collector();
    expect(await main(['bogus'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/Unknown command/);
    expect(err.join('\n')).toMatch(/Usage:/);
  });

  it('returns the verifier result code', async () => {
    const { deps } = collector();
    const code = await main(['verify', '/absent'], {
      ...deps,
      verify: () => ({ code: 7, stdout: [], stderr: [] }),
    });
    expect(code).toBe(7);
  });
});
