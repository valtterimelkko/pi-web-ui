import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectFiles,
  generateBuildManifest,
  resolveBuildIdentity,
  type BuildIdentityFileSystem,
  type BuildManifest,
} from '../../../src/build-identity/manifest.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-build-identity-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'server', 'src'), { recursive: true });
  await mkdir(join(root, 'client', 'src'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(root, 'server', 'src', 'candidate.ts'), 'export const candidate = 1;\n');
  await writeFile(join(root, 'client', 'src', 'candidate.ts'), 'export const client = 1;\n');
  await writeFile(join(root, 'client', 'index.html'), '<!doctype html><div id="root"></div>\n');
  await writeFile(join(root, 'client', 'tailwind.config.js'), 'module.exports = {};\n');
  await writeFile(join(root, 'client', 'postcss.config.js'), 'module.exports = {};\n');
  await writeFile(join(root, 'scripts', 'live-validate.ts'), 'export const validation = 1;\n');
  await writeFile(join(root, 'server', 'tsconfig.json'), '{}');
  return root;
}

describe('build identity manifest', () => {
  it('changes the source fingerprint when declared build input content changes', async () => {
    const root = await fixtureRoot();
    const first = generateBuildManifest({ rootDir: root, revision: 'revision-a' });

    await writeFile(join(root, 'server', 'src', 'candidate.ts'), 'export const candidate = 2;\n');
    const second = generateBuildManifest({ rootDir: root, revision: 'revision-a' });

    expect(first.sourceFingerprint).not.toBe(second.sourceFingerprint);
    expect(first.buildId).not.toBe(second.buildId);
  });

  it('changes identity when browser, styling, and validation inputs change', async () => {
    const root = await fixtureRoot();
    const files = [
      ['client/index.html', '<!doctype html><div id="root">changed</div>\n'],
      ['client/tailwind.config.js', 'module.exports = { darkMode: "class" };\n'],
      ['client/postcss.config.js', 'module.exports = { plugins: {} };\n'],
      ['scripts/live-validate.ts', 'export const validation = 2;\n'],
    ] as const;

    for (const [pathname, replacement] of files) {
      const first = generateBuildManifest({ rootDir: root, revision: 'revision-a' });
      await writeFile(join(root, pathname), replacement);
      const second = generateBuildManifest({ rootDir: root, revision: 'revision-a' });
      expect(second.configFingerprint, pathname).not.toBe(first.configFingerprint);
      expect(second.buildId, pathname).not.toBe(first.buildId);
    }
  });

  it('marks a source identity unknown without following a symlink', async () => {
    const root = await fixtureRoot();
    const outside = await mkdtemp(join(tmpdir(), 'pi-build-identity-target-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'outside.ts'), 'export const outside = "must not be read";\n');
    await symlink(outside, join(root, 'client', 'src', 'linked-directory'), 'dir');

    const identity = generateBuildManifest({ rootDir: root, revision: 'revision-a' });

    expect(identity.identityStatus).toBe('unknown');
    expect(identity.sourceFingerprint).toBe('unknown');
  });

  it('marks an unreadable directory unknown instead of keeping a partial digest', async () => {
    const root = await fixtureRoot();
    const unreadable = join(root, 'server', 'src', 'unreadable');
    await mkdir(unreadable);
    await writeFile(join(unreadable, 'candidate.ts'), 'export const hidden = 1;\n');
    const fileSystem: BuildIdentityFileSystem = {
      lstatSync,
      readdirSync: (pathname) => {
        if (pathname === unreadable) {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return readdirSync(pathname);
      },
    };
    const files = new Set<string>();

    expect(collectFiles(join(root, 'server', 'src'), files, fileSystem)).toBe(false);
    expect(files.size).toBeGreaterThan(0);
    expect(generateBuildManifest({ rootDir: root, revision: 'revision-a', fileSystem }).identityStatus).toBe('unknown');
  });

  it('uses embedded compiled identity and never a caller environment label', async () => {
    const root = await fixtureRoot();
    const manifest = generateBuildManifest({ rootDir: root, revision: 'embedded-revision' });
    const manifestPath = join(root, 'embedded-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const previous = process.env.VITE_BUILD_VERSION;
    process.env.VITE_BUILD_VERSION = 'caller-label-must-not-win';

    try {
      const identity = resolveBuildIdentity({
        moduleUrl: `file://${root}/server/dist/build-identity/runtime-identity.js`,
        embeddedManifestPath: manifestPath,
      });
      expect(identity).toMatchObject({
        buildMode: 'compiled',
        buildId: manifest.buildId,
        revision: 'embedded-revision',
      });
      expect(identity.buildId).not.toContain('caller-label');
    } finally {
      if (previous === undefined) delete process.env.VITE_BUILD_VERSION;
      else process.env.VITE_BUILD_VERSION = previous;
    }
  });

  it('projects only validated manifest fields and rejects mismatched metadata', async () => {
    const root = await fixtureRoot();
    const manifest = generateBuildManifest({ rootDir: root, revision: 'embedded-revision' });
    const manifestPath = join(root, 'embedded-manifest.json');
    await writeFile(manifestPath, JSON.stringify({ ...manifest, unexpected: 'do-not-forward' }));

    const projected = resolveBuildIdentity({
      moduleUrl: `file://${root}/server/dist/build-identity/runtime-identity.js`,
      embeddedManifestPath: manifestPath,
    });
    expect(projected).not.toHaveProperty('unexpected');
    expect(projected).toMatchObject({ buildId: manifest.buildId, identityStatus: 'known' });

    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      buildId: 'build-00000000000000000000000000000000',
    }));
    expect(resolveBuildIdentity({
      moduleUrl: `file://${root}/server/dist/build-identity/runtime-identity.js`,
      embeddedManifestPath: manifestPath,
    }).identityStatus).toBe('unknown');

    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      buildFingerprint: 'sha256:not-a-digest',
    }));
    expect(resolveBuildIdentity({
      moduleUrl: `file://${root}/server/dist/build-identity/runtime-identity.js`,
      embeddedManifestPath: manifestPath,
    }).identityStatus).toBe('unknown');

    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      unexpected: 'x'.repeat(100_000),
    }));
    expect(resolveBuildIdentity({
      moduleUrl: `file://${root}/server/dist/build-identity/runtime-identity.js`,
      embeddedManifestPath: manifestPath,
    }).identityStatus).toBe('unknown');
  });

  it('makes unknown compiled identity explicit when the embedded manifest is absent', () => {
    const identity = resolveBuildIdentity({
      moduleUrl: 'file:///tmp/pi-web-ui/server/dist/build-identity/runtime-identity.js',
      embeddedManifestPath: '/tmp/pi-web-ui/no-such-manifest.json',
    });

    expect(identity.buildMode).toBe('compiled');
    expect(identity.identityStatus).toBe('unknown');
    expect(identity.buildId).toBe('unknown');
    expect(identity.sourceFingerprint).toBe('unknown');
  });

  it('marks source execution as source even when a generated manifest exists', async () => {
    const root = await fixtureRoot();
    const compiled = generateBuildManifest({ rootDir: root, revision: 'compiled-revision' });
    await writeFile(join(root, 'server', 'src', 'embedded-manifest.json'), JSON.stringify(compiled));

    const identity = resolveBuildIdentity({
      moduleUrl: `file://${root}/server/src/build-identity/runtime-identity.ts`,
      sourceRoot: root,
      embeddedManifestPath: join(root, 'server', 'src', 'embedded-manifest.json'),
    });

    expect(identity.buildMode).toBe('source');
    expect(identity.identityStatus).toBe('known');
    expect(identity.revision).toBe('unknown');
    expect(identity.buildId).toMatch(/^source-/);
    expect(identity.buildId).not.toBe(compiled.buildId);
  });

  it('keeps manifest metadata free of machine paths and environment values', async () => {
    const root = await fixtureRoot();
    const manifest: BuildManifest = generateBuildManifest({ rootDir: root, revision: 'safe-revision' });
    const serialised = JSON.stringify(manifest);

    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('VITE_BUILD_VERSION');
    expect(serialised).not.toContain('HOME');
  });
});

