/**
 * Regression runner skeleton (Voice Mode execution plan, Phase 6).
 *
 * The later Phase 6 veto suites (proposal SHA binding, idempotency, disconnect
 * safety, lane isolation, delivery receipts) plug in here. The runner enforces
 * the plan's anti-early-claim guard mechanically: **a suite with zero executed
 * checks fails**, and a single failing veto check fails the whole suite. There
 * are no thresholds, no averaging and no skips.
 *
 * The runner is intentionally dumb — each check throws on failure and returns
 * nothing on success, so a check cannot "pass" by returning a value.
 */

export interface RegressionCheck {
  /** Stable identity for the failure report, e.g. `veto-doubt-not-sure`. */
  id: string;
  /** One line on what the check asserts. */
  description?: string;
  /** Throws on failure. */
  run(): void;
}

export interface RegressionSuite {
  id: string;
  checks: RegressionCheck[];
}

export interface RegressionFailedCheck {
  checkId: string;
  error: string;
}

export interface RegressionReport {
  suiteId: string;
  /** Number of checks actually executed (skips are not a thing here). */
  executed: number;
  passed: number;
  failed: RegressionFailedCheck[];
  verdict: 'pass' | 'fail';
  /** Non-null whenever the verdict is `fail`. */
  failureReason: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Execute every check in a suite and return a veto report. A suite with no
 * checks is a failure, not a vacuous pass.
 */
export function runRegressionSuite(suite: RegressionSuite): RegressionReport {
  const failed: RegressionFailedCheck[] = [];
  let executed = 0;

  for (const check of suite.checks) {
    executed += 1;
    try {
      check.run();
    } catch (error) {
      failed.push({ checkId: check.id, error: errorMessage(error) });
    }
  }

  const noChecks = executed === 0;
  const verdict: RegressionReport['verdict'] = !noChecks && failed.length === 0 ? 'pass' : 'fail';
  const failureReason = noChecks
    ? 'suite executed 0 checks; a regression suite with no executed checks fails (anti-early-claim guard)'
    : failed.length > 0
      ? `${failed.length} veto check(s) failed: ${failed.map((entry) => entry.checkId).join(', ')}`
      : null;

  return {
    suiteId: suite.id,
    executed,
    passed: executed - failed.length,
    failed,
    verdict,
    failureReason,
  };
}

/** Convenience shape for a standalone list of checks. */
export function runRegressionChecks(suiteId: string, checks: RegressionCheck[]): RegressionReport {
  return runRegressionSuite({ id: suiteId, checks });
}

/** Throws when a report is not a clean pass; used to fail a test loudly. */
export function assertRegressionPass(report: RegressionReport): void {
  if (report.verdict !== 'pass') {
    throw new Error(
      `regression suite ${report.suiteId} failed (executed ${report.executed}, passed ${report.passed}): ${report.failureReason}`
    );
  }
}