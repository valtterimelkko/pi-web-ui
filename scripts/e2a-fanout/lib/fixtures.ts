/** Fixture directories for fan-out children (tiny task files; worktree-like cwd for the real-pattern child). */
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './procsystemd.ts';

/**
 * Incident guard (2026-10-03): the arm-B fixture step once ran `npm ci` with
 * an INHERITED working directory — the worktree root, whose node_modules
 * symlinked into production — and emptied production's node_modules. Any npm
 * command in this harness must target a fixture clone UNDER the lane's run
 * root, resolved for real (no symlink escape), into a directory that exists
 * and whose node_modules is not a symlink.
 */
export function assertSafeNpmCwd(
  cwd: string,
  runRoot = '/root/e2a-runs/a4',
  deps: {
    lstatTarget?: (p: string) => { isSymbolicLink: () => boolean; isDirectory: () => boolean };
    realpathSync?: (p: string) => string;
  } = {},
): void {
  const lstat = deps.lstatTarget ?? ((p: string) => lstatSync(p));
  const real = deps.realpathSync ?? ((p: string) => realpathSync(p));
  const prefix = runRoot.endsWith('/') ? runRoot : `${runRoot}/`;
  if (cwd !== runRoot && !cwd.startsWith(prefix)) {
    throw new Error(
      `refusing to run npm outside the lane run root (${runRoot}): ${cwd} — this is the inherited-cwd class that emptied production's node_modules`,
    );
  }
  try {
    lstat(cwd);
  } catch {
    throw new Error(`fixture directory does not exist: ${cwd}`);
  }
  const resolved = real(cwd);
  if (resolved !== cwd && !resolved.startsWith(prefix)) {
    throw new Error(`fixture path resolves outside the lane run root (${runRoot}): ${cwd} -> ${resolved}`);
  }
  try {
    const st = lstat(join(cwd, 'node_modules'));
    if (st.isSymbolicLink()) {
      throw new Error(`refusing: ${join(cwd, 'node_modules')} is a symlink — npm would write through it (the production-emptying path)`);
    }
    void st.isDirectory;
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('refusing:') || err.message.startsWith('fixture path resolves'))) throw err;
    /* node_modules not present yet — fine, npm ci will create it */
  }
}

export interface FixtureSpec {
  dir: string;
  taskText: string;
  worktreeLike: boolean;
}

export async function materialiseFixtures(specs: FixtureSpec[]): Promise<void> {
  for (const spec of specs) {
    mkdirSync(spec.dir, { recursive: true });
    writeFileSync(join(spec.dir, 'task.txt'), spec.taskText);
    if (spec.worktreeLike) {
      // Fresh worktree-like cwd: a small real git repo with one commit, so the
      // real-pattern child pays a realistic cwd cost (H1 finding: real
      // worktree cwds cost more than /tmp-style ones).
      await run(['git', 'init', '-q', spec.dir], 30_000);
      await run(['git', '-C', spec.dir, 'checkout', '-q', '-b', 'main'], 15_000);
      writeFileSync(join(spec.dir, 'README.md'), `# ${spec.dir.split('/').pop()} fixture\n`);
      await run(['git', '-C', spec.dir, 'add', 'README.md'], 15_000);
      const git = await run(['git', '-C', spec.dir, '-c', 'user.email=e2a4@local', '-c', 'user.name=e2a4', 'commit', '-q', '-m', 'fixture init'], 30_000);
      if (git.code !== 0) throw new Error(`worktree-like fixture init failed in ${spec.dir}: ${git.stderr}`);
    }
  }
}

export interface FixtureInstallDecision {
  install: boolean;
  reason?: string;
  command?: 'ci' | 'install';
}

/**
 * 06-answer: dep-free clones (pi-orch) get NO npm step at all — their test
 * script is plain `node --test`, which runs on Node's type stripping without
 * any install. Clones WITH runtime dependencies install behind
 * `assertSafeNpmCwd`: `npm ci` with a committed lockfile, plain
 * `npm install --no-package-lock` without one.
 */
export function fixtureInstallDecision(
  pkg: { name?: string; dependencies?: unknown; devDependencies?: unknown },
  opts: { hasLockfile?: boolean } = {},
): FixtureInstallDecision {
  const hasDeps = pkg.dependencies !== undefined && typeof pkg.dependencies === 'object' && Object.keys(pkg.dependencies as object).length > 0;
  if (!hasDeps) return { install: false, reason: 'no runtime dependencies' };
  return { install: true, command: opts.hasLockfile ? 'ci' : 'install' };
}
