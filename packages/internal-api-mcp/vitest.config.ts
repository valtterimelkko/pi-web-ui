import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    reporter: ['default', 'json'],
    outputFile: 'test-results.json',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      // The entrypoint is exercised as a compiled child process by the stdio
      // protocol suite; instrumenting it in the parent would not measure that
      // subprocess and would distort the workspace ratchet.
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
