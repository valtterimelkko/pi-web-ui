#!/usr/bin/env node
/**
 * E2a-5 arm 4 — REAL antigravity goal child meeting REAL provider errors
 * (hb5's contract re-proven without the mock; Hb5.md method, mock replaced).
 *
 * Route (proof subject, NOT a worker): antigravity runtime, selector exactly
 * `gpt-oss-120b-medium` asserted against a fresh GET /models?runtime=antigravity
 * read. ONE child only, ≤ 6 turns total:
 *   turns 1–(1|2)  positive control: small goal the real agy achieves
 *   turns n..n+2   error arm: goal whose verifyCommand never passes while the
 *                  unit that holds the agy process is network-blocked with
 *                  `systemctl set-property --runtime e2a-5-hb5 IPAddressDeny=any
 *                  IPAddressAllow=localhost` (real transport failures)
 *   expected: three consecutive error turns → paused / pausedReason:"error",
 *   runs:0, nothing dispatched on the pausing strike; after lifting the block,
 *   resume re-arms a fresh window (one more turn).
 *
 * Runs INSIDE transient unit e2a-5-hb5 (MemoryMax=12G, MemorySwapMax=1G).
 * Credentials: only what agy needs is copied into the fake HOME; every copy is
 * counted here and deleted by cleanup; /root/.gemini mtime sweep before/after
 * proves whether the real state dir was touched.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  parseArgs, now, readTrim, assertMemAvailable, bootServer, api, readBuildIdentity, GiB,
} from './lib.mjs';

const argv = parseArgs(process.argv.slice(2));
const WT = argv['worktree'];
const RUN_DIR = argv['run-dir'];
if (!WT || !RUN_DIR) { console.error('usage: node hb5-agy.mjs --worktree=<wt> --run-dir=<dir>'); process.exit(64); }
mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

const MODEL = 'gpt-oss-120b-medium';
const UNIT = argv['unit'] ?? 'e2a-5-hb5';
const FAKE_HOME = path.join(RUN_DIR, 'fake-home');
const AGY_REAL = path.join(RUN_DIR, 'agy-real-copy');
const GEMINI = '/root/.gemini';

const result = {
  proof: 'e2a5-hb5-real-agy',
  startedAt: now(),
  worktree: WT, runDir: RUN_DIR, unit: UNIT, modelSelector: MODEL,
  credentialCopies: [],
  positiveControl: {}, errorArm: {}, resumeArm: {},
  pass: false,
};
const out = (l) => { console.log(l); };
const finish = (code) => {
  result.finishedAt = now();
  writeFileSync(path.join(RUN_DIR, 'hb5-result.json'), JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000, ...opts });
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** Parent adjustment 3: size+mtime line for every file under a /root/.gemini/antigravity* path. */
function geminiAntigravitySnapshot() {
  return run('find', [GEMINI, '-maxdepth', '4', '-path', '*antigravity*', '-type', 'f', '-printf', '%s %T@ %p\n'], { timeoutMs: 30_000 }).stdout;
}

