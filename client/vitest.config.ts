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
      exclude: ['node_modules/', 'tests/', 'dist/', 'src/**/*.d.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
