import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Suppress application `console.*` output during tests by default so a failing
 * test shows the assertion, not log noise. Set `VITEST_LOG=1` to restore full
 * app logging. Only `console.*` is affected — assertion diffs, thrown errors,
 * and the reporter summary are never suppressed.
 */
const showAppConsoleLogs = process.env.VITEST_LOG === '1';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['development', 'import', 'browser', 'default'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    onConsoleLog: showAppConsoleLogs ? undefined : () => false,
    // Machine-parseable JSON report (per-test pass/fail + messages), git-ignored.
    reporter: ['default', 'json'],
    outputFile: 'test-results.json',
    env: {
      NODE_ENV: 'test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Measure production source explicitly (truthful coverage of src/**).
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['node_modules/', 'tests/', 'dist/', 'src/**/*.d.ts'],
      // Truthful ratchet (Q4): the explicit `include` now measures ALL of src/**,
      // so the previous 70/70/60/70 thresholds (which silently ignored
      // unmeasured components) were inflated. The measured baseline with full
      // src/** instrumentation is lines 57.04 / branches 75.43 / functions
      // 54.07 / statements 57.04. Thresholds are set 1 point below to absorb
      // run-to-run variance while still failing on a real regression. Raising
      // these requires adding tests (not weakening the ratchet).
      thresholds: {
        lines: 56,
        functions: 53,
        branches: 74,
        statements: 56,
      },
    },
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
