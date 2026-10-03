/** Fixture directories for fan-out children (tiny task files; worktree-like cwd for the real-pattern child). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './procsystemd.ts';

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
