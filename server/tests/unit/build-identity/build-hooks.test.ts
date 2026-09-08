import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporaryRoots: string[] = [];

function packageScripts(pathname: string): Record<string, string> {
  return JSON.parse(readFileSync(join(repoRoot, pathname), 'utf8')).scripts;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('build identity hooks', () => {
  it('writes the server manifest only from the successful server postbuild', () => {
    expect(packageScripts('package.json')).not.toHaveProperty('prebuild');
    expect(packageScripts('client/package.json')).not.toHaveProperty('prebuild');
    expect(packageScripts('server/package.json')).not.toHaveProperty('prebuild');
    expect(packageScripts('server/package.json').postbuild).toContain('generate-manifest.ts');
  });

  it('does not relabel a stale server manifest when server compilation fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-build-identity-failure-'));
    temporaryRoots.push(root);
    const manifestPath = join(root, 'dist/build-identity/embedded-manifest.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(manifestPath, '{"buildId":"stale-server-build"}\n');
    writeFileSync(join(root, 'dist/index.js'), 'OLD_COMPILED');
    writeFileSync(join(root, 'src/index.ts'), 'const deliberatelyInvalid: string = 42;\n');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: 'dist', types: [], skipLibCheck: true }, include: ['src'],
    }));
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const buildArgs = packageScripts('server/package.json').build.split(' ').slice(1).join(' ');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
      build: `${JSON.stringify(process.execPath)} ${JSON.stringify(tsc)} ${buildArgs}`,
      postbuild: `node -e "require('fs').writeFileSync('dist/build-identity/embedded-manifest.json','NEW')"`,
    } }));
    const result = runProcess(['run', 'build'], 'npm', root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('TS2322');
    expect(readFileSync(manifestPath, 'utf8')).toBe('{"buildId":"stale-server-build"}\n');
    expect(readFileSync(join(root, 'dist/index.js'), 'utf8')).toBe('OLD_COMPILED');
  });

  it('does not write generated manifests merely by importing generator helpers', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-build-identity-import-'));
    temporaryRoots.push(root);
    const identityDir = join(root, 'server', 'src', 'build-identity');
    mkdirSync(identityDir, { recursive: true });
    copyFileSync(
      join(repoRoot, 'server', 'src', 'build-identity', 'manifest.ts'),
      join(identityDir, 'manifest.ts'),
    );
    copyFileSync(
      join(repoRoot, 'server', 'src', 'build-identity', 'generate-manifest.ts'),
      join(identityDir, 'generate-manifest.ts'),
    );
    const moduleUrl = pathToFileURL(join(identityDir, 'generate-manifest.ts')).href;
    const tsxLoader = createRequire(import.meta.url).resolve('tsx/esm');
    const result = runProcess(
      ['--import', tsxLoader, '--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`],
      process.execPath,
      root,
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'server', 'src', 'build-identity', 'embedded-manifest.json'))).toBe(false);
    expect(existsSync(join(root, 'server', 'dist', 'build-identity', 'embedded-manifest.json'))).toBe(false);
  });
});

function runProcess(args: string[], executable = 'npm', cwd = repoRoot) {
  // Keep subprocesses synchronous so the stale-manifest assertion covers the
  // entire lifecycle and no generated state survives into another test.
  return spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}
