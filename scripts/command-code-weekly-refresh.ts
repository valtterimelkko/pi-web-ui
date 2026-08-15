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

interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runProcess(command: string, args: string[], options: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<ProcResult> {
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

function probeEligibility(model: string): Promise<ProcResult> {
  // Real-auth probe: the operator's own CLI home supplies auth, exactly like an
  // interactive `cmd` run. One tiny one-turn prompt per unseen model.
  return runProcess(EXECUTABLE_PATH, buildCommandCodeArgs({ executablePath: EXECUTABLE_PATH, model, maxTurns: 1 }), {
    input: `${ELIGIBILITY_PROMPT}\n`,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

async function notify(kind: string, title: string, body: string): Promise<void> {
  const result = await runProcess(NOTIFY, [kind, title, body], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) console.warn(`! notification '${title}' could not be submitted (exit ${result.exitCode})`);
}

function parseFlags(argv: string[]) {
  return {
    dryRun: argv.includes('--dry-run'),
    git: !argv.includes('--no-git'),
    restart: !argv.includes('--no-restart'),
    json: argv.includes('--json'),
  };
}

async function git(...args: string[]): Promise<ProcResult> {
  return runProcess('git', args, { timeoutMs: 60_000 });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const summary: Record<string, unknown> = { dryRun: flags.dryRun };

  // 1. Advertised catalogue.
  const listed = await runProcess(EXECUTABLE_PATH, ['--no-auto-update', '--list-models'], { timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (listed.timedOut || listed.exitCode !== 0) {
    throw new Error(`cmd --list-models failed (exit ${listed.exitCode ?? 'timeout'}); aborting without changes`);
  }
  const advertised = parseCommandCodeModelList(listed.stdout).models;
  if (advertised.length === 0) throw new Error('cmd --list-models advertised no models; aborting without changes');
  summary.advertised = advertised.length;

  // 2. Unseen ids = advertised − committed effort table − committed exclusions.
  const unseen = computeUnseenAdvertisedModels(advertised, Object.keys(COMMAND_CODE_EFFORT_TABLE), COMMAND_CODE_EXCLUDED_MODELS);
  summary.unseen = unseen;
  console.log(`advertised: ${advertised.length}; unseen: ${unseen.length}${unseen.length ? ` (${unseen.join(', ')})` : ''}`);

  // 3. Eligibility phase — only for unseen ids, and only if a control probe
  //    against a known-eligible model succeeds (otherwise auth/network is
  //    broken and no classification can be trusted).
  const ineligible: string[] = [];
  const inconclusive: string[] = [];
  if (unseen.length > 0) {
    const control = advertised.find((id) => COMMAND_CODE_EFFORT_TABLE[id] !== undefined) ?? advertised[0];
    const controlProbe = await probeEligibility(control);
    const controlClass = classifyEligibilityProbe(controlProbe);
    console.log(`control probe (${control}): ${controlClass}`);
    summary.control = { model: control, class: controlClass };
    if (controlClass !== 'eligible') {
      console.warn('! control probe was not cleanly eligible; skipping eligibility classification this run');
      inconclusive.push(...unseen);
    } else {
      for (const id of unseen) {
        const probe = await probeEligibility(id);
        const verdict: CommandCodeEligibility = classifyEligibilityProbe(probe);
        console.log(`  eligibility ${id}: ${verdict}${verdict === 'ineligible' ? '' : ` (exit ${probe.exitCode ?? 'timeout'})`}`);
        if (verdict === 'ineligible') ineligible.push(id);
        if (verdict === 'inconclusive') inconclusive.push(id);
      }
    }
  }
  summary.ineligible = ineligible;
  summary.inconclusive = inconclusive;

  // 4. Regenerate the committed effort table when new ids appeared (provider-free).
  let tableChanged = false;
  if (unseen.length > 0 && !flags.dryRun) {
    const regen = await runProcess('npm', ['run', 'commandcode:refresh-models'], { timeoutMs: 20 * 60_000 });
    if (regen.exitCode !== 0) throw new Error(`effort table regeneration failed:\n${regen.stdout.slice(-2_000)}\n${regen.stderr.slice(-2_000)}`);
    tableChanged = true;
  }

  // 5. Grow the exclusion list with proven-ineligible newcomers.
  let exclusionsChanged = false;
  if (ineligible.length > 0 && !flags.dryRun) {
    const source = await readFile(CATALOGUE_PATH, 'utf8');
    await writeFile(CATALOGUE_PATH, renderCatalogueExclusions(source, ineligible), 'utf8');
    exclusionsChanged = true;
  }
  summary.changed = { effortTable: tableChanged, exclusions: exclusionsChanged };

  if (unseen.length === 0) {
    console.log('catalogue is current; nothing to do');
    if (flags.json) console.log(JSON.stringify(summary));
    return;
  }
  if (flags.dryRun) {
    console.log('dry run: no files written, no git, no restart');
    if (flags.json) console.log(JSON.stringify(summary));
    return;
  }

  // 6. Gates before any commit: the committed artefacts must compile and the
  //    focused catalogue tests must pass.
  const typecheck = await runProcess('npm', ['run', 'typecheck', '--workspace=server'], { timeoutMs: 10 * 60_000 });
  if (typecheck.exitCode !== 0) throw new Error(`server typecheck failed after catalogue refresh:\n${typecheck.stderr.slice(-2_000)}`);
  const tests = await runProcess('npx', ['vitest', 'run', 'tests/unit/command-code/'], { timeoutMs: 10 * 60_000, cwd: path.join(REPO_ROOT, 'server') });
  if (tests.exitCode !== 0) throw new Error(`command-code unit tests failed after catalogue refresh:\n${tests.stdout.slice(-2_000)}`);
  // Production runs server/dist, so the refreshed table must be compiled in
  // before the restart below — otherwise the service would re-discover nothing.
  const build = await runProcess('npm', ['run', 'build', '--workspace=server'], { timeoutMs: 10 * 60_000 });
  if (build.exitCode !== 0) throw new Error(`server build failed after catalogue refresh:\n${build.stderr.slice(-2_000)}`);

  // 7. Commit and push exactly the two catalogue files. Refuse to sweep up a
  //    staging area someone else prepared.
  let committed = false;
  if (flags.git) {
    const staged = await git('diff', '--cached', '--name-only');
    if (staged.stdout.trim().length > 0) throw new Error(`git staging area is not empty (${staged.stdout.trim().split('\n').join(', ')}); refusing to commit`);
    await git('add', '--', EFFORT_TABLE_REL, CATALOGUE_REL);
    const stagedNow = (await git('diff', '--cached', '--name-only')).stdout.trim().split('\n').filter(Boolean).sort();
    const expected = [tableChanged ? EFFORT_TABLE_REL : undefined, exclusionsChanged ? CATALOGUE_REL : undefined].filter(Boolean).sort();
    if (JSON.stringify(stagedNow) !== JSON.stringify(expected)) {
      await git('reset', '-q', '--', EFFORT_TABLE_REL, CATALOGUE_REL);
      throw new Error(`staged paths ${JSON.stringify(stagedNow)} did not match expected ${JSON.stringify(expected)}; aborted without committing`);
    }
    if (expected.length > 0) {
      const message = `chore(command-code): weekly catalogue refresh — ${unseen.length} new advertised model(s), ${ineligible.length} GOAT exclusion(s)`;
      const commit = await git('commit', '-m', message);
      if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.slice(-500)}`);
      const push = await git('push');
      if (push.exitCode !== 0) {
        await notify('blocked', 'Command Code weekly refresh: push failed', `Committed locally but git push failed: ${push.stderr.slice(-300)}. Catalogue changes are local only until pushed and deployed.`);
        throw new Error('git push failed');
      }
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
    const client = new InternalApiClient();
    const deadline = Date.now() + RESTART_WAIT_WINDOW_MS;
    let idle = false;
    let capacityError: string | undefined;
    while (Date.now() < deadline) {
      try {
        const capacity = await client.getCapacity();
        capacityError = undefined;
        if ((capacity.activeTurns ?? 0) === 0) { idle = true; break; }
      } catch (error) {
        capacityError = error instanceof Error ? error.message : String(error);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
    }
    if (idle) {
      const restart = await runProcess('systemctl', ['restart', 'pi-web-ui'], { timeoutMs: 60_000 });
      restarted = restart.exitCode === 0;
      if (!restarted) console.warn(`! systemctl restart pi-web-ui exited ${restart.exitCode}: ${restart.stderr.slice(-300)}`);
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
  await notify('milestone', 'Command Code weekly catalogue refresh', lines);
  console.log(lines);
  if (flags.json) console.log(JSON.stringify(summary));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  await notify('blocked', 'Command Code weekly catalogue refresh failed', message.slice(0, 1_500)).catch(() => undefined);
  process.exitCode = 1;
});
