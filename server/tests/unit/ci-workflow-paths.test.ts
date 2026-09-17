/**
 * Guard for the CI trigger configuration.
 *
 * `.github/workflows/application.yml` skips the full correctness suite for
 * changes that cannot affect it, so a documentation-only push does not buy an
 * ~11-minute run. That optimisation is only safe while no file the suite
 * consumes is excluded, because a skipped job reports no failure at all:
 * over-ignoring converts a broken build into a silently green push.
 *
 * This test states the invariant mechanically instead of trusting a hand-kept
 * list. It discovers every Markdown file named by the code and tests the suite
 * actually runs, then asserts that none of them is excluded by the ignore list.
 *
 * Discovery is deliberately conservative. It matches any quoted string ending
 * in `.md` that resolves to a real repository file, so a documentation path
 * that only appears as data — an error-body `docs:` field, say — counts as
 * consumed even though editing it cannot fail a test. The bias is intentional:
 * a false positive costs one document its skip, while a false negative costs a
 * silent green push. Paths assembled dynamically cannot be discovered this way,
 * so the scan is a floor on the protected set rather than proof of
 * completeness.
 *
 * The workflow files are read as text rather than parsed. They are small, this
 * repository owns them, and the only YAML needed here is a flat list of quoted
 * globs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github/workflows');

/** Directories the correctness suite executes. `scripts/` is excluded: those
 *  files belong to the always-on documentation workflow, not to the suite. */
const SUITE_DIRS = ['server/src', 'server/tests', 'client/src', 'shared/src', 'packages'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

const WORKFLOWS = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOW_DIR, name), 'utf8');
}

/**
 * Every `- "glob"` entry belonging to any `key:` list in the document. Text
 * based on purpose: the only YAML this repository needs to read here is a flat
 * list of quoted globs, and both the push and pull_request events may carry one.
 */
function globList(source: string, key: string): string[] {
  const lines = source.split('\n');
  const globs: string[] = [];
  for (const [index, line] of lines.entries()) {
    // Tolerate a YAML anchor on the key line, e.g. `paths-ignore: &docs-only`.
    if (!new RegExp(`^${key}:\\s*(&\\S+)?\\s*$`).test(line.trim())) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const entry = lines[cursor];
      if (entry === undefined) break;
      if (entry.trim() === '' || entry.trim().startsWith('#')) continue;
      const match = entry.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      const glob = match?.[1];
      if (glob === undefined) break;
      globs.push(glob);
    }
  }
  return globs;
}

function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * GitHub applies the list in order: a matching entry sets the ignored state,
 * and a leading `!` clears it again for later entries.
 */
function isIgnored(relPath: string, patterns: string[]): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (globToRegExp(glob).test(relPath)) ignored = !negated;
  }
  return ignored;
}

/** Every real repository Markdown file that suite code or tests name. */
function suiteConsumedMarkdown(): string[] {
  const found = new Set<string>();
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/['"`]([^'"`\n]*\.md)['"`]/g)) {
        const literal = match[1];
        if (literal === undefined) continue;
        for (const candidate of [resolve(dirname(full), literal), resolve(REPO_ROOT, literal)]) {
          try {
            if (!statSync(candidate).isFile()) continue;
          } catch {
            continue;
          }
          found.add(relative(REPO_ROOT, candidate));
          break;
        }
      }
    }
  };
  for (const directory of SUITE_DIRS) visit(join(REPO_ROOT, directory));
  return [...found].sort();
}

/** Every Markdown document tracked by git. Tracked, not on-disk: the working
 *  tree can hold machine-local documents that CI never sees, and a candidate
 *  chosen from those would make this test diverge between environments. */
function trackedMarkdown(): string[] {
  return execFileSync('git', ['ls-files', '--', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

// The workflow that runs the suite is the one that runs the test commands.
const suiteWorkflow = WORKFLOWS.find((name) => /npm run test:coverage|npm test/.test(readWorkflow(name)));
// A workflow with no path filter on push always runs, so documentation changes
// are still checked even when the suite is skipped.
const alwaysOnDocsWorkflow = WORKFLOWS.find(
  (name) =>
    /docs:check-links|docs:check-agent-guides/.test(readWorkflow(name)) &&
    !/^\s*paths(-ignore)?:/m.test(readWorkflow(name)),
);

const suiteIgnorePatterns = suiteWorkflow ? globList(readWorkflow(suiteWorkflow), 'paths-ignore') : [];

describe('CI workflow trigger configuration', () => {
  const consumed = suiteConsumedMarkdown();

  it('keeps the documentation checks in a workflow that always runs', () => {
    expect(
      alwaysOnDocsWorkflow,
      'no workflow runs the documentation checks without a path filter. Documentation-only pushes skip the ' +
        'correctness suite, so those checks must live in a workflow that cannot be filtered out.',
    ).toBeDefined();
  });

  it('keeps the correctness suite and the documentation checks in separate workflows', () => {
    expect(suiteWorkflow, 'no workflow was found that runs the correctness suite').toBeDefined();
    expect(alwaysOnDocsWorkflow).not.toBe(suiteWorkflow);
    expect(
      suiteIgnorePatterns.length,
      'the correctness workflow must skip something, otherwise documentation-only pushes still pay for the full suite',
    ).toBeGreaterThan(0);
  });

  it('does not skip the suite for any Markdown file the suite consumes', () => {
    expect(
      consumed.length,
      'the discovery scan found no consumed Markdown files, so the scan itself has regressed',
    ).toBeGreaterThan(0);
    const overIgnored = consumed.filter((file) => isIgnored(file, suiteIgnorePatterns));
    expect(
      overIgnored,
      'these Markdown files are named by code or tests that the correctness suite runs, yet the workflow would ' +
        'skip the suite for a change touching only them. A skipped job cannot fail, so such a change could break ' +
        'the suite without CI reporting it. Re-include each one with a leading "!" entry.',
    ).toEqual([]);
  });

  it('still skips the suite for Markdown the suite does not consume', () => {
    const exempt = new Set(consumed);
    const skipped = trackedMarkdown().filter(
      (file) => !exempt.has(file) && isIgnored(file, suiteIgnorePatterns),
    );
    expect(
      skipped.length,
      'no tracked Markdown document outside the consumed set is skipped by the ignore globs, so a ' +
        'documentation-only change would still pay for the full suite and the optimisation is inert',
    ).toBeGreaterThan(0);
  });

  it('never skips the suite for implementation sources', () => {
    for (const file of [
      'server/src/index.ts',
      'client/src/main.tsx',
      'shared/src/protocol-types.ts',
      '.github/workflows/application.yml',
    ]) {
      expect(isIgnored(file, suiteIgnorePatterns), `${file} must never skip the correctness suite`).toBe(false);
    }
  });
});
