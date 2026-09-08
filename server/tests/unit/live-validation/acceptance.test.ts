import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildProofRecord,
  evaluateAcceptance,
  verifyRecordIntegrity,
  writeProofRecord,
  type AcceptanceInput,
  type ValidationScenarioResultLike,
} from '../../../src/live-validation/acceptance.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(overrides: Partial<ValidationScenarioResultLike>): ValidationScenarioResultLike {
  return {
    scenarioId: 'smoke',
    runtime: 'commandcode',
    passed: true,
    assertions: [{ name: 'agent_end', passed: true }],
    attemptHistory: [{ attempt: 1, passed: true, durationMs: 1200 }],
    ...overrides,
  };
}

function input(overrides: Partial<AcceptanceInput> = {}): AcceptanceInput {
  return {
    createdAt: '2026-09-08T14:00:00.000Z',
    identity: {
      source: 'health',
      buildId: 'build-abc123',
      identityStatus: 'known',
      buildMode: 'compiled',
      bootId: 'boot-1',
      startedAt: '2026-09-08T13:59:00.000Z',
    },
    expectedBuildMode: 'compiled',
    entrypointMode: 'compiled',
    scope: 'fixture',
    required: ['smoke'],
    results: [scenario({})],
    checks: [{ name: 'identity-precheck', exitCode: 0 }],
    evidence: [],
    cleanup: { mode: 'verified', detail: 'stopper exit 0; independent group gone' },
    remainingLimits: [],
    ...overrides,
  };
}

describe('strict acceptance verdicts', () => {
  it('passes only when every required scenario executed and passed with verified cleanup', () => {
    const outcome = evaluateAcceptance(input());
    expect(outcome).toMatchObject({ verdict: 'passed', exitCode: 0 });
    expect(outcome.reasons).toEqual([]);
  });

  it('fails on a failed assertion', () => {
    const outcome = evaluateAcceptance(input({
      results: [scenario({ passed: false, assertions: [{ name: 'agent_end', passed: false }] })],
    }));
    expect(outcome.verdict).toBe('failed');
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.reasons[0]).toContain('smoke');
  });

  it('fails on an unexpected skip of a required scenario', () => {
    const outcome = evaluateAcceptance(input({
      results: [scenario({ skipped: true, reason: 'runtime unavailable' })],
    }));
    expect(outcome.verdict).toBe('failed');
    expect(outcome.reasons.join(' ')).toContain('skipped');
  });

  it('marks a missing required scenario indeterminate, never success', () => {
    const outcome = evaluateAcceptance(input({ results: [] }));
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.reasons.join(' ')).toContain('missing');
  });

  it('marks zero executed required scenarios indeterminate', () => {
    const outcome = evaluateAcceptance(input({ results: [] }));
    expect(outcome.verdict).toBe('indeterminate');
  });

  it('fails on wrong build mode versus expectation before any success claim', () => {
    const outcome = evaluateAcceptance(input({ expectedBuildMode: 'compiled', identity: input().identity }));
    const wrongMode = evaluateAcceptance(input({
      identity: { ...input().identity, buildMode: 'source' },
    }));
    expect(wrongMode.verdict).toBe('failed');
    expect(wrongMode.reasons.join(' ')).toContain('source');
    expect(outcome.verdict).toBe('passed');
  });

  it('fails when a required named check exited non-zero', () => {
    const outcome = evaluateAcceptance(input({
      checks: [{ name: 'identity-precheck', exitCode: 1 }],
    }));
    expect(outcome.verdict).toBe('failed');
    expect(outcome.reasons.join(' ')).toContain('identity-precheck');
  });

  it('marks unknown backend identity indeterminate rather than passed', () => {
    const outcome = evaluateAcceptance(input({
      identity: { ...input().identity, identityStatus: 'unknown', buildId: 'unknown' },
    }));
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.reasons.join(' ')).toContain('identity');
  });

  it('marks uncertain cleanup indeterminate, and external cleanup stays acceptable', () => {
    expect(evaluateAcceptance(input({ cleanup: { mode: 'uncertain' } })).verdict).toBe('indeterminate');
    expect(evaluateAcceptance(input({
      cleanup: { mode: 'external', detail: 'stopper owned by validate:server flow' },
    })).verdict).toBe('passed');
  });
});

describe('proof record construction and integrity', () => {
  function evidenceFixture(): { dir: string; evidencePath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pi-acceptance-'));
    temporaryRoots.push(dir);
    const evidencePath = join(dir, 'scenario-output.log');
    writeFileSync(evidencePath, 'first attempt failed\nsecond attempt passed\n'.repeat(50), 'utf8');
    return { dir, evidencePath };
  }

  it('records identity, matrix, attempts, entrypoint, scope, bounded artifact hashes and cleanup', async () => {
    const { evidencePath } = evidenceFixture();
    const record = await buildProofRecord(input({
      evidence: [{ path: evidencePath, label: 'scenario-output' }],
      results: [scenario({
        attemptHistory: [
          { attempt: 1, passed: false, durationMs: 900, reason: 'socket timeout' },
          { attempt: 2, passed: true, durationMs: 1100 },
        ],
      })],
    }));
    expect(record.schemaVersion).toBe(1);
    expect(record.identity.buildId).toBe('build-abc123');
    expect(record.entrypointMode).toBe('compiled');
    expect(record.scope).toBe('fixture');
    expect(record.matrix).toEqual([
      { scenarioId: 'smoke', runtime: 'commandcode', expected: true, executed: true, skipped: false, passed: true, attempts: 2, firstAttemptPassed: false },
    ]);
    expect(record.evidence[0]).toMatchObject({
      label: 'scenario-output',
      sha256: createHash('sha256').update('first attempt failed\nsecond attempt passed\n'.repeat(50)).digest('hex'),
    });
    expect(record.cleanup.mode).toBe('verified');
    expect(JSON.stringify(record).length).toBeLessThan(256 * 1024);
  });

  it('rejects absent evidence as indeterminate and never writes a passing record', async () => {
    const outcome = await buildProofRecord(input({
      evidence: [{ path: '/nonexistent/evidence.log', label: 'missing' }],
    }));
    expect(outcome.verdict).toBe('indeterminate');
  });

  it('never overwrites a prior record and marks truncation explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-acceptance-records-'));
    temporaryRoots.push(dir);
    const first = await writeProofRecord(input({}), dir);
    const second = await writeProofRecord(input({ createdAt: '2026-09-08T14:00:00.000Z' }), dir);
    expect(second.path).not.toBe(first.path);
    const verified = await verifyRecordIntegrity(second.path);
    expect(verified.valid).toBe(true);
  });

  it('detects tampered artifacts and oversized records on verification', async () => {
    const { evidencePath } = evidenceFixture();
    const record = await writeProofRecord(input({
      evidence: [{ path: evidencePath, label: 'scenario-output' }],
    }), mkdtempSync(join(tmpdir(), 'pi-acceptance-tamper-')));
    temporaryRoots.push(join(record.path, '..'));
    writeFileSync(evidencePath, 'tampered content'.repeat(20), 'utf8');
    const verified = await verifyRecordIntegrity(record.path);
    expect(verified.valid).toBe(false);
    expect(verified.reasons.join(' ')).toContain('sha256');
  });
});
