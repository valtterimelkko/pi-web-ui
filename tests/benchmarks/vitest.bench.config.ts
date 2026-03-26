import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Enable benchmark mode
    benchmark: {
      // Output format
      reporters: ['default', 'json'],
      // Output file for JSON results
      outputFile: 'tests/benchmarks/results/benchmark-results.json',
    },
    // Include benchmark files
    include: ['tests/benchmarks/**/*.ts'],
    // Exclude regular test files
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Test environment
    environment: 'node',
    // Global test APIs
    globals: true,
  },
})
