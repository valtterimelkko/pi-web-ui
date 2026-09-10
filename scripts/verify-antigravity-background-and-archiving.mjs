#!/usr/bin/env node
/**
 * End-to-end live validation for the Antigravity background-task surfacing &
 * archive robustness plan (docs/plans/ANTIGRAVITY-BACKGROUND-TASKS-AND-
 * ARCHIVE-ROBUSTNESS-PLAN.md Phase 4).
 *
 * Boots a DISPOSABLE validation server (npm run validate:server) with the
 * deterministic agy stub (scripts/agy-stub.mjs) so antigravity is enabled
 * side-effect free, then drives a real browser through Playwright:
 *
 *   1. Antigravity background-task banner: an antigravity turn is dispatched
 *      from the composer; the stub reproduces the LIVE background-task wire
 *      (GENERIC step announcing "Tool is running as a background task with
 *      task id: ..." — captured 2026-09-10). The UI must show the amber
 *      ChildrenStrip banner ("1 background task running") while the task
 *      runs, and the banner must CLEAR once the stub writes the completion
 *      receipt into the conversation brain's messages dir (proving the
 *      server-side completion watcher end to end).
 *   2. Screen-view parity: GET /api/v1/sessions/:id/transcript?view=screen
 *      must render `run_command: <command>` (not an empty tool card).
 *   3. Discovery hygiene: a stale pi session file seeded into the disposable
 *      session dir while the server runs must be auto-archived upon
 *      discovery (prefs archived stamp) and must NOT flood the sidebar's
 *      active list.
 *
 * Usage: node scripts/verify-antigravity-background-and-archiving.mjs
 * Exit 0 = all scenarios passed. Evidence is printed to stdout.
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PATH = join(REPO_ROOT, 'scripts', 'agy-stub.mjs');
// bcrypt lives in server's dependencies; hash the E2E password so a
// NODE_ENV=production leak from .env cannot disable the login path.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt'); // hoisted to the repo-root node_modules

const results = [];
let server = null;
let validationDir = null;

function record(scenario, ok, detail) {
  results.push({ scenario, ok, detail });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${scenario}`);
  console.log(`  ${detail}`);
}

/** Pick a free localhost port (small race window; validate:server also guards). */
async function freePort() {
  return new Promise((resolvePort) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function startValidationServer() {
  const port = await freePort();
  validationDir = mkdtempSync(join(tmpdir(), 'agy-bg-e2e-'));
  const brainDir = join(validationDir, 'agy-brain');
  mkdirSync(brainDir, { recursive: true });

  const plainPassword = `e2e-${randomBytes(12).toString('base64url')}`;
  const authPasswordHash = bcrypt.hashSync(plainPassword, 10);
  const args = ['run', 'validate:server', '--', '--dir', validationDir, '--port', String(port)];
  const env = {
    ...process.env,
    AGY_BINARY: STUB_PATH,
    AGY_STUB_SCENARIO: 'bg-task',
    AGY_STUB_BRAIN_DIR: brainDir,
    AGY_STUB_BG_TASK_DELAY_MS: '6000',
    AUTH_PASSWORD: authPasswordHash,
    ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
  };

  console.log(`Booting disposable validation server on :${port} (dir ${validationDir})`);
  server = spawn('npm', args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`validate:server exited early (${server.exitCode}).\n${stderr.slice(-2000)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const token = readFileSync(join(validationDir, 'internal-api-token'), 'utf8').trim();
        return { port, token, plainPassword, brainDir };
      }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`validation server did not become healthy in 120s.\n${stderr.slice(-2000)}`);
}

async function stopValidationServer() {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch {
    try { server.kill('SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 1500));
  try { rmSync(validationDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** The Internal API is served on the disposable server's unix socket, not
 *  the TCP port (the TCP surface serves the browser app). */
function api(socketPath, token, path, options = {}) {
  return new Promise((resolveReq, rejectReq) => {
    const body = options.body ?? null;
    const req = http.request(
      { socketPath, path, method: options.method ?? 'GET' },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolveReq({ status: res.statusCode, json: () => JSON.parse(raw) }));
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('socket request timeout')));
    req.on('error', rejectReq);
    req.setHeader('Authorization', `Bearer ${token}`);
    if (body) req.setHeader('content-type', 'application/json');
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const { port, token, plainPassword, brainDir } = await startValidationServer();
  const base = `http://localhost:${port}`;
  const socketPath = join(validationDir, 'internal-api.sock');
  console.log(`Validation server healthy at ${base} (socket ${socketPath})`);

  let browser;
  try {
    // ── Setup: antigravity session via the Internal API (browserless create). ──
    const createRes = await api(socketPath, token, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ runtime: 'antigravity', cwd: join(validationDir, 'workspace') }),
    });
    const createBody = createRes.json();
    if (createRes.status >= 400) throw new Error(`Failed to create antigravity session: ${createRes.status} ${JSON.stringify(createBody)}`);
    const sessionId = createBody.sessionId ?? createBody.session?.id;
    if (!sessionId) throw new Error(`No session id in create response: ${JSON.stringify(createBody)}`);
    console.log(`Antigravity session created: ${sessionId}`);

    // ── Scenario 1: background-task banner in the live UI. ──────────────────
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="password"]').fill(plainPassword);
    await page.locator('button[type="submit"]').click();
    await page.locator('input[type="password"]').waitFor({ state: 'detached', timeout: 20_000 });
    console.log('UI authenticated.');

    // Refresh the session list, then switch to the antigravity session via
    // its distinctive AG badge (title is stable in SessionItem).
    await page.getByTitle('Refresh sessions').click();
    const agBadge = page.locator('[data-testid="session-sidebar"]').getByTitle('Antigravity - uses Google Gemini via agy CLI').first();
    try {
      await agBadge.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (err) {
      const debug = await page.locator('[data-testid="session-sidebar"]').innerText().catch(() => '<no sidebar>');
      throw new Error(`AG badge never appeared. Sidebar text: ${JSON.stringify(debug.slice(0, 800))}`);
    }
    await agBadge.locator('xpath=ancestor::div[@role="listitem"][1]').click();
    await page.waitForTimeout(1000);

    // Dispatch the turn from the composer (real user path).
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    await composer.fill('Run the verification script in the background for me.');
    await composer.press('Enter');
    console.log('Prompt dispatched; waiting for the background-task banner…');

    // The stub announces the background task during the turn; the banner must
    // appear with the antigravity wording and the task label.
    const strip = page.locator('[data-testid="children-strip"]');
    await strip.waitFor({ state: 'visible', timeout: 30_000 });
    const bannerText = (await strip.innerText()).replace(/\s+/g, ' ').trim();
    const bannerOk = /1 background task running/i.test(bannerText) && /verify_bg_e2e\.py/.test(bannerText);
    record(
      'background-task banner appears while the task runs',
      bannerOk,
      `banner text: "${bannerText}"`,
    );

    // The turn itself ends (agent_end) while the task still runs; the banner
    // must STAY visible after the composer returns to idle.
    await page.waitForTimeout(2500);
    const stillVisible = await strip.isVisible().catch(() => false);
    record(
      'banner persists after the turn ends (no more silent backgrounding)',
      stillVisible,
      stillVisible ? 'banner still visible post-turn' : 'banner disappeared before the task completed',
    );

    // ── Completion: the stub writes the receipt (~6s); the server watcher
    // (5s cadence) must transition the child and the banner must clear.
    console.log('Waiting for the completion watcher to clear the banner…');
    let cleared = false;
    let clearedDetail = 'banner still visible after 45s';
    try {
      await strip.waitFor({ state: 'detached', timeout: 45_000 });
      cleared = true;
      clearedDetail = 'banner cleared after the receipt was observed';
    } catch (err) {
      clearedDetail = `banner still visible after 45s: ${err.message.split('\n')[0]}`;
    }
    record('banner clears when the background task completes', cleared, clearedDetail);

    // The store keeps the settled child (durable card state): re-assert via
    // the server's projection instead of the strip.
    const screenRes = await api(socketPath, token, `/api/v1/sessions/${sessionId}/transcript?view=screen`);
    const screenBody = screenRes.json();

    // ── Scenario 2: screen-view tool-card parity. ──────────────────────────
    const items = screenBody?.screenView?.items ?? [];
    const runCommandItems = items.filter((i) => i.kind === 'tool' && i.toolName === 'run_command');
    const commandItem = runCommandItems.find((i) => (i.toolPrimaryArg ?? '').includes('verify_bg_e2e.py'));
    const screenOk = Boolean(commandItem) && commandItem.text.startsWith('run_command: python3 verify_bg_e2e.py');
    record(
      'screen view renders run_command with its command (no empty tool card)',
      screenOk,
      commandItem
        ? `item text: "${commandItem.text}"`
        : `run_command items found: ${runCommandItems.length}; sample: ${JSON.stringify(runCommandItems[0] ?? null).slice(0, 300)}`,
    );

    // ── Scenario 3: native-discovery archive hygiene. ───────────────────────
    const staleId = randomUUID();
    const staleName = `2026-08-01T00-00-00_${staleId}.jsonl`;
    const piSessionsDir = join(validationDir, 'pi-sessions', '--stale-e2e--');
    mkdirSync(piSessionsDir, { recursive: true });
    writeFileSync(
      join(piSessionsDir, staleName),
      JSON.stringify({
        type: 'session',
        id: staleId,
        cwd: '/tmp/stale-e2e-workspace',
        timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
      }),
    );
    console.log('Seeded a stale native pi session; waiting for the discovery watcher…');

    // The watcher archives it upon discovery (threshold 14d; file is 60d old).
    let archivedStamped = false;
    let prefsDetail = 'archived stamp not found within 30s';
    const prefsPath = join(validationDir, 'web-ui-prefs.json');
    const prefsDeadline = Date.now() + 30_000;
    while (Date.now() < prefsDeadline) {
      try {
        const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
        const rec = prefs.sessions?.[`pi:${staleId}`];
        if (rec?.archived === true) {
          archivedStamped = true;
          prefsDetail = `prefs record: ${JSON.stringify(rec)}`;
          break;
        }
      } catch { /* prefs file not written yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    record('stale native-discovered session is auto-archived upon discovery', archivedStamped, prefsDetail);

    // UI: refresh sessions; the active list must contain ONLY our agy session
    // — the stale discovery is archived server-side and hidden from active.
    await page.getByTitle('Refresh sessions').click();
    await page.waitForTimeout(1500);
    const activeRows = await page.locator('[data-testid="session-sidebar"] [role="listitem"]').count();
    record(
      'sidebar active list is not flooded by the stale discovered session',
      activeRows === 1,
      `active sidebar rows after discovery: ${activeRows} (expected 1 — only the antigravity session)`,
    );

    // Keep server-side evidence for the screen assertion made earlier.
    if (!screenOk) {
      console.log('DEBUG screen view body:', JSON.stringify(screenBody).slice(0, 1500));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopValidationServer();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n════════ SUMMARY ════════');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario}`);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('E2E verification failed:', err);
  await stopValidationServer();
  process.exit(1);
});
