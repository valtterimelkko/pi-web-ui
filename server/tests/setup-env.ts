import { vi } from 'vitest';

// Unit/integration subjects use explicit env fixtures, never a developer's
// on-disk .env. Keep parse() real for validation-env fixture tests. This does
// not alter the application loader or source/compiled live-validation mode.
vi.mock('dotenv', async (importOriginal) => {
  const original = await importOriginal<typeof import('dotenv')>();
  const config = () => ({ parsed: {} });
  return { ...original, config, default: { ...original.default, config } };
});
