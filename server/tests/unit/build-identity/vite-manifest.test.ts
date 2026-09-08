// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClientBuildIdentity } from '../../../../client/vite.config.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-client-build-identity-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'server', 'src'), { recursive: true });
  await mkdir(join(root, 'server', 'dist', 'build-identity'), { recursive: true });
  await mkdir(join(root, 'client', 'src'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(root, 'server', 'src', 'candidate.ts'), 'export const candidate = 1;\n');
  await writeFile(join(root, 'client', 'src', 'candidate.ts'), 'export const client = 1;\n');
  await writeFile(join(root, 'client', 'index.html'), '<!doctype html><div id="root"></div>\n');
  await writeFile(join(root, 'client', 'tailwind.config.js'), 'module.exports = {};\n');
  await writeFile(join(root, 'client', 'postcss.config.js'), 'module.exports = {};\n');
  await writeFile(join(root, 'scripts', 'live-validate.ts'), 'export const validation = 1;\n');
  return root;
}

describe('Vite build identity loading', () => {
  it('computes a current client identity without touching stale server output', async () => {
    const root = await fixtureRoot();
    const stalePath = join(root, 'server', 'dist', 'build-identity', 'embedded-manifest.json');
    const stale = '{"buildId":"stale-server-build"}\n';
    await writeFile(stalePath, stale);

    const identity = loadClientBuildIdentity('build', root);

    expect(identity.identityStatus).toBe('known');
    expect(identity.buildMode).toBe('compiled');
    expect(await readFile(stalePath, 'utf8')).toBe(stale);
  });
});
