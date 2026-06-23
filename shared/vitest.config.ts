import { defineConfig } from 'vitest/config';

/** Suppress app `console.*` during tests by default; `VITEST_LOG=1` restores it. */
const showAppConsoleLogs = process.env.VITEST_LOG === '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    onConsoleLog: showAppConsoleLogs ? undefined : () => false,
  },
});
