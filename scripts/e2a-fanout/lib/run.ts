/**
 * Arm A (and its smoke) orchestration: pre-flight → production snapshot →
 * isolated agent dir + fixtures → anchor + disposable server (bounded units,
 * mirrored settings, placement at the lane's own anchor) → fan-out passes
 * through pi-orch with per-create records and 1 s samplers → teardown →
 * latch analysis.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseA2Jsonl, summariseA2 } from './a2.ts';
import { analyseArmA } from './analyze.ts';
import { assertNotProductionAgentDir, buildIsolatedAgentDir } from './agentdir.ts';
import { materialiseFixtures, type FixtureSpec } from './fixtures.ts';
import { getCapacity, type SocketConn } from './httpclient.ts';
import { deriveRetry } from './latch.ts';
import { readPressure } from './hostsample.ts';
import { preflight, releaseLock, takeLock } from './preflight.ts';
import { journalGrep, run, stopUnit, systemctlShow, waitForMainPid } from './procsystemd.ts';
import { buildArmAPlan, cleanupArgv, promptArgv, spawnArgv, statusByOwnerArgv, waitAllArgv, type ChildSpec } from './spawn-plan.ts';
import { capacitySettingsFromCapacity, mirrorServerEnv, parseSystemctlEnvironment, selectMirrorKeys, type ProductionSettingsSnapshot } from './settings.ts';
import { buildAnchorUnitArgs, buildServerUnitArgs, anchorStartScript } from './units.ts';
import type { CapacitySample, CreateRecord } from './types.ts';
import type { A2Sample } from './types.ts';

export const PI_ORCH_BIN = '/root/pi-orch/bin/pi-orch';
export const LANE_SLICE = 'e2a-4.slice';
export const OWNER = 'orch-e2-0798cc10-E2a-4-fan';
export const WORKTREE_ROOT = join(import.meta.dirname, '..', '..', '..');

export interface ArmOptions {
  mode: 'smoke' | 'arm-a';
  runRoot: string;
  passSize: number;
  passes: Array<{ step: 'pass1' | 'pass2'; parallel: boolean; size: number }>;
  memoryMax: string;
  serverRuntimeMaxSec: number;
  promptDeadlineS: number;
  takeStressLock: boolean;
}

export function armOptionsFor(mode: 'smoke' | 'arm-a', runRoot: string): ArmOptions {
  if (mode === 'smoke') {
    return { mode, runRoot, passSize: 2, passes: [{ step: 'pass2', parallel: true, size: 2 }], memoryMax: '2G', serverRuntimeMaxSec: 300, promptDeadlineS: 100, takeStressLock: false };
  }
  return { mode, runRoot, passSize: 10, passes: [{ step: 'pass1', parallel: false, size: 10 }, { step: 'pass2', parallel: true, size: 10 }], memoryMax: '8G', serverRuntimeMaxSec: 3600, promptDeadlineS: 420, takeStressLock: true };
}

async function findFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close(() => reject(new Error('no ephemeral port')));
        return;
      }
      const port = address.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

interface SamplerHandle {
  stop: () => void;
}

function startSamplers(runRoot: string, conn: SocketConn): SamplerHandle {
  const capacityPath = join(runRoot, 'samples', 'capacity.jsonl');
  const hostPath = join(runRoot, 'samples', 'host.jsonl');
  const timers: NodeJS.Timeout[] = [];

  const capacityTimer = setInterval(() => {
    void (async () => {
      const body = await getCapacity(conn);
      const sample: CapacitySample = {
        atMs: Date.now(),
        available: typeof body?.['available'] === 'boolean' ? (body['available'] as boolean) : null,
        reason: typeof body?.['reason'] === 'string' ? (body['reason'] as string) : null,
        activeTurns: typeof body?.['activeTurns'] === 'number' ? (body['activeTurns'] as number) : null,
        maxActiveTurns: typeof body?.['maxActiveTurns'] === 'number' ? (body['maxActiveTurns'] as number) : null,
        lagPressure: (body?.['eventLoopLag'] as Record<string, unknown> | undefined)?.['pressure'] === true,
        lagConsecutiveHigh: typeof (body?.['eventLoopLag'] as Record<string, unknown> | undefined)?.['consecutiveHighReadings'] === 'number'
          ? ((body?.['eventLoopLag'] as Record<string, unknown>)['consecutiveHighReadings'] as number)
          : null,
        lagLastP99Ms: typeof (body?.['eventLoopLag'] as Record<string, unknown> | undefined)?.['lastP99Ms'] === 'number'
          ? ((body?.['eventLoopLag'] as Record<string, unknown>)['lastP99Ms'] as number)
          : null,
        lagTelemetryAvailable: (body?.['eventLoopLag'] as Record<string, unknown> | undefined)?.['telemetryAvailable'] === true,
        heapPressure: (body?.['heap'] as Record<string, unknown> | undefined)?.['pressure'] === true,
        heapProjectedBytes: typeof (body?.['heap'] as Record<string, unknown> | undefined)?.['projectedBytes'] === 'number'
          ? ((body?.['heap'] as Record<string, unknown>)['projectedBytes'] as number)
          : null,
        memCurrentBytes: typeof (body?.['memory'] as Record<string, unknown> | undefined)?.['currentBytes'] === 'number'
          ? ((body?.['memory'] as Record<string, unknown>)['currentBytes'] as number)
          : null,
        toolsMemCurrentBytes: typeof ((body?.['memory'] as Record<string, unknown> | undefined)?.['tools'] as Record<string, unknown> | undefined)?.['currentBytes'] === 'number'
          ? (((body?.['memory'] as Record<string, unknown>)['tools'] as Record<string, unknown>)['currentBytes'] as number)
          : null,
        retryAfterSeconds: typeof body?.['retryAfterSeconds'] === 'number' ? (body['retryAfterSeconds'] as number) : null,
      };
      appendFileSync(capacityPath, `${JSON.stringify(sample)}\n`);
    })().catch(() => undefined);
  }, 1000);
  timers.push(capacityTimer);

  const hostTimer = setInterval(() => {
    const memKb = readMemAvailableKbSafe();
    const cpu = readPressure('cpu');
    const mem = readPressure('memory');
    appendFileSync(hostPath, `${JSON.stringify({ atMs: Date.now(), memAvailableKb: memKb, cpuPsi: cpu, memPsi: mem })}\n`);
  }, 5000);
  timers.push(hostTimer);

  return { stop: () => timers.forEach((t) => clearInterval(t)) };
}

function readMemAvailableKbSafe(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface SpawnOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function runSpawn(spec: ChildSpec, conn: SocketConn, startedAtMs: number, tmpDir: string): Promise<{ record: CreateRecord; sessionId?: string }> {
  const argv = spawnArgv(spec, { piOrchBin: PI_ORCH_BIN, socketPath: conn.socketPath, tokenPath: conn.tokenPath });
  // pi-orch rejects arguments via argv (never shell), so long --message values are safe.
  const outPath = join(tmpDir, `spawn-${spec.name}.json`);
  const res = await runWithOutput(argv, outPath);
  const endedAtMs = Date.now();
  const wallMs = endedAtMs - startedAtMs;
  const sessionId = res.code === 0 ? res.stdout.trim().split('\n').pop()?.trim() : undefined;
  const errorCode = /^pi-orch: ([A-Z_0-9]+):/m.exec(res.stderr)?.[1];
  const retryAfterRaw = /retry-after: (\d+)s/m.exec(res.stderr)?.[1];
  const ok = res.code === 0 && sessionId !== undefined && sessionId.length > 0;
  return {
    sessionId: ok ? sessionId : undefined,
    record: {
      step: spec.name.startsWith('pass1') ? 'pass1' : spec.name.startsWith('pass2') ? 'pass2' : 'armb',
      index: Number(/(\d+)$/.exec(spec.name)?.[1] ?? -1),
      child: spec.name,
      startedAtMs,
      endedAtMs,
      wallMs,
      exitCode: res.code,
      ok,
      sessionId,
      errorCode,
      retryAfterSeconds: retryAfterRaw !== undefined ? Number(retryAfterRaw) : undefined,
      retried: deriveRetry({ exitCode: res.code, ok, wallMs }),
      stderrTail: res.stderr ? res.stderr.slice(-400) : undefined,
    },
  };
}

/** execFile with stdout/stderr also mirrored to a file (per-create evidence). */
async function runWithOutput(argv: string[], outPath: string): Promise<SpawnOutcome> {
  const res = await run(argv, 600_000);
  writeFileSync(outPath, `# argv: ${argv.join(' ')}\n# exit: ${String(res.code)}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`);
  return res;
}

