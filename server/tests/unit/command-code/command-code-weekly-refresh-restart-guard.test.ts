import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWeeklyRefresh, runProcess, type ProcessRunner } from '../../../../scripts/command-code-weekly-refresh.mts';

/**
 * J1 disposable proof, arm 3, as a permanent regression test: the REAL
 * weekly-refresh job module (vitest's ESM resolution — the job's import graph
 * cannot load under plain tsx from the CJS root context, see the J1 evidence
 * bundle) driving the REAL scripts/restart-pi-web-ui.sh as a real child
 * process against a disposable unit: stub `systemctl`, a fake Internal API
 * `curl` shim, isolated lock/audit/notify, throwaway git fixture repos.
 *
 * Unlike command-code-weekly-refresh.test.ts this file deliberately does NOT
 * mock node:child_process: the restart leg must be real end-to-end.
 *
 * Arms:
 *   1. docs-only commit after the build  -> the guard passes on built content,
 *      the job restarts through the real wrapper (nothing rebuilt).
 *   2. build input changed after the build -> the wrapper refuses with exit 3
 *      and the guard message; the job fails naming the guard and saying the
 *      catalogue is pushed but NOT live — never the capacity reading.
 *   3. control: clean checkout but the Internal API socket missing -> a drain
 *      refusal, which the job still reads as a deferral (restarted=false).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WRAPPER = path.join(REPO_ROOT, 'scripts', 'restart-pi-web-ui.sh');
const TOKEN = 'j1-restart-guard-integration-token';
const UNIT = 'pi-web-ui-j1-guard-disposable.service';
const KNOWN_MODEL = 'deepseek/deepseek-v4-pro';
const NEW_MODEL = 'newvendor/new-model';

function git(dir: string, ...args: string[]): string {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
}

interface Fixture {
  repo: string;
  unitState: string;
}

function makeRepo(baseDir: string, name: string, postBuildFile: { rel: string; content: string } | null): Fixture {
  const repo = path.join(baseDir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'master');
  git(repo, 'config', 'user.email', 'j1-guard-test@example.com');
  git(repo, 'config', 'user.name', 'J1 guard test');
  writeFileSync(path.join(repo, '.gitignore'), 'server/dist/\n');
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'fixture base');
  const buildSha = git(repo, 'rev-parse', 'HEAD');
  const manifestDir = path.join(repo, 'server', 'dist', 'build-identity');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    path.join(manifestDir, 'embedded-manifest.json'),
    `${JSON.stringify({ manifestSchemaVersion: 1, identityStatus: 'known', buildMode: 'compiled', revision: buildSha }, null, 2)}\n`,
  );
  if (postBuildFile) {
    const abs = path.join(repo, postBuildFile.rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, postBuildFile.content);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'post-build commit');
  }
  const unitState = path.join(baseDir, `${name}.unit-state`);
  writeFileSync(unitState, 'active\n');
  return { repo, unitState };
}

const systemctlCalls = (unitState: string): string[] => {
  const logFile = `${unitState}.calls`;
  return existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
};

describe('weekly refresh restart path against the real wrapper (J1 disposable proof)', () => {
  let dir: string;
  let socketPath: string;
  let tokenPath: string;
  let binDir: string;
  let holder: net.Server;
  let savedEnv: Record<string, string | undefined>;

  const stubEnvFor = (checkout: string, unitState: string): void => {
    const stub = path.join(binDir, `systemctl-${path.basename(unitState)}`);
    writeFileSync(stub, [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = is-active ]; then',
      `  s="$(cat '${unitState}' 2>/dev/null || echo active)"`,
      '  printf \'%s\\n\' "$s"',
      '  [ "$s" = active ] && exit 0 || exit 3',
      'fi',
      `printf '%s\\n' "$*" >> '${unitState}.calls'`,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);
    process.env.PI_WEB_UI_SERVICE_UNIT = UNIT;
    process.env.PI_WEB_UI_INTERNAL_API_SOCKET = socketPath;
    process.env.PI_WEB_UI_INTERNAL_API_TOKEN_FILE = tokenPath;
    process.env.PI_WEB_UI_RESTART_SYSTEMCTL = stub;
    process.env.PI_WEB_UI_NOTIFY_SCRIPT = path.join(binDir, 'notify-stub');
    process.env.PI_WEB_UI_STOP_AUDIT_FILE = path.join(dir, `${path.basename(checkout)}-stop-audit.log`);
    process.env.PI_WEB_UI_SYSTEMD_CAT = path.join(dir, 'no-such-systemd-cat');
    process.env.PI_WEB_UI_PRODUCTION_LOCK = path.join(dir, 'production-control.lock');
    process.env.PI_WEB_UI_CHECKOUT_DIR = checkout;
    process.env.PI_WEB_UI_EXPECTED_BRANCH = 'master';
  };

  let gitStaged = false;
  const pipelineRunner = (realWrapper: boolean): ProcessRunner =>
    async (command, args, options) => {
      if (realWrapper && command === WRAPPER) {
        return runProcess(command, args, options);
      }
      if (command === 'git') {
        // The job's own catalogue git plumbing is pinned by
        // command-code-weekly-refresh.test.ts; here only the RESTART leg must
        // be real. The guard's own git commands run for real inside the
        // wrapper child against the fixture repo.
        if (args[0] === 'diff' && args.includes('--cached')) {
          // Pre-add staging check must be empty; after the add, the effort
          // table is the staged change (unseen model, no exclusions).
          const wasStaged = gitStaged;
          gitStaged = true;
          return { stdout: wasStaged ? 'efforts.ts\n' : '', stderr: '', exitCode: 0, timedOut: false };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      }
      if (command.endsWith('mock-cmd')) {
        if (args.includes('--list-models')) return { stdout: `Command Code CLI 1.50.0\n${KNOWN_MODEL}  available\n${NEW_MODEL}  available\n`, stderr: '', exitCode: 0, timedOut: false };
        if (args.includes('--model')) return { stdout: '{"result":"ok"}', stderr: '', exitCode: 0, timedOut: false };
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    };

  const jobOptions = (repo: string, realWrapper: boolean) => {
    gitStaged = false;
    return {
    paths: {
      repoRoot: repo,
      executablePath: path.join(binDir, 'mock-cmd'),
      cataloguePath: path.join(repo, 'catalogue.ts'),
      notify: path.join(binDir, 'notify-stub'),
      restartScript: WRAPPER,
      effortTableRel: 'efforts.ts',
      catalogueRel: 'catalogue.ts',
    },
    processRunner: pipelineRunner(realWrapper),
    createInternalApiClient: () => ({ listSessions: async () => ({ sessions: [] }) }),
    sleep: async () => undefined,
    };
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'j1-guard-integration-'));
    socketPath = path.join(dir, 'internal-api.sock');
    tokenPath = path.join(dir, 'internal-api-token');
    writeFileSync(tokenPath, TOKEN);
    // The scripts check `[ -S "$SOCKET" ]`; the fake curl answers in its place,
    // so a silent listener is enough.
    holder = net.createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(socketPath, () => resolve());
    });
    binDir = path.join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    // Fake Internal API curl: answers only the expected socket + token.
    const curlShim = path.join(binDir, 'curl');
    writeFileSync(curlShim, [
      '#!/usr/bin/env node',
      "'use strict';",
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      'let method = "GET", body, out, writeOut, socket, auth;',
      'for (let i = 0; i < argv.length; i++) {',
      '  const a = argv[i];',
      '  if (a === "-X") method = argv[++i];',
      '  else if (a === "--data-binary" || a === "-d") { body = argv[++i]; if (method === "GET") method = "POST"; }',
      '  else if (a === "-o") out = argv[++i];',
      '  else if (a === "-w") writeOut = argv[++i];',
      '  else if (a === "--unix-socket") socket = argv[++i];',
      '  else if (a === "-H") { const h = argv[++i]; if (/^authorization:/i.test(h)) auth = h.replace(/^authorization:\\s*/i, ""); }',
      '  else if (!a.startsWith("-")) { var url = a; }',
      '}',
      'const p = url ? new URL(url).pathname : "";',
      `if (socket !== ${JSON.stringify(socketPath)} || auth !== "Bearer ${TOKEN}") {`,
      '  process.stderr.write("curl: (7) Failed to connect\\n"); process.exit(7);',
      '}',
      'if (method === "POST" && p === "/api/v1/drain") {',
      '  const body = JSON.stringify({ state: "settled", draining: true, waitedMs: 5, initial: { activeTurns: 0, nonterminalRuns: 0 }, completedDuringDrain: 0, cutOffRunIds: [] });',
      '  if (out) fs.writeFileSync(out, body);',
      '  if (writeOut === "%{http_code}") process.stdout.write("200");',
      '  process.exit(0);',
      '}',
      'process.stderr.write("fake-curl: no route for " + method + " " + p + "\\n"); process.exit(7);',
      '',
    ].join('\n'));
    chmodSync(curlShim, 0o755);
    const notifyStub = path.join(binDir, 'notify-stub');
    writeFileSync(notifyStub, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(notifyStub, 0o755);
    // The job's restart call inherits this worker's env for the real wrapper
    // child; save and pin exactly what the scripts read.
    const keys = [
      'PATH', 'PI_WEB_UI_SERVICE_UNIT', 'PI_WEB_UI_INTERNAL_API_SOCKET', 'PI_WEB_UI_INTERNAL_API_TOKEN_FILE',
      'PI_WEB_UI_RESTART_SYSTEMCTL', 'PI_WEB_UI_NOTIFY_SCRIPT', 'PI_WEB_UI_STOP_AUDIT_FILE', 'PI_WEB_UI_SYSTEMD_CAT',
      'PI_WEB_UI_PRODUCTION_LOCK', 'PI_WEB_UI_CHECKOUT_DIR', 'PI_WEB_UI_EXPECTED_BRANCH', 'PI_WEB_UI_SESSION_ID', 'PI_SESSION_ID',
    ];
    savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    delete process.env.PI_WEB_UI_SESSION_ID;
    delete process.env.PI_SESSION_ID;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('arm 1: restarts through the real wrapper after a docs-only commit, without a rebuild', async () => {
    const fixture = makeRepo(dir, 'docs-only', { rel: 'docs/note.md', content: 'a docs change\n' });
    stubEnvFor(fixture.repo, fixture.unitState);

    const summary = await runWeeklyRefresh([], jobOptions(fixture.repo, true));

    expect(summary.committed).toBe(true);
    expect(summary.restarted).toBe(true);
    expect(systemctlCalls(fixture.unitState)).toEqual([`restart ${UNIT}`]);
    expect(readFileSync(process.env.PI_WEB_UI_STOP_AUDIT_FILE ?? '', 'utf8')).toContain('drain=settled');
  }, 60_000);

  it('arm 2: fails naming the checkout guard when a build input changed after the build', async () => {
    const fixture = makeRepo(dir, 'source-change', { rel: 'server/src/models.ts', content: 'export const v = 2;\n' });
    stubEnvFor(fixture.repo, fixture.unitState);

    let error: Error | undefined;
    try {
      await runWeeklyRefresh([], jobOptions(fixture.repo, true));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error, 'expected the job to fail on the guard refusal').toBeDefined();
    expect(error?.message ?? '').toMatch(/^pi-web-ui restart refused by the production checkout guard/);
    expect(error?.message ?? '').toContain('pushed but NOT live');
    expect(error?.message ?? '').not.toContain('the drain did not settle');
    expect(systemctlCalls(fixture.unitState)).toEqual([]);
    expect(existsSync(process.env.PI_WEB_UI_STOP_AUDIT_FILE ?? '')).toBe(false);
  }, 60_000);

  it('arm 3 control: a drain refusal (socket missing) still defers instead of failing', async () => {
    const fixture = makeRepo(dir, 'control', null);
    stubEnvFor(fixture.repo, fixture.unitState);
    const missingSocket = path.join(dir, 'absent.sock');

    const options = jobOptions(fixture.repo, true);
    const previousRunner = options.processRunner;
    options.processRunner = async (command, args, runOptions) => {
      if (command === WRAPPER) {
        const previous = process.env.PI_WEB_UI_INTERNAL_API_SOCKET;
        process.env.PI_WEB_UI_INTERNAL_API_SOCKET = missingSocket;
        try {
          return await runProcess(command, args, runOptions);
        } finally {
          if (previous === undefined) delete process.env.PI_WEB_UI_INTERNAL_API_SOCKET;
          else process.env.PI_WEB_UI_INTERNAL_API_SOCKET = previous;
        }
      }
      return previousRunner(command, args, runOptions);
    };

    const summary = await runWeeklyRefresh([], options);

    expect(summary.restarted).toBe(false);
    expect(systemctlCalls(fixture.unitState)).toEqual([]);
  }, 60_000);
});
