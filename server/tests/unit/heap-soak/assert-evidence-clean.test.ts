import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Parent FINAL correction 03 (Luna r2): the evidence-cleanliness assertion must
 * FAIL CLOSED — a models.json it cannot parse is an offender, never "clean".
 */
const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/e2a-soak/assert-evidence-clean.ts');
const TSX = path.join(REPO, 'node_modules/.bin/tsx');

function run(root: string) {
  const r = spawnSync(TSX, [SCRIPT, root], { encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout || '{}') as { offenders?: { kind: string }[] } };
}

describe('assert-evidence-clean (fail closed)', () => {
  it('treats an unparsable models.json as an offender', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'evidence-clean-'));
    try {
      writeFileSync(path.join(dir, 'models.json'), '{ "providers": { "x": { "apiKey": "FAKE" } ');
      const r = run(dir);
      expect(r.code).toBe(1);
      expect((r.out.offenders ?? []).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still passes a clean, parsable, key-free models.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'evidence-clean-'));
    try {
      writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { zai: { baseUrl: 'x' } } }));
      expect(run(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
