import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const roots: string[] = [];
const script = resolve('../scripts/check-lint-ratchet.mjs');
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lint-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'server/src'), { recursive: true });
  writeFileSync(join(root, '.eslintrc.json'), JSON.stringify({ root: true, parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules: { 'no-unused-vars': 'warn' } }));
  writeFileSync(join(root, 'server/src/subject.js'), 'const existingDebt = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline'], { cwd: root });
  return root;
}
function check(root: string) {
  return spawnSync(process.execPath, [script, '--root', root, '--base', 'HEAD'], { encoding: 'utf8' });
}
describe('actual changed-source lint ratchet command', () => {
  it('accepts unchanged debt after inserting unrelated lines', () => {
    const root = fixture();
    writeFileSync(join(root, 'server/src/subject.js'), '// shifted\n\nconst existingDebt = 1;\n');
    const result = check(root);
    expect(result.status, result.stderr).toBe(0);
  });
  it('rejects a new unused implementation variable', () => {
    const root = fixture();
    writeFileSync(join(root, 'server/src/subject.js'), 'const existingDebt = 1;\nconst newDebt = 2;\n');
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('newDebt');
  });
  it('accepts renamed existing debt', () => {
    const root = fixture();
    renameSync(join(root, 'server/src/subject.js'), join(root, 'server/src/renamed.js'));
    execFileSync('git', ['add', '-A'], { cwd: root });
    const result = check(root);
    expect(result.status, result.stderr).toBe(0);
  });
  it('rejects a warning in an untracked implementation file', () => {
    const root = fixture();
    writeFileSync(join(root, 'server/src/new.js'), 'const untrackedDebt = 3;\n');
    expect(check(root).status).toBe(1);
  });
  it('rejects an unknown baseline rather than silently comparing nothing', () => {
    const root = fixture();
    expect(spawnSync(process.execPath, [script, '--root', root, '--base', 'missing-ref'], { encoding: 'utf8' }).status).toBe(1);
  });
});
