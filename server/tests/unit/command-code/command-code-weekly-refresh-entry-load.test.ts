import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * J1 correction 02: the weekly Command Code refresh entry must LOAD under
 * Pi SDK 1.0.0 exactly as `npm run commandcode:weekly-refresh` runs it —
 * tsx from the repo root, in the repo root's module context. The root
 * `package.json` declares no `"type"`, so the entry file's own module style
 * decides how the whole import graph is loaded; an ESM-only upstream export
 * (`@earendil-works/pi-coding-agent` 1.0.0 exposes `.` only under `import`)
 * fails an ERR_PACKAGE_PATH_NOT_EXPORTED require.
 *
 * The import must never EXECUTE the job: the entry ends in a main-module
 * guard (`invokedPath === path.resolve(fileURLToPath(import.meta.url))`),
 * and a `tsx -e` eval leaves `process.argv[1]` unset, so the guard is false
 * and only the module graph loads. No command is probed, nothing is written,
 * nothing is restarted by this test.
 *
 * GitHub-CI portable: the repo root is derived from this file's location, the
 * entry path is repo-relative, and `npx tsx` resolves the repo's own dev
 * dependency for an unprivileged user. No host paths.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// The entry must stay ESM (.mts): the repo root package.json declares no
// "type", so a .ts entry loads as CJS under tsx and the import graph hits the
// ESM-only `@earendil-works/pi-coding-agent` 1.0.0 export via require
// (ERR_PACKAGE_PATH_NOT_EXPORTED). Pinned by this test.
const ENTRY = 'scripts/command-code-weekly-refresh.mts';

describe('weekly refresh entry loads in its npm-script module context (J1 correction 02)', () => {
  it('imports the entry through tsx from the repo root without ERR_PACKAGE_PATH_NOT_EXPORTED, without executing it', () => {
    const evalScript = [
      "import(process.env.J1_ENTRY_URL).then(",
      "  (m) => {",
      "    if (typeof m.runWeeklyRefresh !== 'function' || typeof m.main !== 'function') { console.error('LOAD_WRONG_EXPORTS'); process.exit(5); }",
      "    console.log('LOAD_OK');",
      "  },",
      "  (e) => { console.error('LOAD_FAIL', (e && e.code) || '', (e && e.message) || String(e)); process.exit(3); },",
      ");",
    ].join('\n');

    const result = spawnSync('npx', ['tsx', '-e', evalScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, J1_ENTRY_URL: pathToFileURL(path.join(REPO_ROOT, ENTRY)).href },
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(result.stdout).toContain('LOAD_OK');
    expect(result.stderr).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(result.status, `stderr: ${result.stderr.slice(-400)}`).toBe(0);
  }, 180_000);
});
