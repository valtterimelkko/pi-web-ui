#!/usr/bin/env node
/**
 * Live validation: parent adopt-native end-to-end across Claude Code,
 * Antigravity, and Command Code (contract 1.40.0 adoption + runtime
 * continuation + browser child surfacing).
 *
 * Self-contained: boots the repo's own disposable validation server
 * (scripts/validation-server.ts) with
 *   - `--command-code-fixture`            → hermetic deterministic cmdc CLI
 *   - AGY_BINARY=scripts/agy-stub.mjs     → stub-only antigravity opt-in
 *   - hermetic native roots               → ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR
 *                                            and COMMAND_CODE_CLI_HOME_DIR point
 *                                            inside the validation directory
 *   - CLAUDE_CONFIG_DIR (server default)  → <dir>/claude-config, seeded with a
 *       settings.json env block (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN from
 *       the operator's GLM_CODING_PLAN_TOKEN) so the adopted Claude child's
 *       native `claude --resume` turn can authenticate via the same
 *       Anthropic-compatible GLM endpoint the claude profiles use. The token
 *       is copied only into the 0700 temp dir and never logged.
 *
 * Phases:
 *   1. capabilities advertises contract 1.40.0
 *   2. real pi parent created and prompted (parent runtime works)
 *   3. real native session artifacts written on disk for claude / antigravity /
 *      commandcode in the isolated stores
 *   4. POST /sessions/adopt-native links each under the parent; registry
 *      records carry parentSessionId, source 'native-discovered', runtime ids
 *   5. each adopted child is prompted via POST /sessions/:id/prompt and
 *      completes a real turn (fixture, stub, and real GLM-backed claude CLI);
 *      run receipts complete; child status transitions observed; parent's
 *      broker key receives child_dispatched AND child_turn_ended per child
 *   6. Playwright: the parent's chat view shows the live child in
 *      [data-testid="children-strip"] (label + status) when a child card is
 *      dispatched while the browser watches
 *   7. teardown: sessions deleted, server stopped, temp dir removed
 *
 * Usage:
 *   node scripts/live-validate-parent-child-e2e.mjs [--port 3588] [--keep]
 *        [--model zai/glm-5.3-flash] [--env-file .env.production]
 *        [--skip-browser]
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import process from 'node:process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(arg('port', '3588'));
const MODEL = arg('model', 'zai/glm-5.3-flash');
const ENV_FILE = arg('env-file', path.join(REPO, '.env.production'));
const GLM_BASE_URL = arg('glm-base-url', 'https://api.z.ai/api/anthropic');
const KEEP = hasFlag('keep');
const SKIP_BROWSER = hasFlag('skip-browser');
const PASSWORD = `pc-e2e-${crypto.randomBytes(9).toString('base64url')}`;
const RUN_TAG = `pce2e-${Date.now().toString(36)}`;

const results = [];
let failed = 0;
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${step}${detail ? ` :: ${detail}` : ''}`);
}
function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

// ── HTTP over the Internal API unix socket ──────────────────────────────────
let SOCKET = '';
let TOKEN = '';

function socketRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/api/v1${urlPath}`,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(300_000, () => req.destroy(new Error('socket request timeout')));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpRequest(port, method, urlPath, body, cookie, csrfToken) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(cookie && method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json, raw, setCookie: res.headers['set-cookie'] });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReadiness(deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const health = await socketRequest('GET', '/health');
      if (health.status === 200 && health.json?.status === 'ok') return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

/** Parse one KEY=VALUE from a dotenv-style env file (never logging values). */
function readEnvKey(filePath, key) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return undefined; }
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && m[1] === key) {
      return m[2].replace(/^["']|["']$/g, '').trim() || undefined;
    }
  }
  return undefined;
}

