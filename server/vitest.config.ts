import { defineConfig } from 'vitest/config';

/**
 * By default, suppress application log output during tests so that a failing
 * test's output shows the assertion diff — not hundreds of `[Component] …` log
 * lines from the server runtime. Two layers cooperate, both re-enabled by
 * `VITEST_LOG=1`:
 *   1. `onConsoleLog` drops residual `console.*` calls (e.g. crash-logger).
 *   2. The central logger's default sink self-silences when `process.env.VITEST`
 *      is set (see server/src/logging/logger.ts) — it writes to process.stdout/
 *      stderr directly, which onConsoleLog does not intercept.
 *
 * Genuine test-framework output (assertion diffs, thrown errors, the reporter
 * summary) is never suppressed. The structured log tap (setLogTap) and loggers
 * built with an explicit sink still emit, so tests can assert on log output.
 */
const showAppConsoleLogs = process.env.VITEST_LOG === '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    onConsoleLog: showAppConsoleLogs ? undefined : () => false,
    // Also emit a machine-parseable JSON report (per-test pass/fail + messages)
    // for agents/tools. Artifact is git-ignored. See docs/TROUBLESHOOTING.md.
    reporter: ['default', 'json'],
    outputFile: 'test-results.json',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Measure production source explicitly (truthful coverage of src/**, not
      // just whatever the test runner happens to instrument).
      include: ['src/**/*.ts'],
      exclude: ['node_modules/', 'tests/', 'dist/', 'src/**/*.d.ts'],
      // Truthful ratchet (Q4): the explicit `include` now measures ALL of src/**,
      // so the previous 80/80/70/80 thresholds (which silently ignored
      // unmeasured bootstrap/wiring files) were inflated. The measured baseline
      // with full src/** instrumentation is lines 75.08 / branches 77.37 /
      // functions 80.09 / statements 75.08. Thresholds are set 1 point below to
      // absorb run-to-run variance while still failing on a real regression.
      // Raising these requires adding tests (not weakening the ratchet).
      thresholds: {
        lines: 74,
        functions: 79,
        branches: 76,
        statements: 74,
      },
    },
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
