import { describe, expect, it, vi } from 'vitest';
import dotenv from 'dotenv';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('unit test dotenv isolation', () => {
  it('disables automatic file loading but preserves explicit parse fixtures', () => {
    const home = mkdtempSync(join(tmpdir(), 'test-dotenv-'));
    const path = join(home, '.env');
    vi.stubEnv('FOUR_ANGLE_ENV_SENTINEL', '');
    try {
      writeFileSync(path, 'FOUR_ANGLE_ENV_SENTINEL=synthetic-live-secret\n');
      dotenv.config({ path, override: true });
      expect(process.env.FOUR_ANGLE_ENV_SENTINEL).toBe('');
      expect(dotenv.parse('FIXTURE=value')).toEqual({ FIXTURE: 'value' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
