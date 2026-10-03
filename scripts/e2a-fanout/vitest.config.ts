import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Lane E2a-4 harness tests. Run from the repository root:
//   npx vitest run --config scripts/e2a-fanout/vitest.config.ts
// The suite is pure (no servers, no sockets, no model calls).
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Keep the default single-thread pool: the tests are pure and fast.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