let server = null;
try {
  assertMemAvailable(12 * GiB);
  const selfCg = readFileSync('/proc/self/cgroup', 'utf8').trim();
  if (selfCg.includes('pi.slice') || selfCg.includes('pi-web-ui')) {
    console.error(`ABORT: running inside a production-shaped cgroup: ${selfCg}`); finish(1);
  }
  result.unitCgroup = selfCg.split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? null;

  // ── agy binary copy (the launcher's explicit-AGY_BINARY opt-in channel) ──
  cpSync('/root/.local/bin/agy', AGY_REAL);
  spawnSync('chmod', ['755', AGY_REAL]);
  result.agyBinaryCopy = AGY_REAL;
  result.agyVersion = run(AGY_REAL, ['--version'], { timeoutMs: 15_000 });

  // ── fake HOME + ONLY the credential files agy needs (counted) ────────────
  mkdirSync(path.join(FAKE_HOME, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
  const candidates = [
    ['oauth_creds.json', `${GEMINI}/oauth_creds.json`, path.join(FAKE_HOME, '.gemini', 'oauth_creds.json')],
    ['google_accounts.json', `${GEMINI}/google_accounts.json`, path.join(FAKE_HOME, '.gemini', 'google_accounts.json')],
    ['installation_id', `${GEMINI}/installation_id`, path.join(FAKE_HOME, '.gemini', 'installation_id')],
    ['projects.json', `${GEMINI}/projects.json`, path.join(FAKE_HOME, '.gemini', 'projects.json')],
    ['antigravity-oauth-token', `${GEMINI}/antigravity-cli/antigravity-oauth-token`, path.join(FAKE_HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')],
  ];
  for (const [name, src, dst] of candidates) {
    if (existsSync(src)) {
      cpSync(src, dst);
      spawnSync('chmod', ['600', dst]);
      result.credentialCopies.push(name);
    }
  }
  out(`credential copies staged: ${result.credentialCopies.length} (${result.credentialCopies.join(', ')})`);

  // mtime reference for the real-state sweep (bounded, depth 2).
  const refFile = path.join(RUN_DIR, 'gemini-mtime-ref');
  writeFileSync(refFile, String(Date.now()));
  result.geminiSweepBefore = run('find', [GEMINI, '-maxdepth', '2', '-newer', refFile], { timeoutMs: 20_000 }).stdout;

  // Parent adjustment 3: full size+mtime snapshot of /root/.gemini/antigravity*
  // before and after; ANY diff is a finding and fails the arm.
  const snapBefore = geminiAntigravitySnapshot();
  writeFileSync(path.join(RUN_DIR, 'gemini-antigravity-before.txt'), snapBefore);

  // cheapest auth probe: the models listing with the fake HOME (no model call).
  result.agyModelsWithFakeHome = run(AGY_REAL, ['models'], {
    env: { ...process.env, HOME: FAKE_HOME }, timeoutMs: 30_000,
  });

  // ── isolated minimal agent dir (no credentials; no pi sessions are used) ─
  const agentDir = path.join(RUN_DIR, 'agent-dir');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(FAKE_HOME, 'agent-os-vault'), { recursive: true });
  mkdirSync(path.join(RUN_DIR, 'board'), { recursive: true });

  result.build = readBuildIdentity(WT);
  if (!result.build?.revision) { console.error('ABORT: no build identity — build first'); finish(1); }

  const ws = path.join(RUN_DIR, 'workspace');
  mkdirSync(ws, { recursive: true });

  server = await bootServer({
    wt: WT,
    valDir: path.join(RUN_DIR, 'val'),
    env: {
      NODE_ENV: 'test',
      HOME: FAKE_HOME,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      AGY_BINARY: AGY_REAL,
      AGY_GOAL_SWEEP_MS: '1000',
      AGENT_OS_BIN: path.join(WT, 'scripts/heap-soak/agent-os-stub.mjs'),
      BOARD_STORE_DIR: path.join(RUN_DIR, 'board'),
      AGENT_OS_VAULT_ROOT: path.join(FAKE_HOME, 'agent-os-vault'),
      NOTIFICATIONS_ENABLED: 'false',
      OBSERVABILITY_HEALTH_ALERT_SINK: 'none',
    },
    logFile: path.join(RUN_DIR, 'server.log'),
    timeoutMs: 150_000,
  });
  result.server = { valDir: server.valDir, buildRevision: result.build.revision, startedAt: now() };

  // Parent adjustment 2: the pi service's provider line must NOT list zai
  // (arm 4 has no GLM child); the antigravity set is proven by the fresh
  // /models read below plus the counted credential copies.
  const provLine = readTrim(path.join(RUN_DIR, 'server.log'))?.split('\n').find((l) => l.includes('Available providers (with auth):'));
  const provList = provLine?.split('Available providers (with auth):')[1]?.trim() ?? null;
  result.availableProviders = { line: provLine ?? null, list: provList };
  if (provList && /\bzai\b/.test(provList)) {
    console.error(`ABORT: provider assertion failed — zai must not be available on the hb5 server, got: ${provList}`);
    finish(1);
  }
  out(`provider assertion ok: no zai on the hb5 server (list: ${provList ?? '(empty)'})`);
  const call = (method, apiPath, body, timeoutMs) =>
    api({ socketPath: server.socketPath, tokenPath: server.tokenPath, method, apiPath, body, timeoutMs });

  // ── health + fresh /models read + selector assertion ─────────────────────
  const health = JSON.parse((await call('GET', '/api/v1/health')).body);
  result.health = {
    contractVersion: health.contract?.contractVersion ?? null,
    antigravity: health.runtimes?.antigravity ?? null,
  };
  if (result.health.antigravity !== 'available') {
    console.error(`ABORT: antigravity not available on the disposable server: ${result.health.antigravity}`);
    finish(1);
  }
  const modelsRes = await call('GET', '/api/v1/models?runtime=antigravity');
  const modelsBody = JSON.parse(modelsRes.body);
  // route shape: { models: { pi: [...], antigravity: [{id, selector, ...}] } }
  const modelList = modelsBody.models?.antigravity ?? modelsBody.models ?? [];
  const ids = Array.isArray(modelList) ? modelList.map((m) => m.id ?? m) : [];
  result.modelsRead = { at: now(), count: ids.length, ids };
  if (!ids.includes(MODEL)) {
    console.error(`ABORT: selector ${MODEL} not in fresh /models read (${ids.join(', ')})`);
    finish(1);
  }
  out(`models fresh read: ${ids.length} antigravity models, selector ${MODEL} present`);

  // ── ONE child ─────────────────────────────────────────────────────────────
  const createRes = await call('POST', '/api/v1/sessions', { runtime: 'antigravity', cwd: ws, model: MODEL });
  if (createRes.status !== 201) { console.error(`ABORT: antigravity create failed ${createRes.status}: ${createRes.body.slice(0, 300)}`); finish(1); }
  const child = JSON.parse(createRes.body);
  result.child = { sessionId: child.sessionId, model: child.model, createdAt: now() };
  out(`child created: ${child.sessionId} model=${child.model}`);

  const goalUrl = `/api/v1/sessions/${child.sessionId}/goal`;
  const jsonl = path.join(server.valDir, 'antigravity-sessions', `${child.sessionId}.jsonl`);
  const turnCount = () => {
    try { return readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
  };
  const goalState = async () => {
    const r = await call('GET', goalUrl);
    try { return JSON.parse(r.body); } catch { return { raw: r.body.slice(0, 200) }; }
  };
  const waitTerminal = async (deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    let g = await goalState();
    while (Date.now() < deadline) {
      if (g.status && g.status !== 'running' && g.status !== 'armed') return g;
      await new Promise((r) => setTimeout(r, 2000));
      g = await goalState();
    }
    return g;
  };

  // ── positive control: small goal the real agy achieves ───────────────────
  {
    const doneFile = path.join(ws, 'a5-hb5-positive-done.txt');
    rmSync(doneFile, { force: true });
    const start = await call('POST', goalUrl, {
      action: 'start',
      objective: `Use bash to create the file ${doneFile} containing exactly DONE, then report the goal achieved.`,
      maxTurns: 3,
      verifyCommand: `test -f ${doneFile}`,
    });
    result.positiveControl.start = JSON.parse(start.body);
    if (!result.positiveControl.start.accepted) { console.error(`ABORT: positive control not accepted: ${start.body.slice(0, 300)}`); finish(1); }
    out('positive control goal started (real agy, real model turn)');
    result.positiveControl.final = await waitTerminal(300_000);
    result.positiveControl.turns = turnCount();
    out(`positive control: status=${result.positiveControl.final.status} runs=${result.positiveControl.final.runs} turns=${result.positiveControl.turns}`);
    if (result.positiveControl.final.status !== 'achieved') {
      result.positiveControl.note = 'positive control did not achieve — real agy behaviour recorded as-is';
    }
    // where does the agy process run? (record while it may still be alive; else record unit-level fact)
    const agyPids = run('pgrep', ['-f', AGY_REAL], { timeoutMs: 10_000 }).stdout.split('\n').filter(Boolean);
    result.agyCgroups = agyPids.map((pid) => {
      try { return { pid, cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim() }; } catch { return { pid, cgroup: 'exited' }; }
    });
    // clear before the error arm
    const clear = await call('POST', goalUrl, { action: 'clear' });
    result.positiveControl.clear = JSON.parse(clear.body);
  }

  // ── error arm: never-passing verify + real transport block ───────────────
  {
    const watch = await call('POST', `/api/v1/sessions/${child.sessionId}/watch`, {
      label: 'e2a5-hb5-paused-error',
      conditions: [{ id: 'paused-error', type: 'event_type', eventType: 'goal_state', dataMatch: { status: 'paused', pausedReason: 'error' }, once: true }],
    });
    result.errorArm.watch = JSON.parse(watch.body);

    const block = run('systemctl', ['set-property', '--runtime', UNIT, 'IPAddressDeny=any', 'IPAddressAllow=localhost'], { timeoutMs: 20_000 });
    result.errorArm.block = { ...block, appliedAt: now() };
    if (block.code !== 0) { console.error(`ABORT: IPAddressDeny block failed: ${block.stderr}`); finish(1); }
    const prop = run('systemctl', ['show', UNIT, '--property=IPAddressDeny,IPAddressAllow', '--value'], { timeoutMs: 10_000 });
    result.errorArm.blockReadback = prop.stdout;

    rmSync(path.join(ws, 'never-created-marker'), { force: true });
    const start = await call('POST', goalUrl, {
      action: 'start',
      objective: `Fetch http://example.com/e2a5-hb5-probe and write the response body into ${path.join(ws, 'probe-out.txt')}. Report the goal achieved only when the file exists and is non-empty.`,
      maxTurns: 6,
      verifyCommand: `test -s ${path.join(ws, 'probe-out.txt')}`,
    });
    result.errorArm.start = JSON.parse(start.body);
    if (!result.errorArm.start.accepted) { console.error(`ABORT: error-arm goal not accepted: ${start.body.slice(0, 300)}`); finish(1); }
    out('error arm goal started under the transport block (real agy must fail for real)');

    result.errorArm.final = await waitTerminal(420_000);
    result.errorArm.turns = turnCount();
    out(`error arm: status=${result.errorArm.final.status} pausedReason=${result.errorArm.final.pausedReason} runs=${result.errorArm.final.runs} turns=${result.errorArm.turns} lastReason=${String(result.errorArm.final.lastReason ?? '').slice(0, 200)}`);

    // settle: nothing dispatched on the pausing strike
    await new Promise((r) => setTimeout(r, 8000));
    result.errorArm.turnsAfterSettle = turnCount();
    result.errorArm.goalAfterSettle = await goalState();

    // the transcript: statuses + the REAL error strings
    try {
      const turns = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      result.errorArm.transcript = turns.map((t) => ({
        status: t.status, error: t.error ? String(t.error).slice(0, 300) : null,
        finishedAt: t.finishedAt ?? null,
      }));
    } catch { result.errorArm.transcript = 'transcript read failed'; }

    // watch firing?
    const wres = await call('GET', `/api/v1/sessions/${child.sessionId}/watch`);
    try { result.errorArm.watchFinal = JSON.parse(wres.body); } catch { result.errorArm.watchFinal = { raw: wres.body.slice(0, 300) }; }
  }

  // ── resume re-arms after the block lifts ─────────────────────────────────
  {
    const lift = run('systemctl', ['set-property', '--runtime', UNIT, 'IPAddressDeny='], { timeoutMs: 20_000 });
    result.resumeArm.lift = { ...lift, appliedAt: now() };
    result.resumeArm.propReadback = run('systemctl', ['show', UNIT, '--property=IPAddressDeny,IPAddressAllow', '--value'], { timeoutMs: 10_000 }).stdout;
    // real connectivity probe from inside the unit: proves the lift worked
    result.resumeArm.connectivityProbe = run('curl', ['-sI', '--max-time', '8', '-o', '/dev/null', '-w', '%{http_code}', 'http://example.com/'], { timeoutMs: 15_000 });
    const resume = await call('POST', goalUrl, { action: 'resume' });
    result.resumeArm.resume = JSON.parse(resume.body);
    out(`resume: accepted=${result.resumeArm.resume?.accepted} status=${result.resumeArm.resume?.goal?.status}`);
    // a fresh continuation is dispatched: the transcript grows by one turn
    const before = result.errorArm.turnsAfterSettle;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && turnCount() <= before) await new Promise((r) => setTimeout(r, 2000));
    result.resumeArm.turnsAfterResume = turnCount();
    result.resumeArm.dispatchedNewTurn = turnCount() > before;
    out(`resume arm: turns ${before} → ${turnCount()} (dispatched=${result.resumeArm.dispatchedNewTurn})`);
    const clear = await call('POST', goalUrl, { action: 'clear' });
    result.resumeArm.clear = JSON.parse(clear.body);
  }

  // ── verdicts ──────────────────────────────────────────────────────────────
  const ea = result.errorArm;
  result.verdicts = {
    positiveControlAchieved: result.positiveControl.final?.status === 'achieved',
    threeConsecutiveErrorTurns: Array.isArray(ea.transcript)
      && ea.transcript.slice(-3).every((t) => t.status === 'error'),
    pausedWithReasonError: ea.final?.status === 'paused' && ea.final?.pausedReason === 'error',
    runsZero: ea.final?.runs === 0,
    nothingDispatchedOnPausingStrike: ea.turnsAfterSettle === ea.turns,
    watchFired: (ea.watchFinal?.firingCount ?? 0) >= 1,
    resumeRearms: result.resumeArm.resume?.accepted === true
      && result.resumeArm.resume?.goal?.status === 'running'
      && result.resumeArm.dispatchedNewTurn === true,
    realErrorStringsRecorded: Array.isArray(ea.transcript) && ea.transcript.some((t) => t.error),
  };
  result.pass = Object.values(result.verdicts).every(Boolean);
  out(`verdicts: ${JSON.stringify(result.verdicts)}`);
} catch (e) {
  result.error = String(e && e.stack ? e.stack : e);
} finally {
  // ── cleanup ───────────────────────────────────────────────────────────────
  if (server) { try { await server.stop(); } catch { /* best effort */ } }
  // delete every credential copy (counted above), then verify none remain
  try { rmSync(FAKE_HOME, { recursive: true, force: true }); } catch { /* recorded below */ }
  const findCopies = run('find', [RUN_DIR, '-name', 'auth.json', '-o', '-name', 'oauth_creds.json', '-o', '-name', 'antigravity-oauth-token'], { timeoutMs: 20_000 });
  result.credentialCopySweep = { command: `find ${RUN_DIR} -name auth.json -o -name oauth_creds.json -o -name antigravity-oauth-token`, stdout: findCopies.stdout, remaining: findCopies.stdout.split('\n').filter(Boolean).length };
  result.geminiSweepAfter = run('find', [GEMINI, '-maxdepth', '2', '-newer', path.join(RUN_DIR, 'gemini-mtime-ref')], { timeoutMs: 20_000 }).stdout;
  result.geminiRealStateTouched = result.geminiSweepAfter.split('\n').filter(Boolean).length > 0;
  // antigravity* diff (sizes + mtimes, sorted): identical → no real-state writes
  const snapAfter = geminiAntigravitySnapshot();
  writeFileSync(path.join(RUN_DIR, 'gemini-antigravity-after.txt'), snapAfter);
  const diff = run('diff', [path.join(RUN_DIR, 'gemini-antigravity-before.txt'), path.join(RUN_DIR, 'gemini-antigravity-after.txt')], { timeoutMs: 20_000 });
  result.geminiAntigravityDiff = { exitCode: diff.code, output: (diff.stdout + '\n' + diff.stderr).slice(0, 4000), identical: diff.code === 0 };
  result.geminiRealStateTouched = result.geminiRealStateTouched || diff.code !== 0;
  finish(result.pass && !result.geminiRealStateTouched ? 0 : 2);
}
