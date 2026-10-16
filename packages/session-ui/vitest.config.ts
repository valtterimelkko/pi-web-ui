import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const showAppConsoleLogs = process.env.VITEST_LOG === '1';

export default defineConfig({
  envDir: false,
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    reporter: ['default', 'json'],
    outputFile: 'test-results.json',
    onConsoleLog: showAppConsoleLogs ? undefined : () => false,
  },
});
