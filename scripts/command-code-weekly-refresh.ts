#!/usr/bin/env npx tsx
/**
 * Weekly Command Code catalogue refresh (GOAT plan).
 *
 * Detects models the CLI newly advertises, then maintains the two committed
 * catalogue artefacts so the browser selector and the Internal API stay
 * complete at the next server start:
 *
 *   1. `command-code-model-efforts.ts` — regenerated (provider-free probes) so
 *      new models gain their native effort selector.
 *   2. `command-code-model-catalog.ts` — the GOAT exclusion list grows by any
 *      new model a real-auth one-turn probe proves the plan cannot use.
 *
 * Eligibility probing is conservative (a control probe against a known-good
 * model must succeed first, and only explicit plan rejections or exit-4
 * permission denials exclude a model), so a flaky week can never hide usable
 * models. When files change, the job typechecks the server, runs the focused
 * catalogue tests, commits and pushes just those files on the current branch,
 * then restarts pi-web-ui once no turn is active — every step summarised over
 * Telegram via scripts/notify.sh.
 *
 * No secrets live here: the CLI's own ~/.commandcode auth is used in place,
 * and the internal-API token is only read by InternalApiClient for the
 * idle check.
 *
 * Usage:
 *   npm run commandcode:weekly-refresh                  # full run
 *   npm run commandcode:weekly-refresh -- --dry-run     # detect and probe only; no writes, git or restart
 *   npm run commandcode:weekly-refresh -- --no-git      # write files, skip commit/push
 *   npm run commandcode:weekly-refresh -- --no-restart  # skip the service restart
 *   npm run commandcode:weekly-refresh -- --json        # machine-readable summary on stdout
 *
 * Exit codes: 0 success (including "no changes"), 1 failure (fail closed).
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_CODE_EXCLUDED_MODELS,
  parseCommandCodeModelList,
} from '../server/src/command-code/command-code-model-catalog.js';
import { COMMAND_CODE_EFFORT_TABLE } from '../server/src/command-code/command-code-model-efforts.js';
import {
  classifyEligibilityProbe,
  computeUnseenAdvertisedModels,
  renderCatalogueExclusions,
  type CommandCodeEligibility,
} from '../server/src/command-code/command-code-catalogue-maintenance.js';
import { buildCommandCodeArgs } from '../server/src/command-code/command-code-config.js';
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTABLE_PATH = process.env.COMMAND_CODE_EXECUTABLE_PATH ?? '/root/.npm-global/bin/cmd';
const CATALOGUE_PATH = path.join(REPO_ROOT, 'server', 'src', 'command-code', 'command-code-model-catalog.ts');
const EFFORT_TABLE_REL = 'server/src/command-code/command-code-model-efforts.ts';
const CATALOGUE_REL = 'server/src/command-code/command-code-model-catalog.ts';
const NOTIFY = path.join(REPO_ROOT, 'scripts', 'notify.sh');
const PROBE_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const RESTART_WAIT_WINDOW_MS = 30 * 60_000;
const RESTART_POLL_MS = 30_000;
const ELIGIBILITY_PROMPT = 'Reply with one word: ok';

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<ProcResult>;

export interface WeeklyRefreshPaths {
  repoRoot: string;
  executablePath: string;
  cataloguePath: string;
  effortTableRel: string;
  catalogueRel: string;
  notify: string;
}

export interface WeeklyRefreshDependencies {
  processRunner?: ProcessRunner;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  writeFile?: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  createInternalApiClient?: () => { getCapacity(): Promise<{ activeTurns?: number; [key: string]: unknown }> };
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  paths?: Partial<WeeklyRefreshPaths>;
}

const DEFAULT_PATHS: WeeklyRefreshPaths = {
  repoRoot: REPO_ROOT,
  executablePath: EXECUTABLE_PATH,
  cataloguePath: CATALOGUE_PATH,
  effortTableRel: EFFORT_TABLE_REL,
  catalogueRel: CATALOGUE_REL,
  notify: NOTIFY,
};

function resolvePaths(overrides: Partial<WeeklyRefreshPaths> = {}): WeeklyRefreshPaths {
  return { ...DEFAULT_PATHS, ...overrides };
}

export function runProcess(command: string, args: string[], options: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      cwd: options.cwd ?? REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 200_000); });
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`, exitCode: null, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

function processSucceeded(result: ProcResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

function processExitDescription(result: ProcResult): string {
  return result.timedOut ? 'timeout' : String(result.exitCode ?? 'error');
}

function probeEligibility(model: string, paths: WeeklyRefreshPaths, run: ProcessRunner): Promise<ProcResult> {
  // Real-auth probe: the operator's own CLI home supplies auth, exactly like an
  // interactive `cmd` run. One tiny one-turn prompt per unseen model.
  return run(paths.executablePath, buildCommandCodeArgs({ executablePath: paths.executablePath, model, maxTurns: 1 }), {
    input: `${ELIGIBILITY_PROMPT}\n`,
    timeoutMs: PROBE_TIMEOUT_MS,
    cwd: paths.repoRoot,
  });
}

async function notify(kind: string, title: string, body: string, paths: WeeklyRefreshPaths, run: ProcessRunner): Promise<void> {
  const result = await run(paths.notify, [kind, title, body], { timeoutMs: 60_000, cwd: paths.repoRoot });
  if (!processSucceeded(result)) console.warn(`! notification '${title}' could not be submitted (exit ${processExitDescription(result)})`);
}

function parseFlags(argv: string[]) {
  return {
    dryRun: argv.includes('--dry-run'),
    git: !argv.includes('--no-git'),
    restart: !argv.includes('--no-restart'),
    json: argv.includes('--json'),
  };
}

async function git(run: ProcessRunner, paths: WeeklyRefreshPaths, ...args: string[]): Promise<ProcResult> {
  return run('git', args, { timeoutMs: 60_000, cwd: paths.repoRoot });
}

async function assertWorkingTreeClean(flags: ReturnType<typeof parseFlags>, paths: WeeklyRefreshPaths, run: ProcessRunner): Promise<void> {
  // A normal refresh may only start from a clean checkout. This protects both
  // the no-op path (which must not hide recovery work) and the later exact-file
  // commit from absorbing an earlier/manual edit to a catalogue artefact.
  if (flags.dryRun || !flags.git) return;
  const status = await git(run, paths, 'status', '--porcelain=v1', '--untracked-files=all');
  if (!processSucceeded(status)) {
    throw new Error(`git status failed (exit ${processExitDescription(status)}); refusing weekly refresh`);
  }
  const dirty = status.stdout.trim();
  if (dirty.length > 0) {
    throw new Error(`working tree is not clean; refusing weekly refresh (${dirty.split(/\r?\n/).join(', ')})`);
  }
}

export async function runWeeklyRefresh(
  argv: string[] = process.argv.slice(2),
  dependencies: WeeklyRefreshDependencies = {},
): Promise<Record<string, unknown>> {
  const flags = parseFlags(argv);
  const paths = resolvePaths(dependencies.paths);
  const run = dependencies.processRunner ?? runProcess;
  const readCatalogue = dependencies.readFile ?? readFile;
  const writeCatalogue = dependencies.writeFile ?? writeFile;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const summary: Record<string, unknown> = { dryRun: flags.dryRun };

  // 1. Advertised catalogue.
  const listed = await run(paths.executablePath, ['--no-auto-update', '--list-models'], {
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    cwd: paths.repoRoot,
  });
  if (!processSucceeded(listed)) {
    throw new Error(`cmd --list-models failed (exit ${processExitDescription(listed)}); aborting without changes`);
  }
  const advertised = parseCommandCodeModelList(listed.stdout).models;
  if (advertised.length === 0) throw new Error('cmd --list-models advertised no models; aborting without changes');
  summary.advertised = advertised.length;

  // 2. Unseen ids = advertised − committed effort table − committed exclusions.
  const unseen = computeUnseenAdvertisedModels(advertised, Object.keys(COMMAND_CODE_EFFORT_TABLE), COMMAND_CODE_EXCLUDED_MODELS);
  summary.unseen = unseen;
  console.log(`advertised: ${advertised.length}; unseen: ${unseen.length}${unseen.length ? ` (${unseen.join(', ')})` : ''}`);
  await assertWorkingTreeClean(flags, paths, run);

  // 3. Eligibility phase — only for unseen ids, and only if a control probe
  //    against a known-eligible model succeeds (otherwise auth/network is
  //    broken and no classification can be trusted).
  const ineligible: string[] = [];
  const inconclusive: string[] = [];
  if (unseen.length > 0) {
    const control = advertised.find((id) =>
      COMMAND_CODE_EFFORT_TABLE[id] !== undefined
      && !(COMMAND_CODE_EXCLUDED_MODELS as readonly string[]).includes(id));
    if (!control) {
      console.warn('! no known non-excluded control model is advertised; skipping eligibility classification this run');
      summary.control = { model: null, class: 'unavailable' };
      inconclusive.push(...unseen);
    } else {
      const controlProbe = await probeEligibility(control, paths, run);
      const controlClass = classifyEligibilityProbe(controlProbe);
      console.log(`control probe (${control}): ${controlClass}`);
      summary.control = { model: control, class: controlClass };
      if (controlClass !== 'eligible') {
        console.warn('! control probe was not cleanly eligible; skipping eligibility classification this run');
        inconclusive.push(...unseen);
      } else {
        for (const id of unseen) {
          const probe = await probeEligibility(id, paths, run);
          const verdict: CommandCodeEligibility = classifyEligibilityProbe(probe);
          console.log(`  eligibility ${id}: ${verdict}${verdict === 'ineligible' ? '' : ` (exit ${probe.exitCode ?? 'timeout'})`}`);
          if (verdict === 'ineligible') ineligible.push(id);
          if (verdict === 'inconclusive') inconclusive.push(id);
        }
      }
    }
  }
  summary.ineligible = ineligible;
  summary.inconclusive = inconclusive;

  // 4. Regenerate the committed effort table when new ids appeared (provider-free).
  let tableChanged = false;
  if (unseen.length > 0 && !flags.dryRun) {
    const regen = await run('npm', ['run', 'commandcode:refresh-models'], {
      timeoutMs: 20 * 60_000,
      cwd: paths.repoRoot,
    });
    if (!processSucceeded(regen)) throw new Error(`effort table regeneration failed (exit ${processExitDescription(regen)}):\n${regen.stdout.slice(-2_000)}\n${regen.stderr.slice(-2_000)}`);
    tableChanged = true;
  }

  // 5. Grow the exclusion list with proven-ineligible newcomers.
  let exclusionsChanged = false;
  if (ineligible.length > 0 && !flags.dryRun) {
    const source = await readCatalogue(paths.cataloguePath, 'utf8');
    await writeCatalogue(paths.cataloguePath, renderCatalogueExclusions(source, ineligible), 'utf8');
    exclusionsChanged = true;
  }
  summary.changed = { effortTable: tableChanged, exclusions: exclusionsChanged };

  if (unseen.length === 0) {
    console.log('catalogue is current; nothing to do');
    if (flags.json) console.log(JSON.stringify(summary));
    return summary;
  }
  if (flags.dryRun) {
    console.log('dry run: no files written, no git, no restart');
    if (flags.json) console.log(JSON.stringify(summary));
    return summary;
  }

  // 6. Gates before any commit: the committed artefacts must compile and the
  //    focused catalogue tests must pass.
  const typecheck = await run('npm', ['run', 'typecheck', '--workspace=server'], {
    timeoutMs: 10 * 60_000,
    cwd: paths.repoRoot,
  });
  if (!processSucceeded(typecheck)) throw new Error(`server typecheck failed after catalogue refresh (exit ${processExitDescription(typecheck)}):\n${typecheck.stderr.slice(-2_000)}`);
  const tests = await run('npx', ['vitest', 'run', 'tests/unit/command-code/'], {
    timeoutMs: 10 * 60_000,
    cwd: path.join(paths.repoRoot, 'server'),
  });
  if (!processSucceeded(tests)) throw new Error(`command-code unit tests failed after catalogue refresh (exit ${processExitDescription(tests)}):\n${tests.stdout.slice(-2_000)}`);
  // Production runs server/dist, so the refreshed table must be compiled in
  // before the restart below — otherwise the service would re-discover nothing.
  const build = await run('npm', ['run', 'build', '--workspace=server'], {
    timeoutMs: 10 * 60_000,
    cwd: paths.repoRoot,
  });
  if (!processSucceeded(build)) throw new Error(`server build failed after catalogue refresh (exit ${processExitDescription(build)}):\n${build.stderr.slice(-2_000)}`);

  // 7. Commit and push exactly the two catalogue files. Refuse to sweep up a
  //    staging area someone else prepared.
  let committed = false;
  if (flags.git) {
    const staged = await git(run, paths, 'diff', '--cached', '--name-only');
    if (!processSucceeded(staged)) throw new Error(`git staging check failed (exit ${processExitDescription(staged)}); refusing to commit`);
    if (staged.stdout.trim().length > 0) throw new Error(`git staging area is not empty (${staged.stdout.trim().split('\n').join(', ')}); refusing to commit`);
    const add = await git(run, paths, 'add', '--', paths.effortTableRel, paths.catalogueRel);
    if (!processSucceeded(add)) throw new Error(`git add failed (exit ${processExitDescription(add)}); refusing to commit`);
    const stagedCheck = await git(run, paths, 'diff', '--cached', '--name-only');
    if (!processSucceeded(stagedCheck)) throw new Error(`git staging verification failed (exit ${processExitDescription(stagedCheck)}); refusing to commit`);
    const stagedNow = stagedCheck.stdout.trim().split('\n').filter(Boolean).sort();
    const expected = [tableChanged ? paths.effortTableRel : undefined, exclusionsChanged ? paths.catalogueRel : undefined].filter(Boolean).sort();
    if (JSON.stringify(stagedNow) !== JSON.stringify(expected)) {
      await git(run, paths, 'reset', '-q', '--', paths.effortTableRel, paths.catalogueRel);
      throw new Error(`staged paths ${JSON.stringify(stagedNow)} did not match expected ${JSON.stringify(expected)}; aborted without committing`);
    }
    if (expected.length > 0) {
      const message = `chore(command-code): weekly catalogue refresh — ${unseen.length} new advertised model(s), ${ineligible.length} GOAT exclusion(s)`;
      const commit = await git(run, paths, 'commit', '-m', message);
      if (!processSucceeded(commit)) throw new Error(`git commit failed (exit ${processExitDescription(commit)}): ${commit.stderr.slice(-500)}`);
      const push = await git(run, paths, 'push');
      if (!processSucceeded(push)) throw new Error(`git push failed (exit ${processExitDescription(push)}): ${push.stderr.slice(-300)}`);
      committed = true;
      console.log(`committed and pushed: ${message}`);
    }
  }
  summary.committed = committed;

  // 8. Idle-aware restart so the running server re-discovers the catalogue
  //    (discovery happens at init). A busy server defers the restart; the
  //    committed changes simply take effect at the next ordinary restart.
  let restarted = false;
  if (flags.restart && committed) {
    const client = dependencies.createInternalApiClient?.() ?? new InternalApiClient();
    const deadline = now() + RESTART_WAIT_WINDOW_MS;
    let idle = false;
    let capacityError: string | undefined;
    while (now() < deadline) {
      try {
        const capacity = await client.getCapacity();
        capacityError = undefined;
        if ((capacity.activeTurns ?? 0) === 0) { idle = true; break; }
      } catch (error) {
        capacityError = error instanceof Error ? error.message : String(error);
        break;
      }
      await sleep(RESTART_POLL_MS);
    }
    if (idle) {
      const restart = await run('systemctl', ['restart', 'pi-web-ui'], { timeoutMs: 60_000, cwd: paths.repoRoot });
      if (!processSucceeded(restart)) {
        throw new Error(`pi-web-ui restart failed (exit ${processExitDescription(restart)}): ${restart.stderr.slice(-300)}`);
      }
      restarted = true;
    } else {
      console.warn(`! server busy or capacity probe failed (${capacityError ?? 'turns still active'}); restart deferred`);
    }
  }
  summary.restarted = restarted;

  // 9. Telegram summary.
  const lines = [
    `Advertised: ${advertised.length}; newly seen: ${unseen.length}${unseen.length ? ` (${unseen.join(', ')})` : ''}.`,
    ineligible.length ? `Newly excluded (not in GOAT plan): ${ineligible.join(', ')}.` : 'No new exclusions.',
    inconclusive.length ? `Inconclusive probes (left eligible, retried next week): ${inconclusive.join(', ')}.` : undefined,
    committed ? 'Committed and pushed the catalogue files.' : (flags.git ? 'No commit needed.' : 'Git step skipped (--no-git).'),
    restarted ? 'pi-web-ui restarted; new models are live in the selector and Internal API.' : 'Service not restarted this run; changes go live at the next restart.',
  ].filter(Boolean).join('\n');
  await notify('milestone', 'Command Code weekly catalogue refresh', lines, paths, run);
  console.log(lines);
  if (flags.json) console.log(JSON.stringify(summary));
  return summary;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runWeeklyRefresh(argv);
}

async function cliMain(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    await main(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // A dry-run is explicitly discovery/probe-only, including on failure: do
    // not turn its error path into an outward notification write.
    if (!parseFlags(argv).dryRun) {
      await notify('blocked', 'Command Code weekly catalogue refresh failed', message.slice(0, 1_500), DEFAULT_PATHS, runProcess).catch(() => undefined);
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  void cliMain();
}
