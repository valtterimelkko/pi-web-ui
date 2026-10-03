/**
 * Arm B (E2a-2) production fan-out driver — BUILT NOW, LIVE-RUN ONLY AFTER THE
 * PARENT'S GO (stress lock scheduled by the parent; order soak → 6c → 5 → 4).
 *
 *   systemd-run --scope --quiet --collect --unit=e2a-4-arm-b-driver \
 *     -p MemoryMax=4G -p MemorySwapMax=1G -- \
 *     node --import tsx scripts/e2a-runs... (see README)
 *
 * Shape: 8 GLM implementers + 2 Luna reviewers created on PRODUCTION through
 * pi-orch within ~30 s, tiny-but-real work in per-child fixture clones,
 * 5 s observation of production (/capacity, server + tools-slice cgroups,
 * host memory, CPU PSI, placed-process proof), 20-minute bound, full cleanup.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { materialiseFixtures } from './lib/fixtures.ts';
import { getCapacity } from './lib/httpclient.ts';
import { filterPlacedProcs, parsePsCgroupLine, readMemAvailableKb, readPressure } from './lib/hostsample.ts';
import { preflight, releaseLock, takeLock } from './lib/preflight.ts';
import { run, systemctlShow } from './lib/procsystemd.ts';
import { buildArmBPlan, cleanupArgv, promptArgv, spawnArgv, statusByOwnerArgv } from './lib/spawn-plan.ts';

const PI_ORCH_BIN = '/root/pi-orch/bin/pi-orch';
const OWNER = 'orch-e2-0798cc10-E2a-4-fan';
const PROD_CONN = { piOrchBin: PI_ORCH_BIN, socketPath: join(homedir(), '.pi-web-ui', 'internal-api.sock'), tokenPath: join(homedir(), '.pi-web-ui', 'internal-api-token') };
const OWNED_SESSIONS = '/root/orch-ops/orchestration-scaling/e2/owned-sessions.txt';
const PROD_CGROUP = '/sys/fs/cgroup/system.slice/pi-web-ui.service';
const TOOLS_SLICE_CGROUP = '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice';
const ANCHOR_FRAGMENT = 'pi-web-ui-tools-anchor.service';
const BOUND_S = 1200; // 20-minute hard bound

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

async function main(): Promise<number> {
  const runRoot = process.argv[process.argv.indexOf('--run-root') + 1] ?? `/root/e2a-runs/a4/arm-b-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const d of ['samples', 'fixtures', 'logs', 'creates']) mkdirSync(join(runRoot, d), { recursive: true });
  const log = (line: string): void => appendFileSync(join(runRoot, 'logs', 'armb.log'), `${new Date().toISOString()} ${line}\n`);

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

  try {
    const prodMainPidBefore = (await systemctlShow('pi-web-ui.service', ['MainPID']))['MainPID'];
    log(`production MainPID before: ${prodMainPidBefore ?? '?'}`);

    // Fixtures: per-child clones of /root/pi-orch at HEAD, npm ci BEFORE the fan-out.
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
    await materialiseFixtures(plan.fixtures.map((f) => ({ dir: f.dir, taskText: f.taskText, worktreeLike: false })));
    log('fixtures ready (clones + npm ci + task files)');

    // Samplers: 5 s resolution, 5 minutes before the fan-out.
    const warmupEnd = Date.now() + 5 * 60_000;
    log('5-minute pre-window sampling');
    while (Date.now() < warmupEnd) {
      await sampleProduction(runRoot);
      await new Promise((r) => setTimeout(r, 5000));
    }

    // THE fan-out: all 10 within ~30 s.
    const fanoutStart = Date.now();
    const outcomes = await Promise.all(plan.children.map(async (child) => {
      const startedAtMs = Date.now();
      const res = await run(spawnArgv(child, PROD_CONN), 600_000);
      const sessionId = res.code === 0 ? res.stdout.trim().split('\n').pop()?.trim() : undefined;
      if (sessionId) {
        // Owned-sessions ledger, IMMEDIATELY after each create (guard's cleanup list).
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

    // Tasks on every child (GLM implement / Luna review), fallbackApplied check.
    const promptResults = await Promise.all(plan.children.map(async (child) => {
      const rec = outcomes.find((o) => o.child === child.name);
      if (!rec?.sessionId) return null;
      const capRes = await run([PI_ORCH_BIN, 'status', rec.sessionId, '--socket=' + PROD_CONN.socketPath, '--token-path=' + PROD_CONN.tokenPath, '--json'], 30_000);
      if (capRes.code === 0 && /"fallbackApplied":\s*true/.test(capRes.stdout)) {
        log(`FALLBACK DETECTED on ${child.name} — refusing to continue`);
        throw new Error(`fallbackApplied=true on ${child.name}`);
      }
      const prompt = await run(promptArgv(rec.sessionId, child.taskText, `e2a4-armb-${child.name}`, PROD_CONN), 120_000);
      return { child: child.name, exitCode: prompt.code, runId: prompt.stdout.trim().split('\n').pop() };
    }));
    const promptRunIds = promptResults.filter((p): p is { child: string; exitCode: number; runId: string } => p !== null && p.exitCode === 0).map((p) => ({ child: p.child, runId: p.runId }));
    writeFileSync(join(runRoot, 'prompt-runs.json'), `${JSON.stringify(promptRunIds, null, 2)}\n`);
    log(`prompts dispatched: ${String(promptRunIds.length)}/${String(created.length)}`);

    // Observe at 5 s while the children work, hard-bounded, + 5 min after settle.
    const bound = Date.now() + BOUND_S * 1000;
    let settled = false;
    while (Date.now() < bound) {
      await sampleProduction(runRoot);
      const status = await run(statusByOwnerArgv(OWNER, PROD_CONN), 30_000);
      const busy = (status.stdout.match(/"busy":\s*true/g) ?? []).length;
      if (busy === 0 && Date.now() > fanoutStart + 120_000) {
        settled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    log(settled ? 'all owned children idle' : '20-minute bound hit — children still running will be recorded and cleaned up');
    const postEnd = Date.now() + 5 * 60_000;
    while (Date.now() < postEnd) {
      await sampleProduction(runRoot);
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Cleanup every owned session; verify; only then remove ledger lines is the PARENT's call —
    // this driver records what it cleaned and leaves verification to the hand-back.
    for (const rec of outcomes) {
      if (!rec.sessionId) continue;
      let cleanup = await run(cleanupArgv(rec.sessionId, PROD_CONN, OWNER), 180_000);
      if (cleanup.code === 2) cleanup = await run(cleanupArgv(rec.sessionId, PROD_CONN), 180_000);
      appendFileSync(join(runRoot, 'logs', 'cleanup.log'), `${rec.sessionId} exit ${String(cleanup.code)} ${cleanup.stderr.slice(0, 200)}\n`);
      log(`cleanup ${rec.sessionId} exit ${String(cleanup.code)}`);
    }
    const after = await run(statusByOwnerArgv(OWNER, PROD_CONN), 30_000);
    writeFileSync(join(runRoot, 'status-after-cleanup.json'), `${after.stdout}\n${after.stderr}\n`);

    const prodMainPidAfter = (await systemctlShow('pi-web-ui.service', ['MainPID']))['MainPID'];
    writeFileSync(join(runRoot, 'mainpid.json'), `${JSON.stringify({ before: prodMainPidBefore, after: prodMainPidAfter, unchanged: prodMainPidBefore === prodMainPidAfter })}\n`);
    copyFileSync(OWNED_SESSIONS, join(runRoot, 'owned-sessions-snapshot.txt'));
    log(`done; MainPID before=${prodMainPidBefore ?? '?'} after=${prodMainPidAfter ?? '?'}`);
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