export async function runArm(opts: ArmOptions): Promise<{ ok: boolean; summaryPath: string; error?: string }> {
  const t0 = Date.now();
  const { runRoot } = opts;
  for (const d of ['samples', 'fixtures', 'logs', 'creates']) mkdirSync(join(runRoot, d), { recursive: true });
  const log = (line: string): void => appendFileSync(join(runRoot, 'logs', 'driver.log'), `${new Date().toISOString()} ${line}\n`);

  // 1. Pre-flight (STRESS-GATE).
  const pf = await preflight({ requireGuard: true, minMemGiB: 12, minDiskGiB: 15 });
  writeFileSync(join(runRoot, 'preflight.json'), `${JSON.stringify(pf, null, 2)}\n`);
  if (!pf.ok) {
    log(`PREFLIGHT FAILED: ${pf.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}`);
    return { ok: false, summaryPath: '', error: 'preflight failed — see preflight.json' };
  }

  // 2. Stress lock (arms only; smoke runs without it).
  const lockOwner = `lane E2a-4 arm ${opts.mode} unit(s) e2a-4-* start ${new Date(t0).toISOString()}`;
  if (opts.takeStressLock) {
    const lock = takeLock(lockOwner);
    writeFileSync(join(runRoot, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    if (!lock.taken) {
      log(`LOCK HELD: ${lock.detail}`);
      return { ok: false, summaryPath: '', error: `stress lock held: ${lock.detail}` };
    }
  }

  let anchorStarted = false;
  let serverUnit: string | null = null;
  try {
    // 3. Production snapshot (read-only) → mirrored env.
    const snapshot = await readProductionSnapshot();
    writeFileSync(join(runRoot, 'production-settings.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

    const suffix = opts.mode;
    const anchorUnit = `e2a-4-tools-anchor.service`;
    const serverUnitName = `e2a-4-${suffix}-server`;
    serverUnit = serverUnitName;

    // 4. Isolated agent dir + fixtures.
    assertNotProductionAgentDir(join(runRoot, 'agent'));
    const agentDir = buildIsolatedAgentDir(join(runRoot, 'agent'));
    log(`agent dir built: extensions=${String(agentDir.copiedExtensions.length)} authProviders=${agentDir.providersInAuth.join(',')} manifest=${agentDir.sha256ManifestPath}`);

    const plan = buildArmAPlan({ passSize: opts.passSize, fixtureRoot: join(runRoot, 'fixtures'), owner: OWNER });
    const fixtureSpecs: FixtureSpec[] = [];
    for (const pass of opts.passes) {
      const specs = pass.step === 'pass1' ? plan.pass1 : plan.pass2;
      for (const spec of specs.slice(0, pass.size)) {
        fixtureSpecs.push({ dir: spec.cwd, taskText: `E2a-4 ${opts.mode} fixture for ${spec.name}\n`, worktreeLike: spec.worktreeLike === true });
      }
    }
    await materialiseFixtures(fixtureSpecs);

    // 5. Anchor unit (own tools root) + pre-boot resolution assertion.
    const anchorScriptPath = join(runRoot, 'anchor-start.sh');
    writeFileSync(anchorScriptPath, anchorStartScript());
    const anchorArgs = buildAnchorUnitArgs({ unit: anchorUnit, slice: LANE_SLICE, scriptPath: anchorScriptPath });
    const anchorStart = await run(anchorArgs, 30_000);
    if (anchorStart.code !== 0) throw new Error(`anchor start failed: ${anchorStart.stderr}`);
    anchorStarted = true;
    const anchorPid = await waitForMainPid(anchorUnit, 20_000);
    if (!anchorPid) throw new Error('anchor unit never reported a MainPID (start script failed — see journalctl -u e2a-4-tools-anchor.service)');
    const anchorCgroup = (await systemctlShow(anchorUnit, ['ControlGroup']))['ControlGroup'] ?? '';
    writeFileSync(join(runRoot, 'anchor-cgroup.txt'), `${anchorCgroup}\n`);
    if (!anchorCgroup.includes('e2a-4') || anchorCgroup.includes('pi-web-ui')) {
      throw new Error(`anchor resolved outside the lane: ${anchorCgroup}`);
    }
    log(`anchor live at ${anchorCgroup}`);

    // 6. Disposable server unit with the mirrored env + isolation env.
    const fakeHome = mkdtempSync(join(tmpdir(), 'e2a4-home-'));
    const isolationEnv: Record<string, string> = {
      PI_AGENT_DIR: agentDir.agentDir,
      PI_CODING_AGENT_DIR: agentDir.agentDir,
      HOME: fakeHome,
      AGENT_OS_BIN: join(WORKTREE_ROOT, 'scripts', 'heap-soak', 'agent-os-stub.mjs'),
      BOARD_STORE_DIR: join(runRoot, 'board'),
      AGENT_OS_VAULT_ROOT: join(runRoot, 'vault'),
      NOTIFICATIONS_DIR: join(runRoot, 'notifications'),
      NOTIFICATIONS_ENABLED: 'false',
      PI_WEB_UI_WATCH_WAKE_SOCKET: join(runRoot, 'server', 'internal-api.sock'),
      PI_WEB_UI_WATCH_WAKE_TOKEN_FILE: join(runRoot, 'server', 'internal-api-token'),
      PI_WEB_UI_GOAL_HOME: join(runRoot, 'goal-home'),
      PI_BG_TASKS_DIR: join(runRoot, 'bg-tasks'),
      PI_COMPACTION_LOG: join(runRoot, 'logs', 'compaction.log'),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    mkdirSync(join(runRoot, 'board'), { recursive: true });
    mkdirSync(join(runRoot, 'goal-home'), { recursive: true });
    mkdirSync(join(runRoot, 'bg-tasks'), { recursive: true });

    const env = mirrorServerEnv(snapshot, { anchorUnit, metricsIntervalMs: 1000, maxSessions: 40 });
    const httpPort = await findFreeTcpPort();
    const serverArgs = buildServerUnitArgs({
      unit: serverUnitName, slice: LANE_SLICE, worktreeRoot: WORKTREE_ROOT,
      validationDir: join(runRoot, 'server'), httpPort,
      memoryMax: opts.memoryMax, runtimeMaxSec: opts.serverRuntimeMaxSec,
      env, extraEnv: isolationEnv,
    });
    const serverStart = await run(serverArgs, 30_000);
    if (serverStart.code !== 0) throw new Error(`server start failed: ${serverStart.stderr}`);
    const mainPid = await waitForMainPid(serverUnitName, 40_000);
    if (!mainPid) throw new Error('server unit never reported a MainPID');
    log(`server unit ${serverUnitName} MainPID ${String(mainPid)} port ${String(httpPort)}`);

    const conn: SocketConn = { socketPath: join(runRoot, 'server', 'internal-api.sock'), tokenPath: join(runRoot, 'server', 'internal-api-token') };
    const readyDeadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      if (existsSync(conn.tokenPath) && existsSync(conn.socketPath)) {
        const cap = await getCapacity(conn);
        if (cap && cap['available'] === true && (cap['eventLoopLag'] as Record<string, unknown> | undefined)?.['telemetryAvailable'] === true) {
          ready = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error('server never became ready (token+socket+capacity with A2 telemetry)');

    // 7. Providers line: only the approved credential may be live.
    const providersLine = await journalGrep(serverUnitName, 'Available providers (with auth)', 15);
    writeFileSync(join(runRoot, 'providers-line.txt'), `${providersLine ?? '(line not found)'}\n`);
    if (!providersLine) throw new Error('providers line not found in server journal');
    const providers = providersLine
      .slice(providersLine.lastIndexOf(':') + 1)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const approved = ['zai'];
    const unapproved = providers.filter((p) => !approved.includes(p));
    if (providers.length === 0 || unapproved.length > 0) {
      throw new Error(`unapproved providers live on the disposable server: ${providers.join(', ')}`);
    }
    log(`providers OK: ${providers.join(',')}`);

    // 8. Samplers, then the fan-out passes.
    const samplers = startSamplers(runRoot, conn);
    const creates: CreateRecord[] = [];
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2a4-spawn-'));
    try {
      for (const pass of opts.passes) {
        const specs = (pass.step === 'pass1' ? plan.pass1 : plan.pass2).slice(0, pass.size);
        log(`PASS ${pass.step} start (${String(specs.length)} creates, parallel=${String(pass.parallel)})`);
        const passStart = Date.now();
        const outcomes: Array<{ record: CreateRecord; sessionId?: string }> = [];
        if (pass.parallel) {
          const results = await Promise.all(specs.map(async (spec) => {
            const startedAt = Date.now();
            try {
              return await runSpawn(spec, conn, startedAt, tmpDir);
            } catch (err) {
              return { record: { step: pass.step, index: Number(/(\d+)$/.exec(spec.name)?.[1] ?? -1), child: spec.name, startedAtMs: startedAt, endedAtMs: Date.now(), wallMs: Date.now() - startedAt, exitCode: -1, ok: false, retried: 'unknown' as const, stderrTail: String(err).slice(0, 400) }, sessionId: undefined };
            }
          }));
          outcomes.push(...results);
        } else {
          for (const spec of specs) {
            outcomes.push(await runSpawn(spec, conn, Date.now(), tmpDir));
          }
        }
        creates.push(...outcomes.map((o) => o.record));
        for (const o of outcomes) appendFileSync(join(runRoot, 'creates', `${o.record.child}.json`), `${JSON.stringify(o.record, null, 2)}\n`);
        log(`PASS ${pass.step} creates done in ${String(Date.now() - passStart)} ms (ok=${String(outcomes.filter((o) => o.record.ok).length)}/${String(outcomes.length)})`);

        // Tiny real task on every child, then bounded wait, then cleanup.
        const sessionIds = outcomes.flatMap((o) => (o.sessionId !== undefined ? [o.sessionId] : []));
        if (sessionIds.length > 0) {
          const promptResults = await Promise.all(outcomes.map(async (o) => {
            if (!o.sessionId) return null;
            const spec = specs.find((s) => s.name === o.record.child);
            if (spec?.goalObjective !== undefined) {
              // Goal-armed children are already running their goal turn (the
              // objective IS their task); a manual prompt would be refused
              // busy. The owner's real pattern dispatches nothing extra.
              appendFileSync(join(runRoot, 'creates', `${o.record.child}.prompt.json`), `${JSON.stringify({ skipped: 'goal-armed', atMs: Date.now() })}\n`);
              return null;
            }
            const argv = promptArgv(o.sessionId, spec?.taskText ?? 'Read task.txt and write its first line to result.txt, then end.', `e2a4-${opts.mode}-${o.record.child}`, { piOrchBin: PI_ORCH_BIN, socketPath: conn.socketPath, tokenPath: conn.tokenPath });
            const res = await run(argv, 120_000);
            appendFileSync(join(runRoot, 'creates', `${o.record.child}.prompt.json`), `${JSON.stringify({ exitCode: res.code, stdoutTail: res.stdout.slice(-200), stderrTail: res.stderr.slice(-300) })}\n`);
            return res;
          }));
          const promptOk = promptResults.filter((r) => r !== null && r.code === 0).length;
          const promptSkipped = promptResults.filter((r) => r === null).length;
          log(`PASS ${pass.step} prompts dispatched: ${String(promptOk)}/${String(sessionIds.length)} (goal-armed skipped: ${String(promptSkipped)})`);

          const wait = await run(waitAllArgv(sessionIds, opts.promptDeadlineS, { piOrchBin: PI_ORCH_BIN, socketPath: conn.socketPath, tokenPath: conn.tokenPath }), (opts.promptDeadlineS + 120) * 1000);
          writeFileSync(join(runRoot, 'logs', `wait-${pass.step}.txt`), `# exit ${String(wait.code)}\n${wait.stdout}\n${wait.stderr}\n`);
          log(`PASS ${pass.step} wait exit ${String(wait.code)}`);

          // Direct proof the tiny task ran: each child writes result.txt in its
          // own fixture dir (read one file, write one line, end).
          for (const spec of specs) {
            const resultPath = join(spec.cwd, 'result.txt');
            let content: string | null = null;
            try {
              content = readFileSync(resultPath, 'utf8').trim();
            } catch {
              content = null;
            }
            appendFileSync(join(runRoot, 'creates', `${spec.name}.task-result.json`), `${JSON.stringify({ atMs: Date.now(), resultTxtExists: content !== null, resultTxt: content })}\n`);
          }

          for (const sid of sessionIds) {
            let cleanup = await run(cleanupArgv(sid, { piOrchBin: PI_ORCH_BIN, socketPath: conn.socketPath, tokenPath: conn.tokenPath }, OWNER), 120_000);
            if (cleanup.code === 2) cleanup = await run(cleanupArgv(sid, { piOrchBin: PI_ORCH_BIN, socketPath: conn.socketPath, tokenPath: conn.tokenPath }), 120_000);
            appendFileSync(join(runRoot, 'logs', 'cleanup.log'), `${sid} exit ${String(cleanup.code)} ${cleanup.stderr.slice(0, 200)}\n`);
          }
          const remaining = await run(statusByOwnerArgv(OWNER, { piOrchBin: PI_ORCH_BIN, socketPath: conn.socketPath, tokenPath: conn.tokenPath }), 30_000);
          appendFileSync(join(runRoot, 'logs', 'status-after-cleanup.txt'), `${remaining.stdout}\n${remaining.stderr}\n`);
        }
      }
    } finally {
      samplers.stop();
      writeFileSync(join(runRoot, 'creates', '_all.json'), `${JSON.stringify(creates, null, 2)}\n`);
    }

    // 9. Teardown: server first, then anchor; token file removed (04:22Z hygiene).
    await stopUnit(serverUnitName);
    await stopUnit(anchorUnit);
    anchorStarted = false;
    serverUnit = null;
    try {
      rmSync(join(runRoot, 'server', 'internal-api-token'), { force: true });
    } catch {
      /* already gone */
    }
    log('units stopped; server token removed');

    // 10. A2 series + analysis.
    const metricsPath = join(runRoot, 'server', 'metrics', 'health-metrics.jsonl');
    let a2: A2Sample[] = [];
    if (existsSync(metricsPath)) {
      copyFileSync(metricsPath, join(runRoot, 'samples', 'health-metrics.jsonl'));
      a2 = parseA2Jsonl(readFileSync(join(runRoot, 'samples', 'health-metrics.jsonl'), 'utf8'));
    }
    const capacityFile = join(runRoot, 'samples', 'capacity.jsonl');
    const capacityLines: CapacitySample[] = existsSync(capacityFile)
      ? readFileSync(capacityFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CapacitySample)
      : [];
    const answer = analyseArmA({ creates, a2, capacity: capacityLines, window: { fromMs: t0, toMs: Date.now() }, cfg: {
      thresholdMs: snapshot.capacity?.lagThresholdMs ?? 300,
      recoveryMs: snapshot.capacity?.lagRecoveryMs ?? 150,
      sustainedReadings: snapshot.capacity?.lagSustainedReadings ?? 2,
    } });
    const summaryPath = join(runRoot, 'summary.json');
    writeFileSync(summaryPath, `${JSON.stringify({ mode: opts.mode, startedAtMs: t0, endedAtMs: Date.now(), preflight: pf, answer, a2Window: summariseA2(a2), build: { worktreeRoot: WORKTREE_ROOT } }, null, 2)}\n`);
    log(`DONE ok=${String(answer.gateLatched ? 'latched' : 'no-latch')} refused=${String(answer.refused.length)} latchRefused=${String(answer.latchRefusedOwnChildren)}`);
    return { ok: true, summaryPath };
  } catch (err) {
    log(`ERROR: ${String(err)}`);
    if (serverUnit) await stopUnit(serverUnit).catch(() => undefined);
    if (anchorStarted) await stopUnit('e2a-4-tools-anchor.service').catch(() => undefined);
    return { ok: false, summaryPath: '', error: String(err) };
  } finally {
    if (opts.takeStressLock) {
      const rel = releaseLock(lockOwner);
      log(`lock release: ${String(rel.released)} ${rel.detail}`);
    }
  }
}

async function readProductionSnapshot(): Promise<ProductionSettingsSnapshot> {
  const { code, stdout } = await run(['systemctl', 'show', 'pi-web-ui.service', '-p', 'Environment', '-p', 'MainPID', '--no-pager'], 15_000);
  if (code !== 0) throw new Error('cannot read production unit (read-only) — aborting');
  const mainPid = Number(/MainPID=(\d+)/.exec(stdout)?.[1] ?? 0);
  const envLine = stdout.split('\n').find((l) => l.startsWith('Environment=')) ?? '';
  const values = selectMirrorKeys(parseSystemctlEnvironment(envLine));
  const tokenPath = join(homedir(), '.pi-web-ui', 'internal-api-token');
  let capacity: ProductionSettingsSnapshot['capacity'] = null;
  try {
    const body = await getCapacity({ socketPath: join(homedir(), '.pi-web-ui', 'internal-api.sock'), tokenPath });
    if (body) capacity = capacitySettingsFromCapacity(body);
  } catch {
    // capacity snapshot stays null; mirror falls back to the B2 defaults
  }
  return { readAtMs: Date.now(), mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : null, source: 'unit-env + /capacity', values, capacity };
}
