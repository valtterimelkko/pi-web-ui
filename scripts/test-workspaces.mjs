#!/usr/bin/env node
// Fixed workspace recipe. Provider environment is not inherited; this is not
// an OS sandbox and tests must still mock external services at their boundary.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { checkDiscovery } from './check-test-discovery.mjs';

export function runWorkspaces(root, coverage = false) {
  const home = mkdtempSync(join(tmpdir(), 'pi-web-ui-unit-home-'));
  const env = { NODE_ENV: 'test', HOME: home, PATH: process.env.PATH,
    LANG: 'C.UTF-8', TZ: 'UTC', CI: 'true',
    PI_AGENT_DIR: join(home, '.pi/agent'), PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: join(home, 'tmp'),
  };
  for (const path of [env.PI_AGENT_DIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.TMPDIR]) mkdirSync(path, { recursive: true });
  try {
    for (const workspace of ['shared', 'server', 'client', 'packages/internal-api-mcp']) {
      // Workspace Vitest configs disable Vite env loading; the server's
      // setup-env fixture also disables dotenv.config, preserving parse().
      for (const name of ['test-results.json', 'test-inventory.json']) rmSync(join(root, workspace, name), { force: true });
      const result = spawnSync('npm', [
        'run', coverage ? 'test:coverage' : 'test', `--workspace=${workspace}`,
        '--', '--maxWorkers=2', '--minWorkers=1',
      ], { cwd: root, stdio: 'inherit', env });
      if (result.error || result.status !== 0) {
        console.error(`Required workspace ${workspace} failed: ${result.error?.message ?? result.signal ?? result.status}`);
        return result.status || 1;
      }
      const inventory = checkDiscovery(root, workspace);
      writeFileSync(join(root, workspace, 'test-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
      console.log(`Discovery verified: ${workspace}, ${inventory.files.length} required files`);
    }
    return 0;
  } catch (error) {
    console.error(`Required workspace rejected: ${error.message}`);
    return 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--coverage')) {
    console.error('Usage: test-workspaces.mjs [--coverage]');
    process.exitCode = 1;
  } else {
    process.exitCode = runWorkspaces(fileURLToPath(new URL('..', import.meta.url)), args[0] === '--coverage');
  }
}
