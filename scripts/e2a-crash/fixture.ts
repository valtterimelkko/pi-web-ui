/**
 * Fixture repositories for the crash-recovery arms: trimmed copies of the
 * small real Node project /root/pi-orch (864 KB, zero runtime deps, node:test
 * suite) plus an injected build step, so a goal child does real worktree work
 * with observable, countable side effects (commits, build output with a
 * timestamp, one PROGRESS.log line per step).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const FIXTURE_SOURCE_REPO = '/root/pi-orch';

const BUILD_SCRIPT = `#!/usr/bin/env node
// Injected fixture build step: bundles a manifest of src/ into dist/ with a
// UTC timestamp so a re-run build is observable (and overwritable).
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const root = path.resolve(new URL('..', import.meta.url).pathname);
const files = walk(path.join(root, 'src'));
const builtAt = new Date().toISOString();
mkdirSync(path.join(root, 'dist'), { recursive: true });
const manifest = {
  builtAt,
  fileCount: files.length,
  bytes: files.reduce((a, f) => a + readFileSync(f).length, 0),
  files: files.map((f) => path.relative(root, f)),
};
writeFileSync(path.join(root, 'dist', 'build-info.json'), JSON.stringify(manifest, null, 2) + '\\n');
console.log('build ok at', builtAt, manifest.fileCount, 'files');
`;

const TASK_MD = `# Task (fixture)

Implement the small library task below in this repository. This is a fixture
for a crash-recovery measurement: do the work exactly as described so every
step leaves an observable side effect.

1. Add \`src/lib/slug.ts\` exporting \`slugify(input: string): string\`:
   lowercase, replace every run of non-alphanumeric characters with a single
   '-', trim leading/trailing '-'.
2. Add \`test/slug.test.ts\` (node:test style, like the existing tests) covering
   at least: plain words, multiple separators, leading/trailing separators,
   empty input.
3. Run \`npm test\` until green.
4. Run \`npm run build\`.
5. Commit in at least two commits: tests first, then the implementation.
6. After EVERY completed step above (each file written, each test run, the
   build, EACH commit), append exactly one line to \`PROGRESS.log\` in the repo
   root, of the form \`<UTC timestamp> step <what> ok\`.
`;

export interface FixtureSpec {
  name: string;
  repoDir: string;
}

/** Build one fixture repo. Idempotent: rebuilds from scratch. */
export function buildFixture(fixturesRoot: string, name: string): FixtureSpec {
  if (!existsSync(FIXTURE_SOURCE_REPO)) throw new Error(`Fixture source repo missing: ${FIXTURE_SOURCE_REPO}`);
  const repoDir = path.join(fixturesRoot, name, 'repo');
  rmSync(path.join(fixturesRoot, name), { recursive: true, force: true });
  mkdirSync(path.join(fixturesRoot, name), { recursive: true });
  cpSync(FIXTURE_SOURCE_REPO, repoDir, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.includes('/.git/') && path.basename(src) !== '.git' && path.basename(src) !== 'node_modules',
  });
  writeFileSync(path.join(repoDir, 'TASK.md'), TASK_MD);
  mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  writeFileSync(path.join(repoDir, 'scripts', 'build.mjs'), BUILD_SCRIPT, { mode: 0o755 });
  const pkgPath = path.join(repoDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
  pkg.scripts.build = 'node scripts/build.mjs';
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'e2a-6c-fixture@invalid'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'e2a-6c-fixture'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture baseline (trimmed pi-orch copy + build step)'], { cwd: repoDir });
  return { name, repoDir };
}

/** Build N fixtures named fixture-1..N. */
export function buildFixtures(fixturesRoot: string, count: number): FixtureSpec[] {
  const out: FixtureSpec[] = [];
  for (let i = 1; i <= count; i += 1) out.push(buildFixture(fixturesRoot, `fixture-${i}`));
  return out;
}

/** The single-line objective handed to a goal child on this fixture (arms: full task). */
export function armObjective(repoDir: string, childLabel: string): string {
  return (
    `You are child ${childLabel}. Work only inside ${repoDir}: follow TASK.md exactly — ` +
    'implement slugify with its tests, run npm test until green, run npm run build, commit tests first ' +
    'then implementation, and append one PROGRESS.log line after every completed step. ' +
    'Then end with the completion report block.'
  );
}

/** The short smoke objective (STRESS-GATE: tiny, no deliberate load, must finish well inside 300 s). */
export function smokeObjective(repoDir: string, childLabel: string): string {
  return (
    `You are child ${childLabel}. Work only inside ${repoDir}: run \`node --test test/exit-codes.test.ts\` once, ` +
    'append one line to PROGRESS.log of the form "<UTC timestamp> smoke node-test exit-codes ok", ' +
    `commit that single file with message "smoke: ${childLabel} progress log", then end with the completion report block. ` +
    'Do nothing else — no builds, no other tests.'
  );
}
