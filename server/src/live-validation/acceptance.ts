import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidationScenarioResult } from './types.js';

/**
 * Strict acceptance for the disposable live-validation flow (four-angle plan
 * Steps 3B/3C). The verdict rules are deliberately conservative: only a fully
 * executed, fully passing, evidence-backed run with a coherent backend
 * identity and confirmed cleanup is `passed`. Everything else is `failed`
 * (something provably wrong) or `indeterminate` (required proof missing).
 */

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_RECORD_MAX_BYTES = 256 * 1024;

export type AcceptanceVerdict = 'passed' | 'failed' | 'skipped' | 'indeterminate';

export interface BackendIdentitySnapshot {
  source: 'health' | 'provided';
  buildId: string;
  identityStatus: string;
  buildMode: string;
  bootId: string;
  startedAt: string;
}

export interface AcceptanceCheckExit {
  name: string;
  exitCode: number;
}

export interface EvidenceInput {
  path: string;
  label: string;
}

export interface EvidenceReference extends EvidenceInput {
  sha256: string;
  bytes: number;
}

export interface AcceptanceInput {
  createdAt: string;
  identity: BackendIdentitySnapshot;
  expectedBuildMode?: string;
  entrypointMode: 'source' | 'compiled';
  scope: 'fixture' | 'real-runtime';
  required: string[];
  results: ValidationScenarioResult[];
  checks: AcceptanceCheckExit[];
  evidence: EvidenceInput[];
  cleanup: { mode: 'verified' | 'external' | 'uncertain'; detail?: string };
  remainingLimits: string[];
}

export interface ScenarioMatrixRow {
  scenarioId: string;
  runtime: string;
  expected: boolean;
  executed: boolean;
  skipped: boolean;
  passed: boolean;
  attempts: number;
  firstAttemptPassed: boolean;
}

export interface AcceptanceProofRecord {
  schemaVersion: number;
  createdAt: string;
  verdict: AcceptanceVerdict;
  exitCode: number;
  reasons: string[];
  identity: BackendIdentitySnapshot;
  expectedBuildMode?: string;
  entrypointMode: 'source' | 'compiled';
  scope: 'fixture' | 'real-runtime';
  matrix: ScenarioMatrixRow[];
  checks: AcceptanceCheckExit[];
  evidence: EvidenceReference[];
  cleanup: AcceptanceInput['cleanup'];
  remainingLimits: string[];
  truncation?: { applied: true; dropped: string[] };
}

export interface AcceptanceOutcome {
  verdict: AcceptanceVerdict;
  exitCode: number;
  reasons: string[];
}

export function evaluateAcceptance(input: AcceptanceInput): AcceptanceOutcome {
  const reasons: string[] = [];
  let failed = false;
  let indeterminate = false;

  if (input.identity.identityStatus !== 'known') {
    reasons.push(`backend build identity is ${input.identity.identityStatus}, not known — cannot tie evidence to a candidate`);
    indeterminate = true;
  }
  if (input.expectedBuildMode && input.identity.buildMode !== input.expectedBuildMode) {
    reasons.push(`wrong build: expected ${input.expectedBuildMode} mode, backend reports ${input.identity.buildMode} (buildId=${input.identity.buildId})`);
    failed = true;
  }
  for (const check of input.checks) {
    if (check.exitCode !== 0) {
      reasons.push(`required check '${check.name}' exited ${check.exitCode}`);
      failed = true;
    }
  }

  if (input.required.length > 0 && input.results.length === 0) {
    reasons.push('zero required scenario executions recorded');
    indeterminate = true;
  }
  for (const requiredId of input.required) {
    const matches = input.results.filter((result) => result.scenarioId === requiredId);
    if (matches.length === 0) {
      reasons.push(`missing required scenario '${requiredId}'`);
      indeterminate = true;
      continue;
    }
    for (const result of matches) {
      if (result.skipped) {
        reasons.push(`required scenario '${requiredId}' (${result.runtime}) skipped: ${result.reason ?? 'no reason recorded'}`);
        failed = true;
      } else if (!result.passed) {
        const failedAssertion = result.assertions.find((assertion) => !assertion.passed);
        reasons.push(`required scenario '${requiredId}' (${result.runtime}) failed${failedAssertion ? ` at '${failedAssertion.name}'` : ''}`);
        failed = true;
      }
    }
  }

  if (input.cleanup.mode === 'uncertain') {
    reasons.push('cleanup uncertainty recorded — evidence cannot be accepted as clean');
    indeterminate = true;
  }

  if (failed) return { verdict: 'failed', exitCode: 1, reasons };
  if (indeterminate) return { verdict: 'indeterminate', exitCode: 2, reasons };
  return { verdict: 'passed', exitCode: 0, reasons: [] };
}

