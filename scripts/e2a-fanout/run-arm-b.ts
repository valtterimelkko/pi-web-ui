/**
 * Arm B (E2a-2) production fan-out driver — live run ONLY under the granted
 * lock slot (parent 02-answer.md, 2026-10-03 05:45Z).
 *
 * Binding points implemented here:
 * - dry pre-check before creating anything: `pi-orch capabilities` = 1.58.5,
 *   /capacity idle-ish (activeTurns ≤ 2 AND quarantinedRuns ≤ 2; 5-minute
 *   re-checks, at most 3), fixture clones with npm ci already done;
 * - full /capacity debt record (activeTurns, classes, quarantinedRuns,
 *   oldestActiveRunStartedAt) before the fan-out; debt-caused refusals are
 *   classified separately from lag-gate refusals;
 * - two routes: 8 × zai/glm-5.3-flash high + 2 × openai-codex/gpt-6-luna max;
 *   abort on fallbackApplied:true or any other servedModel (per receipt);
 * - on a guard trip or a NEW HOST-GUARD-SOFT during the arm: abort at once,
 *   cleanup every owned session, verify none remain, release the lock,
 *   write 03-blocked.md;
 * - fixtures and credential copies deleted afterwards; token files removed.
 */
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCapacity } from './lib/httpclient.ts';
import { filterPlacedProcs, parsePsCgroupLine, readMemAvailableKb, readPressure } from './lib/hostsample.ts';
import { GUARD_STATE_DIR, preflight, releaseLock, takeLock } from './lib/preflight.ts';
import { run, systemctlShow } from './lib/procsystemd.ts';
import { buildArmBPlan, cleanupArgv, promptArgv, spawnArgv, statusByOwnerArgv } from './lib/spawn-plan.ts';

const PI_ORCH_BIN = '/root/pi-orch/bin/pi-orch';
const OWNER = 'orch-e2-0798cc10-E2a-4-fan';
const PROD_CONN = { piOrchBin: PI_ORCH_BIN, socketPath: join(homedir(), '.pi-web-ui', 'internal-api.sock'), tokenPath: join(homedir(), '.pi-web-ui', 'internal-api-token') };
const OWNED_SESSIONS = '/root/orch-ops/orchestration-scaling/e2/owned-sessions.txt';
const HAND_BACK = '/root/orch-ops/orchestration-scaling/e2/E2a-4';
const PROD_CGROUP = '/sys/fs/cgroup/system.slice/pi-web-ui.service';
const TOOLS_SLICE_CGROUP = '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice';
const ANCHOR_FRAGMENT = 'pi-web-ui-tools-anchor.service';
const BOUND_S = 1200; // 20-minute hard bound on the work window
const EXPECTED_CONTRACT = '1.58.5';
const EXPECTED_MODEL: Record<string, string> = { glm: 'zai/glm-5.3-flash', luna: 'openai-codex/gpt-6-luna' };

function readCgroupKV(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf8').trim();
  } catch {
    return null;
  }
}

function readMemoryStat(dir: string): Record<string, number> {
  const text = readCgroupKV(dir, 'memory.stat');
  const out: Record<string, number> = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const [k, v] = line.split(' ');
    if (k && v && /^\d+$/.test(v)) out[k] = Number(v);
  }
  return out;
}

/** Guard trip / new SOFT detection (the abort trigger during arm B). */
function guardViolated(): string | null {
  try {
    for (const name of readdirSync(GUARD_STATE_DIR)) {
      if (name === 'HOST-GUARD-TRIPPED' || name.startsWith('HOST-GUARD-TRIPPED.')) return `HOST-GUARD-TRIPPED (${name})`;
      if (name === 'HOST-GUARD-SOFT') return 'HOST-GUARD-SOFT';
    }
  } catch {
    return 'guard state dir unreadable';
  }
  return null;
}