describe('build vs boot identity lifecycle pins', () => {
  it('keeps one boot identity per process and a stable build identity across calls', async () => {
    const { getRuntimeBuildIdentity } = await import('../../../src/build-identity/manifest.js');
    const { getProcessBootIdentity } = await import('../../../src/build-identity/runtime.js');

    const bootA = getProcessBootIdentity(Date.UTC(2026, 8, 8, 12, 0, 0));
    const buildA = getRuntimeBuildIdentity();
    const bootB = getProcessBootIdentity(Date.UTC(2026, 8, 8, 12, 5, 0));
    const buildB = getRuntimeBuildIdentity();

    // One loaded process: build identity and boot id are both retained.
    expect(buildA).toEqual(buildB);
    expect(bootA.bootId).toBe(bootB.bootId);
    expect(bootA.bootId).not.toBe(buildA.buildId);
    expect(bootB.startedAt).toBe(new Date(Date.UTC(2026, 8, 8, 12, 5, 0)).toISOString());
    // Unknown clock input degrades explicitly rather than inventing a time.
    expect(getProcessBootIdentity(Number.NaN).startedAt).toBe('unknown');
  });

  it('gives two real processes different boot ids over one shared build identity', async () => {
    const { spawnSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { pathToFileURL, fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const tsxLoader = createRequire(import.meta.url).resolve('tsx/esm');
    const runtimeUrl = pathToFileURL(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/build-identity/runtime.ts'),
    ).href;
    const readBoot = ((): { bootId: string; buildId: string } => {
      const result = spawnSync(process.execPath, [
        '--import', tsxLoader, '--input-type=module', '-e',
        `const m = await import(${JSON.stringify(runtimeUrl)}); console.log(JSON.stringify({ bootId: m.getProcessBootIdentity(Date.now()).bootId, buildId: m.runtimeBuildIdentity.buildId }));`,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout.trim().split('\n').pop());
    });
    const first = readBoot();
    const second = readBoot();
    expect(first.bootId).not.toBe(second.bootId);
    expect(first.buildId).toBe(second.buildId);
  });
});
