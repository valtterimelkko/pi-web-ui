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
    },
    onConsoleLog: showAppConsoleLogs ? undefined : () => false,
  },
});
