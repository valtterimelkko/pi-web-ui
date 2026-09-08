import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const command = resolve('../scripts/check-test-discovery.mjs');
function fixture(statuses = ['passed']) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'shared/src'), { recursive: true });
  mkdirSync(join(root, 'shared/tests'), { recursive: true });
  writeFileSync(join(root, 'shared/src/one.test.ts'), '// fixture subject');
  const report = { testResults: [{ name: join(root, 'shared/src/one.test.ts'), assertionResults: statuses.map(status => ({ status })) }] };
  writeFileSync(join(root, 'shared/test-results.json'), JSON.stringify(report));
  return { root, report };
}
function run(root: string) {
  return spawnSync(process.execPath, [command, '--root', root, 'shared'], { encoding: 'utf8' });
}
describe('actual discovery gate command', () => {
  it('emits filesystem-derived inventory joined to executed assertions', () => {
    const { root } = fixture();
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual([{ path: 'shared/src/one.test.ts', executed: 1 }]);
  });
  it('rejects a moved or newly omitted external test', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'shared/tests/two.test.ts'), '// omitted');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('shared/tests/two.test.ts');
  });
  it.each([[], ['pending'], ['skipped']])('rejects zero executed assertions: %j', (...statuses) => {
    const { root } = fixture(statuses as string[]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no executed assertions');
  });
  it('rejects missing and malformed reports', () => {
    const { root } = fixture();
    rmSync(join(root, 'shared/test-results.json'));
    expect(run(root).status).toBe(1);
    writeFileSync(join(root, 'shared/test-results.json'), '{}');
    expect(run(root).status).toBe(1);
  });
  it.each(['failed', 'mystery'])('rejects non-passing assertion status %s', status => {
    const { root } = fixture([status]);
    expect(run(root).status).toBe(1);
  });
  it('rejects unexpected file results rather than ignoring them', () => {
    const { root, report } = fixture();
    report.testResults.push({ name: join(root, 'shared/elsewhere.test.ts'), assertionResults: [{ status: 'passed' }] });
    writeFileSync(join(root, 'shared/test-results.json'), JSON.stringify(report));
    expect(run(root).status).toBe(1);
  });
  it('enforces discovery at the real runner boundary with private credential-free child environment', () => {
    const { root } = fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const fakeNpm = join(bin, 'npm');
    writeFileSync(fakeNpm, `#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync('observed-env.json', JSON.stringify(process.env));\nfs.writeFileSync('shared/test-results.json', JSON.stringify({testResults:[{name:require('node:path').resolve('shared/src/one.test.ts'),assertionResults:[{status:'pending'}]}]}));\n`);
    chmodSync(fakeNpm, 0o700);
    const runner = resolve('../scripts/test-workspaces.mjs');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runWorkspaces } from ${JSON.stringify(runner)}; process.exitCode = runWorkspaces(${JSON.stringify(root)});`],
    { encoding: 'utf8', env: { ...process.env, PATH: bin, OPENAI_API_KEY: 'synthetic-must-not-inherit', PI_AGENT_DIR: '/unsafe-real-store', NODE_ENV: 'production' } });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('no executed assertions');
    const child = JSON.parse(readFileSync(join(root, 'observed-env.json'), 'utf8'));
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(child.NODE_ENV).toBe('test');
    expect(child.HOME).not.toBe(process.env.HOME);
    expect(child.PI_AGENT_DIR).not.toBe('/unsafe-real-store');
    expect(child.PI_CODING_AGENT_DIR).toBe(child.PI_AGENT_DIR);
  });

  it('rejects an empty required workspace', () => {
    const { root } = fixture();
    rmSync(join(root, 'shared/src/one.test.ts'));
    expect(run(root).status).toBe(1);
  });
});