async function pickFreePort(preferred) {
  const tryBind = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
  if (await tryBind(preferred)) return preferred;
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── Native artifact writers (isolated stores) ───────────────────────────────
function claudeLine(entry) {
  return JSON.stringify(entry);
}

async function writeClaudeArtifact(claudeConfigDir, cwd, marker) {
  const nativeId = crypto.randomUUID();
  const encoded = `-${cwd.split('/').filter(Boolean).join('-')}`;
  const projDir = path.join(claudeConfigDir, 'projects', encoded);
  await fsp.mkdir(projDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const userUuid = crypto.randomUUID();
  const assistantUuid = crypto.randomUUID();
  const lines = [
    claudeLine({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `${marker} first native turn` },
      uuid: userUuid, timestamp: now, userType: 'external', cwd,
      sessionId: nativeId, version: '2.1.263', gitBranch: 'HEAD',
    }),
    claudeLine({
      parentUuid: userUuid, isSidechain: false, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `${marker} acknowledged` }] },
      uuid: assistantUuid, timestamp: now, userType: 'external', cwd,
      sessionId: nativeId, version: '2.1.263', gitBranch: 'HEAD',
    }),
  ];
  const filePath = path.join(projDir, `${nativeId}.jsonl`);
  await fsp.writeFile(filePath, lines.join('\n') + '\n', { mode: 0o600 });
  return { nativeId, filePath };
}

async function writeAntigravityArtifact(conversationsDir, marker) {
  const nativeId = crypto.randomUUID();
  await fsp.mkdir(conversationsDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(conversationsDir, `${nativeId}.db`);
  await fsp.writeFile(dbPath, '', { mode: 0o600 });
  // brain transcript lives one level up from conversations: <root>/brain/<id>/…
  const brainDir = path.join(path.dirname(conversationsDir), 'brain', nativeId, '.system_generated', 'logs');
  await fsp.mkdir(brainDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: 'USER_INPUT', content: `<USER_REQUEST>\n${marker} first native turn\n</USER_REQUEST>`, timestamp: now }),
    JSON.stringify({ type: 'ASSISTANT_RESPONSE', content: `${marker} acknowledged`, timestamp: now }),
  ];
  await fsp.writeFile(path.join(brainDir, 'transcript.jsonl'), lines.join('\n') + '\n', { mode: 0o600 });
  return { nativeId, dbPath };
}

async function writeCommandCodeArtifact(cliHomeDir, cwd, marker) {
  const nativeId = crypto.randomUUID();
  const encoded = cwd.split('/').filter(Boolean).join('-');
  const projDir = path.join(cliHomeDir, 'projects', encoded);
  await fsp.mkdir(projDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: 'message', id: crypto.randomUUID(), message: { role: 'user', content: `${marker} first native turn` }, timestamp: now }),
    JSON.stringify({ type: 'message', id: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: `${marker} acknowledged` }] }, timestamp: now }),
  ];
  const filePath = path.join(projDir, `${nativeId}.jsonl`);
  await fsp.writeFile(filePath, lines.join('\n') + '\n', { mode: 0o600 });
  return { nativeId, filePath };
}

// ── Bounded poll helper ─────────────────────────────────────────────────────
async function pollUntil(fn, { timeoutMs, intervalMs = 500, describe }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.ok) return last;
    await sleep(intervalMs);
  }
  return { ok: false, detail: `${describe}: timed out after ${timeoutMs}ms (last: ${last?.detail ?? 'n/a'})` };
}

