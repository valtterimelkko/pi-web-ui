import { defineConfig } from 'vitest/config';

/** Suppress app `console.*` during tests by default; `VITEST_LOG=1` restores it. */
const showAppConsoleLogs = process.env.VITEST_LOG === '1';

export default defineConfig({
  envDir: false,
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.{test,spec}.ts'],
    reporter: ['default', 'json'],
    outputFile: 'test-results.json',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', 'src/**/*.d.ts'],
      // Full-source baseline: 93.17 lines/statements, 82.71 branches,
      // 94.11 functions. Ratchet is exactly one percentage point below.
      thresholds: { lines: 92.17, statements: 92.17, branches: 81.71, functions: 93.11 },
    },
    onConsoleLog: showAppConsoleLogs ? undefined : () => false,
  },
});
