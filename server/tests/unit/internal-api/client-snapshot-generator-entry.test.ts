import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F-SNAP: `npx tsx scripts/generate-client-snapshot.<ext>` (the invocation the
 * generator's own header, `docs/INTERNAL-API-ORCHESTRATION.md` and the
 * runtime-keeper's mirror procedure `RUNTIMES.md` §3 all document) must not die
 * on a module-format error.
 *
 * Two defects made it crash, both invisible to `client-snapshot-drift.test.ts`
 * because that test imports `generateSnapshot()` through the vitest loader,
 * which is more permissive than the standalone entry path:
 *
 *  1. Module format (FIXED here). The repo root `package.json` declares no
 *     `"type"`, so a `.ts` entry loads as CommonJS under tsx; the ESM-only
 *     `@earendil-works/pi-coding-agent` root export (`.` is `import`-only, with
 *     no `require` condition) then resolves through `require` and dies with
 *     `ERR_PACKAGE_PATH_NOT_EXPORTED`. Moving the entry to `.mts` makes tsx
 *     load the whole graph as ESM. Same defect class and same guard shape as
 *     `command-code-weekly-refresh-entry-load.test.ts`.
 *
 *  2. A missing named export (OPEN, not fixed here). The generator also imports
 *     `retentionSchema`, which `session-validation.ts` keeps module-private, so
 *     once the format crash is out of the way ESM instantiation fails with
 *     `does not provide an export named 'retentionSchema'`. Fixing it makes the
 *     generator emit the real retention schema, which changes the committed
 *     snapshot's body — a decision reserved to the owner under the contract
 *     stability window. See the F-SNAP hand-back.
 *
 * This test pins defect 1 and nothing else: it asserts the entry no longer takes
 * the module-format path. It deliberately does NOT assert the exit status, so it
 * stays green both today (defect 2 still exits 1) and after the owner-approved
 * export fix (exit 0) — and a format regression always fails it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ENTRY = 'scripts/generate-client-snapshot.mts';

describe('generate-client-snapshot entry module format', () => {
  it('loads its import graph as ESM under tsx (no ERR_PACKAGE_PATH_NOT_EXPORTED)', () => {
    // --check is the read-only mode: it never writes the committed snapshot.
    const result = spawnSync('npx', ['tsx', ENTRY, '--check'], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 180_000,
    });
    const stderr = result.stderr ?? '';

    // The defect under test: the ESM-only Pi SDK root export reached through
    // `require`, because a `.ts` entry under a "type"-less package.json is CJS.
    expect(stderr).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(stderr).not.toMatch(/require\(\) of ES Module/);
    expect(stderr).not.toMatch(/No "exports" main defined/);
  }, 240_000);

  it('is named .mts by every place that documents or imports the entry', () => {
    // A rename back to .ts reintroduces defect 1 silently, because the .ts form
    // only fails in a subprocess — the vitest loader never sees it.
    const places = [
      'docs/INTERNAL-API-ORCHESTRATION.md',
      'server/tests/unit/internal-api/client-snapshot-drift.test.ts',
      'server/tests/unit/internal-api/contract-stability-window.test.ts',
      'server/tests/unit/internal-api/contract-stability-window-guard.ts',
    ];
    for (const place of places) {
      const text = readFileSync(path.join(REPO_ROOT, place), 'utf8');
      expect(text, `${place} still names the CJS-loaded .ts entry`).not.toMatch(
        /generate-client-snapshot\.ts\b/,
      );
      expect(text, `${place} does not name the .mts entry`).toContain('generate-client-snapshot.mts');
    }

    // The generator's own header documents the runnable command.
    const entryText = readFileSync(path.join(REPO_ROOT, ENTRY), 'utf8');
    expect(entryText).toContain('npx tsx scripts/generate-client-snapshot.mts');
    expect(entryText).not.toMatch(/npx tsx scripts\/generate-client-snapshot\.ts\b/);
  });
});