async function main() {
  if (process.platform !== 'linux') {
    console.error('This validator relies on unix-socket Internal API access (linux only).');
    process.exit(1);
  }

  const port = await pickFreePort(PORT);
  const validationDir = path.join(fs.realpathSync('/tmp'), `pi-web-ui-parent-child-e2e-${RUN_TAG}`);
  const workspace = path.join(validationDir, 'workspace');
  for (const dir of [validationDir, workspace]) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  // GLM endpoint credentials for the adopted Claude child's native turn. The
  // token is copied only into the 0700 temp validation dir and never logged.
  const glmToken = readEnvKey(ENV_FILE, 'GLM_CODING_PLAN_TOKEN');
  const claudeConfigDir = path.join(validationDir, 'claude-config');
  await fsp.mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
  if (glmToken) {
    await fsp.writeFile(
      path.join(claudeConfigDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: GLM_BASE_URL, ANTHROPIC_AUTH_TOKEN: glmToken } }, null, 2),
      { mode: 0o600 },
    );
    // Fresh config dir: seed the CLI's onboarding marker so headless resume
    // does not stop on a first-run dialog.
    await fsp.writeFile(
      path.join(claudeConfigDir, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
      { mode: 0o600 },
    );
  } else {
    log('WARNING: GLM_CODING_PLAN_TOKEN not found in', ENV_FILE, '— the claude child turn will likely fail auth');
  }

  // Disposable bcrypt hash for the disposable server's AUTH_PASSWORD.
  const requireFromRepo = createRequire(path.join(REPO, 'package.json'));
  const bcrypt = requireFromRepo('bcrypt');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const agyStub = path.join(REPO, 'scripts', 'agy-stub.mjs');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: `http://localhost:${port}`,
    AUTH_PASSWORD: passwordHash,
    JWT_SECRET: `pc-e2e-${crypto.randomBytes(16).toString('hex')}`,
    AGY_BINARY: agyStub,
    AGY_STUB_SCENARIO: 'tools',
    ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR: path.join(validationDir, 'agy-native', 'conversations'),
    COMMAND_CODE_CLI_HOME_DIR: path.join(validationDir, 'cmdc-cli-home'),
    // Hermetic Command Code workspace policy: an operator-provided root wins
    // over the validation dir by design, so pin it explicitly — otherwise an
    // ambient COMMAND_CODE_ALLOWED_CWD_ROOTS (e.g. '/root') makes adopted
    // children with tmpdir workspaces inaccessible to the runtime policy.
    COMMAND_CODE_ALLOWED_CWD_ROOTS: validationDir,
  };
  delete env.ANTIGRAVITY_ENABLED; // stub opt-in path decides

  log(`starting disposable validation server on port ${port} (dir: ${validationDir})`);
  const serverLog = path.join('/tmp', `pc-e2e-server-${RUN_TAG}.log`);
  const logStream = fs.openSync(serverLog, 'a');
  const wrapper = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(REPO, 'scripts', 'validation-server.ts'),
      '--dir', validationDir, '--port', String(port), '--command-code-fixture',
      '--env-file', ENV_FILE, '--env-key', 'GLM_CODING_PLAN_TOKEN'],
    { cwd: REPO, env, stdio: ['ignore', logStream, logStream], detached: true },
  );
  fs.closeSync(logStream);

  async function stopServer() {
    const stop = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'validation-server-stop.mjs'),
      '--dir', validationDir, '--timeout-ms', '15000',
    ], { stdio: 'inherit' });
    if (wrapper.pid) {
      try { process.kill(-wrapper.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    log(`server stop requested (stopper exit ${stop.status})`);
  }

  SOCKET = path.join(validationDir, 'internal-api.sock');
  const tokenPath = path.join(validationDir, 'internal-api-token');
  const startedAt = Date.now();
  let tokensReady = false;
  while (Date.now() - startedAt < 60_000) {
    if (fs.existsSync(tokenPath) && fs.existsSync(SOCKET)) { tokensReady = true; break; }
    await sleep(300);
  }
  if (!tokensReady) {
    console.error(`server did not produce socket/token within 60s — see ${serverLog}`);
    await stopServer();
    process.exit(1);
  }
  TOKEN = fs.readFileSync(tokenPath, 'utf-8').trim();

  const childIds = {};
  let parentId;
  try {
    if (!(await waitForReadiness())) {
      record('validation server readiness', false, `see ${serverLog}`);
      throw new Error('server never became ready');
    }
    record('validation server readiness', true, `port ${port}, socket ${SOCKET}`);

    // ── Phase 1: contract ───────────────────────────────────────────────────
    const caps = await socketRequest('GET', '/capabilities');
    record('capabilities.contract.contractVersion==1.40.0',
      caps.json?.contract?.contractVersion === '1.40.0', caps.json?.contract?.contractVersion);
    const runtimes = caps.json?.runtimes ?? {};
    record('disposable runtimes enabled (claude, antigravity stub, commandcode fixture)',
      runtimes?.claude?.available === true && runtimes?.antigravity?.available === true && runtimes?.commandcode?.available === true,
      JSON.stringify(Object.fromEntries(Object.entries(runtimes).map(([k, v]) => [k, { available: v.available, enabled: v.enabled }]))));

    // ── Phase 2: real pi parent ─────────────────────────────────────────────
    const parentRes = await socketRequest('POST', '/sessions', { runtime: 'pi', cwd: workspace, model: MODEL });
    parentId = parentRes.json?.sessionId;
    record('create pi parent session', Boolean(parentId), `parent=${parentId} status=${parentRes.status}`);
    if (!parentId) throw new Error('cannot continue without parent');

    const parentDetail = await socketRequest('GET', `/sessions/${parentId}`);
    const parentPath = parentDetail.json?.sessionPath;
    record('parent detail exposes sessionPath', Boolean(parentPath), `path=${parentPath}`);

    const parentPrompt = await socketRequest('POST', `/sessions/${parentId}/prompt`, { message: 'Reply with exactly: PC-E2E-PARENT-ALIVE' });
    record('parent pi turn completes', parentPrompt.status === 200 && parentPrompt.json?.turnComplete === true
      && String(parentPrompt.json?.content ?? '').length > 0,
      `status=${parentPrompt.status} chars=${String(parentPrompt.json?.content ?? '').length}`);

    // ── Phase 3: real native artifacts on isolated stores ──────────────────
    const marker = `PC-E2E-${RUN_TAG.toUpperCase()}`;
    const claudeCwd = `/tmp/${RUN_TAG}-claude`;
    await fsp.mkdir(claudeCwd, { recursive: true, mode: 0o700 });
    const claudeArt = await writeClaudeArtifact(claudeConfigDir, claudeCwd, marker);
    const agyArt = await writeAntigravityArtifact(path.join(validationDir, 'agy-native', 'conversations'), marker);
    const cmdcArt = await writeCommandCodeArtifact(path.join(validationDir, 'cmdc-cli-home'), workspace, marker);
    record('native artifacts written (claude jsonl, agy db+brain transcript, cmdc jsonl)',
      fs.existsSync(claudeArt.filePath) && fs.existsSync(agyArt.dbPath) && fs.existsSync(cmdcArt.filePath),
      `claude=${claudeArt.nativeId.slice(0, 8)} agy=${agyArt.nativeId.slice(0, 8)} cmdc=${cmdcArt.nativeId.slice(0, 8)}`);

    // ── Phase 4: adopt-native all three under the parent ───────────────────
    const adoptions = [
      { key: 'claude', body: { runtime: 'claude', nativeId: claudeArt.nativeId, cwd: claudeCwd }, art: claudeArt },
      { key: 'antigravity', body: { runtime: 'antigravity', nativeId: agyArt.nativeId, cwd: workspace }, art: agyArt },
      { key: 'commandcode', body: { runtime: 'commandcode', nativeId: cmdcArt.nativeId, cwd: workspace }, art: cmdcArt },
    ];
    for (const a of adoptions) {
      const expectedNativePath = a.art.filePath ?? a.art.dbPath;
      const res = await socketRequest('POST', '/sessions/adopt-native', {
        ...a.body, parentSessionId: parentId, alias: `pc-e2e-${a.key}-child`, role: 'live-validation-child',
      });
      const ok = res.status === 200 && res.json?.adopted === 'created' && res.json?.parentSessionId === parentId
        && res.json?.runtime === a.key
        && res.json?.nativePath === expectedNativePath;
      record(`adopt-native(${a.key}) → created + linked`, ok, JSON.stringify(res.json)?.slice(0, 200));
      if (ok) childIds[a.key] = res.json.sessionId;
    }
    record('all three children adopted', Object.keys(childIds).length === 3, JSON.stringify(childIds));

    // Registry linkage per runtime. The public surface splits the projection:
    // GET /sessions (list) carries `source`; GET /sessions/:id (detail) carries
    // parentSessionId + the native artifact path. The Command Code child detail
    // only exists once a runtime store record is bound (first prompt), so its
    // pre-prompt linkage is asserted via the adopt response, and its runtime id
    // via the evidence endpoint after the turn.
    for (const key of ['claude', 'antigravity']) {
      const a = adoptions.find((x) => x.key === key);
      const id = childIds[key];
      if (!a || !id) continue;
      const list = await socketRequest('GET', `/sessions?runtime=${key}&limit=200`);
      const entry = list.json?.sessions?.find((s) => s.sessionId === id);
      const detail = await socketRequest('GET', `/sessions/${id}`);
      const expectedNativePath = a.art.filePath ?? a.art.dbPath;
      const ok = entry?.source === 'native-discovered'
        && detail.json?.parentSessionId === parentId
        && detail.json?.sessionPath === expectedNativePath;
      record(`registry linkage(${key}): source + parentSessionId + native artifact path`, Boolean(ok),
        `source=${entry?.source} parent=${detail.json?.parentSessionId} path=${detail.json?.sessionPath}`);
    }
    // (For Command Code the pre-prompt registry linkage is asserted by the
    // adopt-native response above — parentSessionId, runtime and the native
    // artifact path — because the public detail/list surfaces project Command
    // Code children from the runtime store, which binds on first prompt. The
    // post-turn evidence check below then proves the bound runtime id.)

    // ── Phase 5: prompt each adopted child and verify real turns ────────────
    // 5a. Command Code (deterministic fixture CLI, resumes the bound native id).
    const cmdcId = childIds.commandcode;
    const cmdcPrompt = await socketRequest('POST', `/sessions/${cmdcId}/prompt`, { message: `${marker} CMD-CHILD turn` });
    record('prompt(cmdc child) completes via fixture CLI', cmdcPrompt.status === 200 && cmdcPrompt.json?.turnComplete === true
      && String(cmdcPrompt.json?.content ?? '').includes('COMMAND-CODE-LIVE-OK'),
      `status=${cmdcPrompt.status} content=${JSON.stringify(String(cmdcPrompt.json?.content ?? '').slice(0, 80))}`);
    if (cmdcPrompt.json?.runId) {
      const receipt = await socketRequest('GET', `/runs/${cmdcPrompt.json.runId}`);
      record('cmdc run receipt terminal=completed', receipt.json?.status === 'completed'
        && receipt.json?.sessionId === cmdcId, `status=${receipt.json?.status}`);
    }
    {
      // After the first prompt the store record is bound: the evidence surface
      // resolves and carries the runtime-native session id (the drift guard
      // passing above already proves the resume targeted the bound id).
      const evidence = await socketRequest('GET', `/sessions/${cmdcId}/evidence`);
      record('cmdc child evidence resolves with runtime native id', evidence.status === 200
        && evidence.json?.aliases?.commandCodeNativeSessionId === cmdcArt.nativeId,
        `status=${evidence.status} nativeId=${String(evidence.json?.aliases?.commandCodeNativeSessionId).slice(0, 8)}`);
    }

    // 5b. Antigravity (agy stub, continues the adopted conversation id).
    const agyId = childIds.antigravity;
    const agyPrompt = await socketRequest('POST', `/sessions/${agyId}/prompt`, { message: `${marker} AGY-CHILD turn` });
    record('prompt(agy child) completes via stub conversation continuation', agyPrompt.status === 200 && agyPrompt.json?.turnComplete === true
      && String(agyPrompt.json?.content ?? '').includes('All tests passed.'),
      `status=${agyPrompt.status} content=${JSON.stringify(String(agyPrompt.json?.content ?? '').slice(0, 80))}`);
    if (agyPrompt.json?.runId) {
      const receipt = await socketRequest('GET', `/runs/${agyPrompt.json.runId}`);
      record('agy run receipt terminal=completed', receipt.json?.status === 'completed'
        && receipt.json?.sessionId === agyId, `status=${receipt.json?.status}`);
    }

    // 5c. Claude (REAL native `claude --resume` turn against the GLM endpoint).
    // Detached so the child's registry status transition (idle→running→idle)
    // is observable while the turn runs.
    const claudeId = childIds.claude;
    const sizeBefore = (await fsp.stat(claudeArt.filePath)).size;
    const claudeDispatch = await socketRequest('POST', `/sessions/${claudeId}/prompt`, {
      message: `${marker} CLAUDE-CHILD turn. Reply with exactly: PC-E2E-CLAUDE-CHILD-OK`, detach: true,
    });
    record('dispatch detached prompt(claude child) → 202 accepted', claudeDispatch.status === 202 && Boolean(claudeDispatch.json?.runId),
      `status=${claudeDispatch.status} runId=${claudeDispatch.json?.runId}`);
    const claudeRunId = claudeDispatch.json?.runId;

    const runningObserved = await pollUntil(async () => {
      const d = await socketRequest('GET', `/sessions/${claudeId}`);
      return { ok: d.json?.status === 'running', detail: `status=${d.json?.status}` };
    }, { timeoutMs: 20_000, describe: 'claude child status=running' });
    record('claude child registry status transitions idle→running', runningObserved.ok, runningObserved.detail);

    const claudeSettled = await pollUntil(async () => {
      const receipt = claudeRunId ? await socketRequest('GET', `/runs/${claudeRunId}`) : null;
      return { ok: receipt?.json?.status === 'completed', detail: `receipt=${receipt?.json?.status}` };
    }, { timeoutMs: 240_000, describe: 'claude child receipt completes' });
    record('claude child turn completes (run receipt terminal=completed)', claudeSettled.ok, claudeSettled.detail);

    const claudeIdle = await pollUntil(async () => {
      const detail = await socketRequest('GET', `/sessions/${claudeId}`);
      return { ok: detail.json?.status === 'idle', detail: `status=${detail.json?.status}` };
    }, { timeoutMs: 30_000, describe: 'claude child status returns to idle' });
    record('claude child registry status transitions running→idle', claudeIdle.ok, claudeIdle.detail);

    const sizeAfter = (await fsp.stat(claudeArt.filePath)).size;
    record('claude native artifact grew (real CLI resumed the adopted session)', sizeAfter > sizeBefore,
      `bytes ${sizeBefore}→${sizeAfter}`);
    if (claudeRunId) {
      const receipt = await socketRequest('GET', `/runs/${claudeRunId}`);
      const evidence = receipt.json?.outputEvidence ?? {};
      record('claude run receipt carries output evidence', receipt.json?.status === 'completed'
        && (evidence.assistantTextChars ?? 0) > 0, `chars=${evidence.assistantTextChars} disposition=${evidence.disposition}`);
    }

    // 5d. Parent's broker key carries the full orchestration sequence.
    const parentEvents = await pollUntil(async () => {
      const evts = await socketRequest('GET', `/sessions/${parentId}/events?mode=snapshot`);
      const list = evts.json?.events ?? [];
      const dispatchedBy = {};
      const endedBy = {};
      for (const e of list) {
        const childId = e.data?.child?.childSessionId ?? e.data?.child?.id;
        if (e.type === 'child_dispatched' && childId) dispatchedBy[childId] = (dispatchedBy[childId] ?? 0) + 1;
        if (e.type === 'child_turn_ended' && childId) endedBy[childId] = (endedBy[childId] ?? 0) + 1;
      }
      const allDispatched = Object.values(childIds).every((id) => (dispatchedBy[id] ?? 0) >= 1);
      const allEnded = Object.values(childIds).every((id) => (endedBy[id] ?? 0) >= 1);
      return { ok: allDispatched && allEnded, detail: `events=${list.length} dispatched=${JSON.stringify(dispatchedBy)} ended=${JSON.stringify(endedBy)}` };
    }, { timeoutMs: 30_000, describe: 'parent events sequence' });
    record("parent broker key has child_dispatched + child_turn_ended for all 3 children", parentEvents.ok, parentEvents.detail);

    // ── Phase 6: browser — ChildrenStrip on the parent's chat view ──────────
    if (!SKIP_BROWSER) {
      const requirePlaywright = createRequire(path.join(REPO, 'package.json'));
      const { chromium } = requirePlaywright('@playwright/test');
      // Name the parent so the browser test can find it deterministically.
      const login = await httpRequest(port, 'POST', '/api/auth/login', { password: PASSWORD });
      const cookie = login.setCookie?.[0]?.split(';')[0];
      const csrf = login.json?.csrfToken;
      record('browser HTTP login', login.status === 200 && Boolean(cookie) && Boolean(csrf), `status=${login.status}`);
      if (cookie && csrf && parentPath) {
        const rename = await httpRequest(port, 'POST', '/api/preferences/display-name',
          { sessionPath: parentPath, name: 'PC-E2E-PARENT', updatedAt: Date.now() }, cookie, csrf);
        record('parent display name set', rename.status === 200 || rename.status === 201, `status=${rename.status}`);

        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
          const page = await context.newPage();
          await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
          const pwInput = page.locator('input[type="password"]');
          if (await pwInput.isVisible().catch(() => false)) {
            await pwInput.fill(PASSWORD);
            await page.locator('button[type="submit"]').click();
          }
          await page.waitForSelector('[data-testid="session-sidebar"]', { timeout: 30_000 });
          record('browser login + sidebar visible', true, `url=${page.url()}`);

          let clicked = false;
          let sidebarDump = '';
          try {
            const item = page.getByRole('listitem', { name: /PC-E2E-PARENT/ }).first();
            await item.waitFor({ state: 'visible', timeout: 15_000 });
            await item.click();
            clicked = true;
          } catch (clickErr) {
            sidebarDump = await page.locator('[data-testid="session-sidebar"]').innerText().catch(() => '<sidebar unreadable>');
            try {
              await page.locator('text=PC-E2E-PARENT').first().click({ timeout: 10_000 });
              clicked = true;
              log('clicked via text fallback');
            } catch {
              log('listitem click failed:', clickErr instanceof Error ? clickErr.message.slice(0, 200) : String(clickErr));
            }
          }
          record('parent session opened in chat view', clicked, sidebarDump ? `sidebar: ${JSON.stringify(sidebarDump.slice(0, 300))}` : '');
          // Re-adopting the agy child while the browser watches broadcasts a
          // fresh child_dispatched card — the same surfacing path a live
          // dispatch uses — so the strip must appear on the parent's view.
          const readopt = await socketRequest('POST', '/sessions/adopt-native', {
            runtime: 'antigravity', nativeId: agyArt.nativeId, cwd: workspace,
            parentSessionId: parentId, alias: 'pc-e2e-agy-child', role: 'live-validation-child',
          });
          record('re-adopt (existing) while browser watches → child card re-broadcast',
            readopt.status === 200 && readopt.json?.adopted === 'existing' && readopt.json?.sessionId === agyId,
            `adopted=${readopt.json?.adopted}`);

          const strip = page.locator('[data-testid="children-strip"]');
          await strip.waitFor({ state: 'visible', timeout: 20_000 });
          const stripText = await strip.innerText();
          record("parent chat view renders [data-testid='children-strip']", true, JSON.stringify(stripText.slice(0, 160)));
          record('children-strip shows child label + dispatched status',
            stripText.includes('1 child running') && stripText.includes('pc-e2e-agy-child')
            && stripText.includes('dispatched via API') && stripText.includes('antigravity'),
            JSON.stringify(stripText.slice(0, 200)));
          await page.screenshot({ path: path.join(validationDir, 'children-strip.png'), fullPage: false });
          log('screenshot saved:', path.join(validationDir, 'children-strip.png'));
          await context.close();
        } finally {
          await browser.close();
        }
      }
    }
  } catch (err) {
    failed += 1;
    console.error('validation crashed:', err);
  } finally {
    // ── Phase 7: teardown ───────────────────────────────────────────────────
    try {
      for (const id of [...Object.values(childIds), ...(typeof parentId === 'string' ? [parentId] : [])]) {
        const del = await socketRequest('DELETE', `/sessions/${id}`);
        log('cleanup delete', id, `status=${del.status}`);
      }
    } catch { /* best effort */ }
    await stopServer();
    if (!KEEP) {
      await fsp.rm(validationDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(`/tmp/${RUN_TAG}-claude`, { recursive: true, force: true }).catch(() => undefined);
    } else {
      log(`--keep: preserving ${validationDir}`);
    }
  }

  console.log('\n=== Parent-child adoption E2E summary ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.step}${r.detail ? ` :: ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('validation crashed:', err);
  process.exit(1);
});
