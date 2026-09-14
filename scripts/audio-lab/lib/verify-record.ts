/**
 * Offline record verification (`verify-record`).
 *
 * Re-checks a finalised attempt WITHOUT the browser, the audio daemon or the
 * network. It is deliberately not a grep for a self-reported "passed": it
 * recomputes every stored hash, re-derives each scenario's status from its own
 * assertions, and checks the internal consistency of the manifest. A record
 * whose files were edited, truncated or swapped after finalisation must fail.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './layout.js';
import { readManifest, manifestSha256, type RunManifest } from './manifest.js';
import { MANIFEST_SCHEMA_VERSION, ORACLE_TOLERANCE_VERSION } from './version.js';
import { verdictFrom } from './oracle.js';

export interface VerifyOutcome {
  ok: boolean;
  lines: string[];
  problems: string[];
}

function statusFromAssertions(assertions: Array<{ ok: boolean; indeterminate?: boolean }>): string {
  const verdict = verdictFrom(
    assertions.map((assertion, index) => ({
      id: `stored-${index}`,
      ok: assertion.ok,
      indeterminate: assertion.indeterminate,
      detail: '',
    }))
  );
  return verdict.status;
}

/** Validate a manifest's internal consistency and its artifacts. */
export function verifyAttempt(attemptDir: string, options: { requireFinalised?: boolean } = {}): VerifyOutcome {
  const lines: string[] = [];
  const problems: string[] = [];
  const requireFinalised = options.requireFinalised ?? true;

  const manifestPath = path.join(attemptDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, lines: [`missing manifest: ${manifestPath}`], problems: ['missing manifest'] };
  }

  if (requireFinalised) {
    if (!existsSync(path.join(attemptDir, 'FINALISED'))) {
      problems.push('attempt is not finalised (no FINALISED marker)');
    }
    const recorded = existsSync(path.join(attemptDir, 'MANIFEST.sha256'))
      ? manifestSha256(attemptDir)
      : null;
    const actual = sha256File(manifestPath);
    if (recorded === null) problems.push('MANIFEST.sha256 is missing');
    else if (recorded !== actual) {
      problems.push(`manifest hash mismatch: recorded ${recorded}, actual ${actual}`);
    } else {
      lines.push(`manifest sha256 OK (${actual.slice(0, 16)}...)`);
    }
  }

  let manifest: RunManifest;
  try {
    manifest = readManifest(attemptDir);
  } catch (error) {
    return {
      ok: false,
      lines,
      problems: [...problems, `manifest is not valid JSON: ${String(error)}`],
    };
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    problems.push(
      `manifest schema version ${manifest.schemaVersion} != expected ${MANIFEST_SCHEMA_VERSION}`
    );
  }
  if (manifest.oracleToleranceVersion !== ORACLE_TOLERANCE_VERSION) {
    problems.push(
      `oracle tolerance version ${manifest.oracleToleranceVersion} != expected ${ORACLE_TOLERANCE_VERSION}: the recorded verdicts were produced under different tolerance rules`
    );
  }
  if (!manifest.candidate?.commit || manifest.candidate.commit === 'unknown') {
    problems.push('candidate commit is unknown; the record does not identify the code under test');
  }
  if (!manifest.environment?.chromeArgs?.length) {
    problems.push('browser argv was not recorded; the browser configuration cannot be stated');
  }
  if (manifest.cleanup?.ok !== true) {
    problems.push('cleanup was not verified clean in this record');
  }

  // Required scenarios must all be present, and a green summary must be
  // consistent with the per-scenario statuses.
  const required = manifest.scenarios.filter((entry) => entry.required);
  const notRun = required.filter((entry) => entry.status === 'not_run');
  if (notRun.length > 0) {
    problems.push(`required scenarios not executed: ${notRun.map((entry) => entry.id).join(', ')}`);
  }
  for (const scenario of manifest.scenarios) {
    const derived = statusFromAssertions(scenario.assertions);
    if (derived !== scenario.status) {
      problems.push(
        `scenario ${scenario.id}: recorded status "${scenario.status}" but its own assertions derive "${derived}"`
      );
    }
    if (scenario.controlStatus !== 'passed') {
      problems.push(
        `scenario ${scenario.id}: negative control status "${scenario.controlStatus}" — the measurement chain was not proven silent`
      );
    }
    if (scenario.status === 'passed' && scenario.reasons.length > 0) {
      problems.push(`scenario ${scenario.id}: passed but carries failure reasons`);
    }
    if (scenario.status === 'passed' && scenario.digest === null) {
      problems.push(`scenario ${scenario.id}: passed with no measurement`);
    }
    if (scenario.digest && scenario.digest.recordingFrames <= 0) {
      problems.push(`scenario ${scenario.id}: passed with zero captured frames`);
    }
    if (scenario.digest && scenario.digest.invalid.length > 0) {
      problems.push(
        `scenario ${scenario.id}: measurement flagged invalid (${scenario.digest.invalid.join('; ')})`
      );
    }
    for (const artifact of scenario.artifacts) {
      const full = path.join(attemptDir, artifact.relativePath);
      if (!existsSync(full)) {
        problems.push(`scenario ${scenario.id}: artifact missing: ${artifact.relativePath}`);
        continue;
      }
      const size = statSync(full).size;
      if (size !== artifact.bytes) {
        problems.push(
          `scenario ${scenario.id}: artifact ${artifact.relativePath} size ${size} != recorded ${artifact.bytes}`
        );
      }
      if (artifact.sha256 && sha256File(full) !== artifact.sha256) {
        problems.push(`scenario ${scenario.id}: artifact ${artifact.relativePath} hash mismatch`);
      }
    }
    if (scenario.artifacts.length === 0) {
      problems.push(`scenario ${scenario.id}: no artifacts recorded`);
    }
  }

  const derivedSummary = {
    passed: required.filter((entry) => entry.status === 'passed').length,
    failed: required.filter((entry) => entry.status === 'failed').length,
    indeterminate: required.filter((entry) => entry.status === 'indeterminate').length,
    notRun: notRun.length,
  };
  if (manifest.summary.passed !== derivedSummary.passed) {
    problems.push(
      `summary.passed ${manifest.summary.passed} != derived ${derivedSummary.passed}`
    );
  }
  if (manifest.summary.failed !== derivedSummary.failed) {
    problems.push(`summary.failed ${manifest.summary.failed} != derived ${derivedSummary.failed}`);
  }
  const expectedExit =
    derivedSummary.failed > 0 ? 1 : derivedSummary.indeterminate > 0 || derivedSummary.notRun > 0 ? 2 : 0;
  if (manifest.summary.exitCode !== expectedExit) {
    problems.push(
      `summary.exitCode ${manifest.summary.exitCode} != expected ${expectedExit} for the recorded statuses`
    );
  }

  lines.push(
    `run ${manifest.runId} attempt ${manifest.attempt}: ${manifest.summary.passed}/${manifest.summary.required} required scenarios passed`
  );
  lines.push(`candidate ${manifest.candidate.commit.slice(0, 12)}${manifest.candidate.dirty ? ' (dirty)' : ''}`);
  lines.push(`scenarios recorded: ${manifest.scenarios.length}, artifacts checked: ${manifest.scenarios.reduce((sum, entry) => sum + entry.artifacts.length, 0)}`);
  for (const scenario of manifest.scenarios) {
    lines.push(
      `  ${scenario.status.padEnd(14)} ${scenario.id.padEnd(24)} control=${scenario.controlStatus} (${scenario.assertions.filter((a) => a.ok).length}/${scenario.assertions.length} assertions ok)`
    );
  }
  return { ok: problems.length === 0, lines, problems };
}

/** CLI entrypoint wrapper: also prints the problems. */
export async function verifyRecord(attemptDir: string): Promise<VerifyOutcome> {
  const outcome = verifyAttempt(attemptDir);
  const lines = [...outcome.lines];
  if (outcome.problems.length > 0) {
    lines.push('', 'PROBLEMS:');
    for (const problem of outcome.problems) lines.push(`  - ${problem}`);
  } else {
    lines.push('', 'no problems found');
  }
  return { ...outcome, lines };
}

export { readFileSync };
