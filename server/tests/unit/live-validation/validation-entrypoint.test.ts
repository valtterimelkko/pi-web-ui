import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const helper = new URL('../../../../scripts/load-validation-entrypoint.mjs', import.meta.url).href;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validation-entry-'));
  mkdirSync(join(root, 'server/src'), { recursive: true });
  mkdirSync(join(root, 'server/dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'server/src/index.ts'), "export const selected = 'source';");
  writeFileSync(join(root, 'server/dist/index.js'), "export const selected = 'compiled';");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(mode: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { loadValidationEntrypoint } from ${JSON.stringify(helper)};
     const result = await loadValidationEntrypoint(new URL(${JSON.stringify(pathToFileURL(root + '/').href)}), ${JSON.stringify(mode)});
     console.log(result.selected);`], { encoding: 'utf8', timeout: 10000 });
}

describe('actual validation module loader', () => {
  it.each(['source', 'compiled'])('executes the selected %s module', mode => {
    const result = run(mode);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(mode);
  });

  it('does not hide a compiled-only failure by falling back to working source', () => {
    writeFileSync(join(root, 'server/dist/index.js'), "throw new Error('COMPILED_ONLY_FAILURE');");
    const compiled = run('compiled');
    expect(compiled.status).not.toBe(0);
    expect(compiled.stderr).toContain('COMPILED_ONLY_FAILURE');
    expect(run('source').status).toBe(0);
  });

  it('fails when compiled output is missing rather than importing source', () => {
    rmSync(join(root, 'server/dist/index.js'));
    const result = run('compiled');
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('source');
    expect(result.stderr).toContain('index.js');
  });

  it('rejects an unknown execution mode', () => {
    const result = run('production');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported validation entrypoint mode');
  });
});