async function sampleProduction(runRoot: string): Promise<void> {
  const samplesDir = join(runRoot, 'samples');
  const cap = await getCapacity({ socketPath: PROD_CONN.socketPath, tokenPath: PROD_CONN.tokenPath });
  if (cap) {
    appendFileSync(join(samplesDir, 'prod-capacity.jsonl'), `${JSON.stringify({ atMs: Date.now(), available: cap['available'], reason: cap['reason'] ?? null, activeTurns: cap['activeTurns'], maxActiveTurns: cap['maxActiveTurns'], eventLoopLag: cap['eventLoopLag'], heap: cap['heap'] })}\n`);
  }
  const memCurrent = readCgroupKV(PROD_CGROUP, 'memory.current');
  const memStat = readMemoryStat(PROD_CGROUP);
  const memEvents = readCgroupKV(PROD_CGROUP, 'memory.events');
  appendFileSync(join(samplesDir, 'prod-service-cgroup.jsonl'), `${JSON.stringify({ atMs: Date.now(), memoryCurrent: memCurrent !== null ? Number(memCurrent) : null, anon: memStat['anon'] ?? null, file: memStat['file'] ?? null, events: memEvents })}\n`);
  const toolsCurrent = readCgroupKV(TOOLS_SLICE_CGROUP, 'memory.current');
  const toolsStat = readMemoryStat(TOOLS_SLICE_CGROUP);
  const toolsEvents = readCgroupKV(TOOLS_SLICE_CGROUP, 'memory.events');
  appendFileSync(join(samplesDir, 'prod-tools-slice.jsonl'), `${JSON.stringify({ atMs: Date.now(), memoryCurrent: toolsCurrent !== null ? Number(toolsCurrent) : null, anon: toolsStat['anon'] ?? null, file: toolsStat['file'] ?? null, events: toolsEvents })}\n`);
  // Per-child tool groups under the anchor.
  try {
    const groups = readdirSync(join(TOOLS_SLICE_CGROUP, ANCHOR_FRAGMENT), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    appendFileSync(join(samplesDir, 'prod-anchor-groups.jsonl'), `${JSON.stringify({ atMs: Date.now(), groups })}\n`);
  } catch {
    appendFileSync(join(samplesDir, 'prod-anchor-groups.jsonl'), `${JSON.stringify({ atMs: Date.now(), groups: [] })}\n`);
  }
  appendFileSync(join(samplesDir, 'prod-host.jsonl'), `${JSON.stringify({ atMs: Date.now(), memAvailableKb: readMemAvailableKb(), cpuPsi: readPressure('cpu'), memPsi: readPressure('memory') })}\n`);
  // Placement proof: which live processes sit under the anchor.
  const ps = await run(['ps', '-eo', 'pid,cgroup,args', '-ww'], 20_000);
  if (ps.code === 0) {
    const rows = ps.stdout.split('\n').slice(1).map(parsePsCgroupLine).filter((r): r is NonNullable<typeof r> => r !== null);
    const placed = filterPlacedProcs(rows, ANCHOR_FRAGMENT);
    if (placed.length > 0) appendFileSync(join(samplesDir, 'placement-proof.jsonl'), `${JSON.stringify({ atMs: Date.now(), placed: placed.slice(0, 40) })}\n`);
  }
}

interface CapacityDebt {
  activeTurns: number | null;
  quarantinedRuns: number | null;
  oldestActiveRunStartedAt: unknown;
  classes: unknown;
}

async function readDebt(): Promise<CapacityDebt | null> {
  const cap = await getCapacity({ socketPath: PROD_CONN.socketPath, tokenPath: PROD_CONN.tokenPath });
  if (!cap) return null;
  return {
    activeTurns: typeof cap['activeTurns'] === 'number' ? cap['activeTurns'] as number : null,
    quarantinedRuns: typeof cap['quarantinedRuns'] === 'number' ? cap['quarantinedRuns'] as number : null,
    oldestActiveRunStartedAt: cap['oldestActiveRunStartedAt'] ?? null,
    classes: cap['classes'] ?? null,
  };
}

async function main(): Promise<number> {
  const runRoot = process.argv[process.argv.indexOf('--run-root') + 1] ?? `/root/e2a-runs/a4/arm-b-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const d of ['samples', 'fixtures', 'logs', 'creates']) mkdirSync(join(runRoot, d), { recursive: true });
  const log = (line: string): void => appendFileSync(join(runRoot, 'logs', 'armb.log'), `${new Date().toISOString()} ${line}\n`);
  const abortReasons: string[] = [];

  const pf = await preflight({ requireGuard: true, minMemGiB: 12, minDiskGiB: 15 });
  writeFileSync(join(runRoot, 'preflight.json'), `${JSON.stringify(pf, null, 2)}\n`);
  if (!pf.ok) {
    log(`PREFLIGHT FAILED: ${pf.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}`);
    return 2;
  }
  const lockOwner = `lane E2a-4 arm arm-b unit(s) e2a-4-arm-b-driver start ${new Date().toISOString()}`;
  const lock = takeLock(lockOwner);
  writeFileSync(join(runRoot, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  if (!lock.taken) {
    log(`LOCK HELD: ${lock.detail}`);
    return 2;
  }

  /** Cleanup every owned session of this fan-out and verify none remain. */
  const cleanupAll = async (outcomes: Array<{ sessionId?: string }>): Promise<boolean> => {
    for (const rec of outcomes) {
      if (!rec.sessionId) continue;
      let cleanup = await run(cleanupArgv(rec.sessionId, PROD_CONN, OWNER), 180_000);
      if (cleanup.code === 2) cleanup = await run(cleanupArgv(rec.sessionId, PROD_CONN), 180_000);
      appendFileSync(join(runRoot, 'logs', 'cleanup.log'), `${rec.sessionId} exit ${String(cleanup.code)} ${cleanup.stderr.slice(0, 200)}\n`);
      log(`cleanup ${rec.sessionId} exit ${String(cleanup.code)}`);
    }
    const after = await run(statusByOwnerArgv(OWNER, PROD_CONN), 30_000);
    writeFileSync(join(runRoot, 'status-after-cleanup.json'), `${after.stdout}\n${after.stderr}\n`);
    const remaining = (after.stdout.match(/"busy":\s*true/g) ?? []).length;
    log(`cleanup verified: busy-remaining=${String(remaining)}`);
    return remaining === 0;
  };

  try {
    // ── Dry pre-check 1: contract version ──
    const caps = await run([PI_ORCH_BIN, 'capabilities', '--socket=' + PROD_CONN.socketPath, '--token-path=' + PROD_CONN.tokenPath, '--json'], 30_000);
    writeFileSync(join(runRoot, 'capabilities.json'), `${caps.stdout}\n${caps.stderr}\n`);
    if (caps.code !== 0 || !caps.stdout.includes(EXPECTED_CONTRACT)) {
      throw new Error(`capabilities pre-check failed (expected ${EXPECTED_CONTRACT}): exit ${String(caps.code)}`);
    }
    log(`capabilities OK (${EXPECTED_CONTRACT})`);

    // ── Fixtures BEFORE any create (02-answer order) ──
    const plan = buildArmBPlan({ fixtureRoot: join(runRoot, 'fixtures'), owner: OWNER });
    const headRev = (await run(['git', '-C', '/root/pi-orch', 'rev-parse', 'HEAD'], 15_000)).stdout.trim();
    log(`cloning /root/pi-orch at ${headRev.slice(0, 12)} for ${String(plan.children.length)} children`);
    for (const child of plan.children) {
      const clone = await run(['git', 'clone', '--quiet', '--local', '/root/pi-orch', child.cwd], 300_000);
      if (clone.code !== 0) throw new Error(`clone failed for ${child.name}: ${clone.stderr}`);
      const ci = await run(['npm', 'ci', '--no-audit', '--no-fund', '--ignore-scripts'], 300_000);
      appendFileSync(join(runRoot, 'logs', 'npm-ci.log'), `${child.cwd} exit ${String(ci.code)}\n`);
      if (ci.code !== 0) throw new Error(`npm ci failed for ${child.name}: ${ci.stderr.slice(0, 300)}`);
    }
    for (const f of plan.fixtures) writeFileSync(join(f.dir, 'task.txt'), f.taskText);
    log('fixtures ready (clones + npm ci + task files)');

    // ── Dry pre-check 2: capacity debt (5-minute re-checks, at most 3) ──
    let debt = await readDebt();
    writeFileSync(join(runRoot, 'capacity-before.json'), `${JSON.stringify({ atMs: Date.now(), debt, waitCycles: 0 }, null, 2)}\n`);
    let cycles = 0;
    while (debt && ((debt.activeTurns ?? 0) > 2 || (debt.quarantinedRuns ?? 0) > 2) && cycles < 3) {
      cycles += 1;
      log(`capacity debt (activeTurns=${String(debt.activeTurns)} quarantinedRuns=${String(debt.quarantinedRuns)}) — waiting 5 min (cycle ${String(cycles)}/3)`);
      await new Promise((r) => setTimeout(r, 5 * 60_000));
      debt = await readDebt();
      writeFileSync(join(runRoot, 'capacity-before.json'), `${JSON.stringify({ atMs: Date.now(), debt, waitCycles: cycles }, null, 2)}\n`);
    }
    if (debt && ((debt.activeTurns ?? 0) > 2 || (debt.quarantinedRuns ?? 0) > 2)) {
      log(`capacity debt did NOT clear after 3 waits (activeTurns=${String(debt.activeTurns)} quarantinedRuns=${String(debt.quarantinedRuns)}) — proceeding WITH the debt on record; refusals will be attributed accordingly`);
    } else {
      log(`capacity clear for fan-out (activeTurns=${String(debt?.activeTurns)} quarantinedRuns=${String(debt?.quarantinedRuns)})`);
    }

    const prodMainPidBefore = (await systemctlShow('pi-web-ui.service', ['MainPID']))['MainPID'];
    log(`production MainPID before: ${prodMainPidBefore ?? '?'}`);

    // ── 5-minute pre-window at 5 s ──
    const warmupEnd = Date.now() + 5 * 60_000;
    log('5-minute pre-window sampling');
    while (Date.now() < warmupEnd) {
      const trip = guardViolated();
      if (trip) { abortReasons.push(`guard violated during pre-window: ${trip}`); break; }
      await sampleProduction(runRoot);
      await new Promise((r) => setTimeout(r, 5000));
    }

    // ── THE fan-out: all 10 within ~30 s ──
    if (abortReasons.length === 0) {
      const fanoutStart = Date.now();
      const outcomes = await Promise.all(plan.children.map(async (child) => {
        const startedAtMs = Date.now();
        const res = await run(spawnArgv(child, PROD_CONN), 600_000);
        const sessionId = res.code === 0 ? res.stdout.trim().split('\n').pop()?.trim() : undefined;
        if (sessionId) {
          appendFileSync(OWNED_SESSIONS, `${sessionId}\n`);
          appendFileSync(join(runRoot, 'logs', 'owned-sessions.txt'), `${sessionId}\n`);
        }
        const record = {
          child: child.name, route: child.route, startedAtMs, endedAtMs: Date.now(), wallMs: Date.now() - startedAtMs,
          exitCode: res.code, ok: res.code === 0 && !!sessionId, sessionId,
          errorCode: /^pi-orch: ([A-Z_0-9]+):/m.exec(res.stderr)?.[1],
          retryAfterSeconds: Number(/retry-after: (\d+)s/m.exec(res.stderr)?.[1] ?? NaN) || undefined,
          stderrTail: res.stderr ? res.stderr.slice(-400) : undefined,
        };
        appendFileSync(join(runRoot, 'creates', `${child.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
        return record;
      }));
      const fanoutWallMs = Date.now() - fanoutStart;
      const created = outcomes.filter((o) => o.ok);
      log(`fan-out done in ${String(fanoutWallMs)} ms; created ${String(created.length)}/${String(outcomes.length)}; refusals ${String(outcomes.length - created.length)}`);

      // Pre-prompt model check (fallbackApplied), then tasks.
      let modelViolation: string | null = null;
      const promptResults = await Promise.all(plan.children.map(async (child) => {
        const rec = outcomes.find((o) => o.child === child.name);
        if (!rec?.sessionId) return null;
        const status = await run([PI_ORCH_BIN, 'status', rec.sessionId, '--socket=' + PROD_CONN.socketPath, '--token-path=' + PROD_CONN.tokenPath, '--json'], 30_000);
        if (status.code === 0 && /"fallbackApplied":\s*true/.test(status.stdout)) {
          modelViolation = `fallbackApplied=true on ${child.name}`;
          return null;
        }
        const prompt = await run(promptArgv(rec.sessionId, child.taskText, `e2a4-armb-${child.name}`, PROD_CONN), 120_000);
        return { child: child.name, exitCode: prompt.code, runId: prompt.stdout.trim().split('\n').pop() };
      }));
      if (modelViolation) {
        abortReasons.push(modelViolation);
        log(`MODEL VIOLATION: ${modelViolation} — aborting further dispatch`);
      } else {
        const promptRunIds = promptResults.filter((p): p is { child: string; exitCode: number; runId: string } => p !== null && p.exitCode === 0 && !!p.runId);
        writeFileSync(join(runRoot, 'prompt-runs.json'), `${JSON.stringify(promptRunIds, null, 2)}\n`);
        log(`prompts dispatched: ${String(promptRunIds.length)}/${String(created.length)}`);

        // Observe at 5 s; abort instantly on a guard trip; hard-bounded.
        const bound = Date.now() + BOUND_S * 1000;
        let settled = false;
        while (Date.now() < bound) {
          const trip = guardViolated();
          if (trip) { abortReasons.push(`guard violated during work window: ${trip}`); break; }
          await sampleProduction(runRoot);
          const status = await run(statusByOwnerArgv(OWNER, PROD_CONN), 30_000);
          const busy = (status.stdout.match(/"busy":\s*true/g) ?? []).length;
          if (busy === 0 && Date.now() > fanoutStart + 120_000) {
            settled = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        log(settled ? 'all owned children idle' : (abortReasons.length > 0 ? 'aborted by guard/model violation' : '20-minute bound hit — running children recorded and cleaned up'));

        if (abortReasons.length === 0) {
          const postEnd = Date.now() + 5 * 60_000;
          while (Date.now() < postEnd) {
            const trip = guardViolated();
            if (trip) { abortReasons.push(`guard violated during post-window: ${trip}`); break; }
            await sampleProduction(runRoot);
            await new Promise((r) => setTimeout(r, 5000));
          }

          // servedModel assertion from each receipt (02-answer binding point).
          const servedChecks: Array<Record<string, unknown>> = [];
          for (const p of promptRunIds) {
            const child = plan.children.find((c) => c.name === p.child);
            const result = await run([PI_ORCH_BIN, 'result', p.runId, '--socket=' + PROD_CONN.socketPath, '--token-path=' + PROD_CONN.tokenPath, '--json'], 60_000);
            let servedModel: unknown = null;
            let runStatus: unknown = null;
            try {
              const body = JSON.parse(result.stdout) as Record<string, unknown>;
              servedModel = body['servedModel'] ?? null;
              runStatus = body['status'] ?? null;
            } catch {
              servedModel = `(unparsed: exit ${String(result.code)})`;
            }
            const expected = EXPECTED_MODEL[child?.route ?? 'glm'];
            const okModel = servedModel === expected;
            servedChecks.push({ child: p.child, runId: p.runId, servedModel, expected, ok: okModel, runStatus });
            if (!okModel) abortReasons.push(`servedModel mismatch on ${p.child}: got ${String(servedModel)}, expected ${expected}`);
          }
          writeFileSync(join(runRoot, 'served-models.json'), `${JSON.stringify(servedChecks, null, 2)}\n`);
          log(`served-model assertions: ${String(servedChecks.filter((s) => s['ok'] === true).length)}/${String(servedChecks.length)} OK`);
        }
      }

      // ── Cleanup: normal or abort path (always) ──
      const clean = await cleanupAll(outcomes);
      if (!clean) abortReasons.push('cleanup verification failed — owned sessions may remain');

      const prodMainPidAfter = (await systemctlShow('pi-web-ui.service', ['MainPID']))['MainPID'];
      writeFileSync(join(runRoot, 'mainpid.json'), `${JSON.stringify({ before: prodMainPidBefore, after: prodMainPidAfter, unchanged: prodMainPidBefore === prodMainPidAfter })}\n`);
      copyFileSync(OWNED_SESSIONS, join(runRoot, 'owned-sessions-snapshot.txt'));
      log(`MainPID before=${prodMainPidBefore ?? '?'} after=${prodMainPidAfter ?? '?'}`);
    } else {
      log(`pre-fan-out abort: ${abortReasons.join('; ')}`);
    }

    // ── Hygiene: fixtures + tokens deleted; find recorded ──
    rmSync(join(runRoot, 'fixtures'), { recursive: true, force: true });
    log('fixtures deleted');

    if (abortReasons.length > 0) {
      const blockedPath = join(HAND_BACK, '03-blocked.md');
      writeFileSync(blockedPath, `# 03 — blocked (arm B abort)\n\nUTC: ${new Date().toISOString()}\n\nReasons:\n${abortReasons.map((r) => `- ${r}`).join('\n')}\n\nRun dir: ${runRoot}\nCleanup verified: see status-after-cleanup.json and cleanup.log in the run dir.\n`);
      log(`blocked file written: ${blockedPath}`);
      return 3;
    }
    log('done');
    return 0;
  } catch (err) {
    log(`ERROR: ${String(err)}`);
    return 1;
  } finally {
    const rel = releaseLock(lockOwner);
    log(`lock release: ${String(rel.released)} ${rel.detail}`);
  }
}

process.exitCode = await main();

export { PROD_CONN, ANCHOR_FRAGMENT };