function matrixFrom(input: AcceptanceInput): ScenarioMatrixRow[] {
  const rows: ScenarioMatrixRow[] = [];
  for (const result of input.results) {
    const attempts = result.attemptHistory?.length ?? 1;
    rows.push({
      scenarioId: result.scenarioId,
      runtime: result.runtime,
      expected: input.required.includes(result.scenarioId),
      executed: !result.skipped,
      skipped: result.skipped === true,
      passed: result.passed,
      attempts,
      firstAttemptPassed: attempts > 0 && (result.attemptHistory?.[0]?.passed ?? result.passed),
    });
  }
  for (const requiredId of input.required) {
    if (!rows.some((row) => row.scenarioId === requiredId)) {
      rows.push({
        scenarioId: requiredId, runtime: 'unknown', expected: true, executed: false,
        skipped: false, passed: false, attempts: 0, firstAttemptPassed: false,
      });
    }
  }
  return rows;
}

const MAX_REASONS = 64;
const MAX_LIMITS = 64;

export async function buildProofRecord(input: AcceptanceInput): Promise<AcceptanceProofRecord> {
  const outcome = evaluateAcceptance(input);
  const dropped: string[] = [];
  const evidence: EvidenceReference[] = [];
  for (const item of input.evidence) {
    try {
      const bytes = await readFile(item.path);
      evidence.push({ ...item, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    } catch {
      // Absent evidence is a missing required fact: recorded as a reason,
      // never silently omitted from the record.
      outcome.reasons.push(`evidence artifact '${item.label}' missing at ${item.path}`);
      outcome.verdict = 'indeterminate';
      outcome.exitCode = Math.max(outcome.exitCode, 2) === 1 ? 1 : 2;
    }
  }
  if (outcome.reasons.length > MAX_REASONS) {
    dropped.push(`reasons truncated from ${outcome.reasons.length}`);
    outcome.reasons = outcome.reasons.slice(0, MAX_REASONS);
  }
  let remainingLimits = input.remainingLimits;
  if (remainingLimits.length > MAX_LIMITS) {
    dropped.push(`remainingLimits truncated from ${remainingLimits.length}`);
    remainingLimits = remainingLimits.slice(0, MAX_LIMITS);
  }
  const record: AcceptanceProofRecord = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    createdAt: input.createdAt,
    verdict: outcome.verdict,
    exitCode: outcome.exitCode,
    reasons: outcome.reasons,
    identity: input.identity,
    ...(input.expectedBuildMode ? { expectedBuildMode: input.expectedBuildMode } : {}),
    entrypointMode: input.entrypointMode,
    scope: input.scope,
    matrix: matrixFrom(input),
    checks: input.checks,
    evidence,
    cleanup: input.cleanup,
    remainingLimits,
    ...(dropped.length > 0 ? { truncation: { applied: true as const, dropped } } : {}),
  };
  const serialised = JSON.stringify(record);
  if (serialised.length > ACCEPTANCE_RECORD_MAX_BYTES) {
    record.truncation = { applied: true, dropped: [...dropped, `record exceeded ${ACCEPTANCE_RECORD_MAX_BYTES} bytes before bounding was applied`] };
  }
  return record;
}

function recordFileName(createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, '-');
  return `acceptance-${stamp}-${randomBytes(3).toString('hex')}.json`;
}

export async function writeProofRecord(
  input: AcceptanceInput,
  directory: string,
): Promise<{ path: string; record: AcceptanceProofRecord }> {
  const record = await buildProofRecord(input);
  const path = join(directory, recordFileName(input.createdAt));
  // A subsequent run must never overwrite a prior run's evidence: the random
  // suffix makes collision astronomically unlikely and existence is checked.
  const { access } = await import('node:fs/promises');
  try {
    await access(path);
    throw new Error(`acceptance record already exists at ${path}; refusing to overwrite evidence`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { path, record };
}

export async function verifyRecordIntegrity(path: string): Promise<{ valid: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  let record: AcceptanceProofRecord;
  try {
    record = JSON.parse(await readFile(path, 'utf8')) as AcceptanceProofRecord;
  } catch (error) {
    return { valid: false, reasons: [`record unreadable: ${(error as Error).message}`] };
  }
  if (record.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION) {
    reasons.push(`unknown schema version ${String(record.schemaVersion)}`);
  }
  const size = (await stat(path)).size;
  if (size > ACCEPTANCE_RECORD_MAX_BYTES) {
    reasons.push(`record size ${size} exceeds ${ACCEPTANCE_RECORD_MAX_BYTES} bytes`);
  }
  for (const reference of record.evidence ?? []) {
    try {
      const bytes = await readFile(reference.path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== reference.sha256 || bytes.length !== reference.bytes) {
        reasons.push(`evidence '${reference.label}' sha256/size mismatch (recorded ${reference.sha256.slice(0, 12)}…/${reference.bytes}, found ${digest.slice(0, 12)}…/${bytes.length})`);
      }
    } catch {
      reasons.push(`evidence '${reference.label}' absent at ${reference.path}`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}
