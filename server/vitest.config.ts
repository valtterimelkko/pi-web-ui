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
      exclude: ['node_modules/', 'tests/', 'dist/', 'src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
