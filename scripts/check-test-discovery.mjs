#!/usr/bin/env node
/** Required unit/integration inventory. E2E and benchmarks have separate gates.
 * No optional files are currently declared: an all-skipped file fails closed.
 * Scan both source and test roots independently of Vitest include patterns so
 * moving a test outside an include cannot silently remove its protection.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaces = ['shared', 'server', 'client', 'packages/internal-api-mcp'];
const testName = /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/;
const excludedDirectories = new Set(['node_modules', 'dist', 'coverage', '.git']);

function scan(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return excludedDirectories.has(entry.name) ? [] : scan(path);
    // Do not follow symlinks out of the reviewed test roots.
    return entry.isFile() && testName.test(entry.name) ? [path] : [];
  });
}

export function checkDiscovery(root, workspace) {
  if (!workspaces.includes(workspace)) throw new Error(`Unknown required workspace: ${workspace}`);
  const home = resolve(root, workspace);
  const intended = ['src', 'tests'].flatMap(part => scan(join(home, part))).sort();
  if (!intended.length) throw new Error(`${workspace}: empty required test inventory`);
  const report = JSON.parse(readFileSync(join(home, 'test-results.json'), 'utf8'));
  if (!Array.isArray(report.testResults)) throw new Error(`${workspace}: malformed execution report`);
  const actual = new Map();
  for (const item of report.testResults) {
    if (typeof item.name !== 'string' || !Array.isArray(item.assertionResults)) {
      throw new Error(`${workspace}: malformed file result`);
    }
    const name = resolve(home, item.name);
    if (!intended.includes(name)) throw new Error(`${workspace}: unexpected file result ${name}`);
    if (actual.has(name)) throw new Error(`${workspace}: duplicate file result ${name}`);
    actual.set(name, item.assertionResults);
  }
  const files = intended.map(path => {
    const name = relative(root, path).split('\\').join('/');
    const assertions = actual.get(path);
    if (!assertions) throw new Error(`${name}: missing from execution report`);
    if (assertions.some(assertion => assertion.status === 'failed')) throw new Error(`${name}: failed assertions`);
    const executed = assertions.filter(assertion => assertion.status === 'passed').length;
    if (!executed) throw new Error(`${name}: no executed assertions`);
    return { path: name, executed };
  });
  return { schemaVersion: 1, workspace, exclusions: [...excludedDirectories], files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    if (args[0] === '--root') { args.shift(); root = resolve(args.shift()); }
    if (args.length !== 1) throw new Error('Usage: check-test-discovery.mjs [--root directory] workspace');
    console.log(JSON.stringify(checkDiscovery(root, args[0]), null, 2));
  } catch (error) {
    console.error(`Test discovery rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
