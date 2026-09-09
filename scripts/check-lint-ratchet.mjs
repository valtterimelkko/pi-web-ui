#!/usr/bin/env node
/** No-new-warning gate for changed implementation files. Historical warnings
 * are matched as a multiset of rule/message/source-line signatures, rather
 * than raw line numbers: inserted lines, moves and detected renames keep debt
 * stable, while duplicated or newly introduced warnings fail. No suppression
 * configuration is generated. The whole-repository warning ceiling is a
 * separate ratchet, supplied by the checked-in root command.
 */
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const implementation = /^(server|client|shared|packages\/internal-api-mcp)\/src\/.*\.(?:[cm]?[jt]s|[jt]sx)$/;
const testFile = /\.(?:test|spec)\.[^.]+$/;
function parseArgs(args) {
  const options = { root: fileURLToPath(new URL('..', import.meta.url)), base: 'HEAD', maxWarnings: 1723 };
  while (args.length) {
    const key = args.shift(); const value = args.shift();
    if (!value || !['--root', '--base', '--max-warnings'].includes(key)) throw new Error('Usage: check-lint-ratchet.mjs [--root dir] [--base revision] [--max-warnings N]');
    if (key === '--root') options.root = resolve(value);
    if (key === '--base') options.base = value;
    if (key === '--max-warnings') {
      if (!/^\d+$/.test(value)) throw new Error('Invalid warning ceiling');
      options.maxWarnings = Number(value);
    }
  }
  return options;
}
function warnings(result, source) {
  const lines = source.split(/\r?\n/);
  return result.messages.filter(m => m.severity === 1).map(m => ({
    key: JSON.stringify([m.ruleId, m.message, (lines[m.line - 1] ?? '').trim()]),
    description: `${result.filePath}:${m.line}:${m.column}: ${m.message} (${m.ruleId})`,
  }));
}

try {
  const { root, base, maxWarnings } = parseArgs(process.argv.slice(2));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Resolve once to an immutable commit; reject invalid/options-shaped refs.
  const commit = git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim();
  const changed = new Map();
  const fields = git('diff', '--name-status', '-z', '--find-renames', commit, '--').split('\0').filter(Boolean);
  while (fields.length) {
    const status = fields.shift(); const oldPath = fields.shift();
    const newPath = status.startsWith('R') || status.startsWith('C') ? fields.shift() : oldPath;
    if (status !== 'D') changed.set(newPath, status === 'A' ? null : oldPath);
  }
  for (const name of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) changed.set(name, null);
  const eslint = new ESLint({ cwd: root });
  const all = await eslint.lintFiles(['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']);
  const errors = all.reduce((sum, item) => sum + item.errorCount, 0);
  const warningCount = all.reduce((sum, item) => sum + item.warningCount, 0);
  const violations = [];
  if (errors) violations.push(`${errors} ESLint errors`);
  if (warningCount > maxWarnings) violations.push(`Warning ceiling exceeded: ${warningCount} > ${maxWarnings}`);
  for (const [name, oldPath] of changed) {
    if (!implementation.test(name) || testFile.test(name)) continue;
    const source = readFileSync(resolve(root, name), 'utf8');
    const [current] = await eslint.lintText(source, { filePath: name });
    const old = oldPath ? git('show', `${commit}:${oldPath}`) : '';
    const [previous] = await eslint.lintText(old, { filePath: name });
    const remaining = new Map();
    for (const item of warnings(previous, old)) remaining.set(item.key, (remaining.get(item.key) ?? 0) + 1);
    for (const item of warnings(current, source)) {
      const count = remaining.get(item.key) ?? 0;
      if (count) remaining.set(item.key, count - 1);
      else violations.push(item.description);
    }
  }
  console.log(JSON.stringify({ base: commit, warnings: warningCount, ceiling: maxWarnings, checkedChangedFiles: changed.size, violations }, null, 2));
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
} catch (error) {
  console.error(`Lint ratchet rejected: ${error.message}`);
  process.exitCode = 1;
}
