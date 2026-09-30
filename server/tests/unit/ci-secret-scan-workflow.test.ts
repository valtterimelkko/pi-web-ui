/**
 * Guard for the secret-scan workflow.
 *
 * The repository has legacy full-history findings awaiting owner triage, so the
 * CI secret scan must never scan full history: it scans only the commit range a
 * push or pull request introduces, via `gitleaks git --log-opts`. It must also
 * stay inside the owner's CI cost rules: free GitHub-hosted runners only, on
 * push and pull_request only, with a bounded job and concurrency cancellation.
 *
 * The workflow is read as text. It is small, this repository owns it, and the
 * assertions below only need a handful of flat lines.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github/workflows');

const WORKFLOWS = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOW_DIR, name), 'utf8');
}

const secretScanWorkflows = WORKFLOWS.filter((name) => /gitleaks/.test(readWorkflow(name)));

describe('secret-scan workflow', () => {
  it('exists', () => {
    expect(
      secretScanWorkflows,
      'no workflow runs gitleaks. Secret scanning must be enforced in CI, not only locally.',
    ).not.toEqual([]);
  });

  it('scans only the pushed/PR commit range, never full history', () => {
    const sources = secretScanWorkflows.map(readWorkflow);
    const joined = sources.join('\n');
    expect(
      joined,
      'the gitleaks invocation must scope the scan with --log-opts so full history is never scanned',
    ).toMatch(/--log-opts/);
    const gitleaksLines = joined
      .split('\n')
      .filter((line) => /gitleaks\s+git/.test(line) && !/^\s*#/.test(line));
    expect(gitleaksLines.length, 'no `gitleaks git` invocation was found').toBeGreaterThan(0);
    for (const line of gitleaksLines) {
      expect(
        line,
        `every gitleaks git invocation must carry --log-opts; this one does not: ${line.trim()}`,
      ).toMatch(/--log-opts/);
    }
    expect(joined, 'a baseline would silently accept legacy findings and is not permitted here').not.toMatch(
      /--baseline-path/,
    );
  });

  it('obeys the free-CI rules: push + PR only, ubuntu-latest, bounded, cancellable', () => {
    for (const name of secretScanWorkflows) {
      const source = readWorkflow(name);
      expect(source, `${name} must trigger on push`).toMatch(/^\s*push:\s*$/m);
      expect(source, `${name} must trigger on pull_request`).toMatch(/^\s*pull_request:\s*$/m);
      expect(source, `${name} must not use a cron schedule`).not.toMatch(/^\s*schedule:\s*$/m);
      expect(source, `${name} must not chain workflow_run`).not.toMatch(/^\s*workflow_run:\s*$/m);

      const runners = [...source.matchAll(/runs-on:\s*(\S+)/g)].map((match) => match[1]);
      expect(runners.length, `${name} has no runs-on`).toBeGreaterThan(0);
      for (const runner of runners) {
        expect(runner, `${name} must use only free ubuntu-latest runners`).toBe('ubuntu-latest');
      }

      const timeouts = [...source.matchAll(/timeout-minutes:\s*(\d+)/g)].map((match) => Number(match[1]));
      expect(timeouts.length, `${name} must set timeout-minutes on its job(s)`).toBeGreaterThan(0);
      for (const timeout of timeouts) {
        expect(timeout, `${name} timeouts must stay within the 10-minute budget`).toBeLessThanOrEqual(10);
      }

      expect(source, `${name} must declare concurrency`).toMatch(/concurrency:/);
      expect(source, `${name} must cancel superseded runs`).toMatch(/cancel-in-progress:\s*true/);
    }
  });
});
