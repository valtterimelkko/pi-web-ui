import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// Root CLI helpers intentionally use node:test rather than Vitest. Keep their
// native runner, but include every required file in the ordinary root gate.
const root = resolve('..');
function discover(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path)
      : entry.isFile() && /\.(test|spec)\.mjs$/.test(entry.name) ? [path] : [];
  }).sort();
}
const files = discover(join(root, 'tests/unit'));
describe('required native Node CLI-helper files', () => {
  it('has a non-empty intended inventory', () => { expect(files.length).toBeGreaterThan(0); });
  it.each(files.map(file => [relative(root, file), file]))('executes non-skipped assertions in %s', (_name, file) => {
    const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    const count = (field: string) => {
      const values = [...output.matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
      expect(values.length, `missing native runner ${field} summary`).toBeGreaterThan(0);
      return Number(values.at(-1)?.[1]);
    };
    expect(count('pass')).toBeGreaterThan(0);
    expect(count('fail')).toBe(0);
    expect(count('cancelled')).toBe(0);
  });
});
