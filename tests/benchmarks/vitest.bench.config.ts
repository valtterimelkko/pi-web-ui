import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Enable benchmark mode
    benchmark: {
      // Benchmark mode only supports its own default/verbose reporters; JSON
      // output is configured separately through outputJson.
      reporters: ['default'],
      outputJson: 'tests/benchmarks/results/benchmark-results.json',
      // Target only files that actually declare bench() suites.
      include: [
        'tests/benchmarks/mobile-performance.ts',
        'tests/benchmarks/memory-usage.ts',
      ],
    },
    // Exclude regular test files
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Test environment
    environment: 'node',
    // Global test APIs
    globals: true,
  },
})
