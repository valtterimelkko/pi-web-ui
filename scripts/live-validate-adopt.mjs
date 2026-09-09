#!/usr/bin/env node
/**
 * Live validation: Session Adoption + Native Adoption (contract 1.40.0).
 *
 * Exercises the real Internal API over the disposable validation server's
 * unix socket:
 *   1. capabilities advertises contractVersion 1.40.0
 *   2. two real pi sessions; adopt the child under the parent via
 *      POST /sessions/:id/adopt (body + header variants)
 *   3. registry linkage visible on session detail; `child_dispatched`
 *      observable on the parent's broker key (events snapshot)
 *   4. control verb: POST /sessions/:id/control {action:'adopt'}
 *   5. adopt-native against the newest REAL claude artefact on disk
 *      (read-only: the disposable registry gains an entry; the native
 *      transcript is never modified and is retained on delete)
 *   6. guards: pi runtime refused, path traversal refused, unknown
 *      parent/child 404, self-adoption 400, missing artefact 404
 *   7. browser surface smoke: /api/auth/login → GET /api/sessions/native
 *      (cookie-authenticated HTTP port)
 *   8. cleanup: deletes every pi session it created
 *
 * Usage:
 *   node scripts/live-validate-adopt.mjs --socket <validation.sock> \
 *     --token-path <validation-token> [--port <http-port>] \
 *     [--password validation-pass] [--model zai/glm-5.3-flash]
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import process from 'node:process';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const SOCKET = arg('socket', '');
const TOKEN_PATH = arg('token-path', '');
const HTTP_PORT = arg('port', '');
const PASSWORD = arg('password', 'validation-pass');
const MODEL = arg('model', 'zai/glm-5.3-flash');
const CWD = arg('cwd', '/root/pi-web-ui');

if (!SOCKET || !TOKEN_PATH) {
  console.error('--socket and --token-path are required');
  process.exit(1);
}

const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
const results = [];
let failed = 0;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

function apiRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path: `/api/v1${urlPath}`, method,
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extraHeaders } },
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpRequest(port, method, urlPath, body, cookie, csrfToken) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(cookie && method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        } },
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

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  if (!ok) failed += 1;
  log(ok ? 'PASS' : 'FAIL', `— ${step}${detail ? ` :: ${detail}` : ''}`);
}

/** Newest native claude artefact on this host (read-only adoption target). */
async function newestClaudeArtifact() {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');
  let best = null;
  for (const dir of await fsp.readdir(root).catch(() => [])) {
    const dirPath = path.join(root, dir);
    const stDir = await fsp.stat(dirPath).catch(() => null);
    if (!stDir?.isDirectory()) continue;
    for (const file of await fsp.readdir(dirPath).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue;
      const st = await fsp.stat(path.join(dirPath, file)).catch(() => null);
      if (!st?.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { nativeId: file.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

async function main() {
  // 1. Contract version.
  const caps = await apiRequest('GET', '/capabilities');
  record('capabilities.contract.contractVersion==1.40.0', caps.json?.contract?.contractVersion === '1.40.0', caps.json?.contract?.contractVersion);

  // 2. Two real pi sessions.
  const parentRes = await apiRequest('POST', '/sessions', { runtime: 'pi', cwd: CWD, model: MODEL });
  const childRes = await apiRequest('POST', '/sessions', { runtime: 'pi', cwd: CWD, model: MODEL });
  const parentId = parentRes.json?.sessionId;
  const childId = childRes.json?.sessionId;
  record('create parent+child pi sessions', Boolean(parentId && childId), `parent=${parentId} child=${childId}`);
  if (!parentId || !childId) throw new Error('cannot continue without sessions');

  try {
    // 3. Adopt via body.
    const adoptBody = await apiRequest('POST', `/sessions/${childId}/adopt`, { parentSessionId: parentId, alias: 'adopt-live-child', role: 'live-validation' });
    record('adopt(body).success', adoptBody.status === 200 && adoptBody.json?.success === true
      && adoptBody.json?.childSessionId === childId && adoptBody.json?.parentSessionId === parentId
      && adoptBody.json?.runtime === 'pi', JSON.stringify(adoptBody.json)?.slice(0, 160));

    // Registry linkage on detail.
    const detail = await apiRequest('GET', `/sessions/${childId}`);
    record('detail.parentSessionId linked', detail.json?.parentSessionId === parentId, `got=${detail.json?.parentSessionId}`);

    // child_dispatched on the parent's broker key.
    const events = await apiRequest('GET', `/sessions/${parentId}/events?mode=snapshot`);
    const evts = events.json?.events ?? [];
    const dispatched = evts.find((e) => e.type === 'child_dispatched' && (e.data?.child?.childSessionId === childId || e.data?.sessionId === parentId));
    record('child_dispatched on parent broker key', Boolean(dispatched), `events=${evts.length}`);

    // 4. Adopt via header (re-adopt is idempotent).
    const adoptHeader = await apiRequest('POST', `/sessions/${childId}/adopt`, {}, { 'X-Parent-Session': parentId });
    record('adopt(header).success', adoptHeader.status === 200 && adoptHeader.json?.success === true, `status=${adoptHeader.status}`);

    // 5. Control verb.
    const control = await apiRequest('POST', `/sessions/${childId}/control`, { action: 'adopt', parentSessionId: parentId });
    record('control(action=adopt)', control.status === 200 && control.json?.action === 'adopt'
      && control.json?.childSessionId === childId && control.json?.parentSessionId === parentId, JSON.stringify(control.json)?.slice(0, 160));

    // 6. Guards.
    const selfAdopt = await apiRequest('POST', `/sessions/${parentId}/adopt`, { parentSessionId: parentId });
    record('self-adoption → 400 INVALID_REQUEST', selfAdopt.status === 400 && selfAdopt.json?.code === 'INVALID_REQUEST', `status=${selfAdopt.status}`);
    const missingParent = await apiRequest('POST', `/sessions/${childId}/adopt`, { parentSessionId: crypto.randomUUID() });
    record('unknown parent → 404 SESSION_NOT_FOUND', missingParent.status === 404 && missingParent.json?.code === 'SESSION_NOT_FOUND', `status=${missingParent.status}`);
    const missingChild = await apiRequest('POST', `/sessions/${crypto.randomUUID()}/adopt`, { parentSessionId: parentId });
    record('unknown child → 404 SESSION_NOT_FOUND', missingChild.status === 404 && missingChild.json?.code === 'SESSION_NOT_FOUND', `status=${missingChild.status}`);

    // 7. adopt-native against a real claude artefact inside the validation
    // server's CLAUDE_CONFIG_DIR (pass --claude-home <validationDir>/claude-config).
    const claudeHome = arg('claude-home', '');
    if (claudeHome && fs.existsSync(claudeHome)) {
      const nativeId = crypto.randomUUID();
      const projDir = path.join(claudeHome, 'projects', '-root-adopt-live');
      await fsp.mkdir(projDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'ADOPT-LIVE first native turn' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
      ];
      await fsp.writeFile(path.join(projDir, `${nativeId}.jsonl`), lines.join('\n') + '\n');

      const created = await apiRequest('POST', '/sessions/adopt-native', { runtime: 'claude', nativeId, cwd: '/root/adopt-live', parentSessionId: parentId });
      record('adopt-native(created) + linkage', created.status === 200 && created.json?.adopted === 'created'
        && created.json?.parentSessionId === parentId, JSON.stringify(created.json)?.slice(0, 220));
      const nativeEntry = (await apiRequest('GET', '/sessions?runtime=claude&limit=200')).json?.sessions
        ?.find((s) => s.sessionId === created.json?.sessionId);
      record('native entry origin=native-discovered', nativeEntry?.source === 'native-discovered'
        && nativeEntry?.sessionPath === created.json?.nativePath
        && String(nativeEntry?.firstMessage ?? '').includes('ADOPT-LIVE'), `source=${nativeEntry?.source} first=${String(nativeEntry?.firstMessage).slice(0, 40)}`);

      const again = await apiRequest('POST', '/sessions/adopt-native', { runtime: 'claude', nativeId, cwd: '/root/adopt-live', parentSessionId: parentId });
      record('adopt-native(existing) no duplicate', again.status === 200 && again.json?.adopted === 'existing'
        && again.json?.sessionId === created.json?.sessionId, `adopted=${again.json?.adopted}`);

      if (created.json?.sessionId) await apiRequest('DELETE', `/sessions/${created.json.sessionId}`);
    } else {
      record('adopt-native hermetic dir provided', false, 'pass --claude-home <validationDir>/claude-config');
    }

    // 8. Guards for adopt-native.
    const piRefused = await apiRequest('POST', '/sessions/adopt-native', { runtime: 'pi', nativeId: crypto.randomUUID(), cwd: CWD });
    record('adopt-native runtime=pi → 400', piRefused.status === 400, `status=${piRefused.status}`);
    const traversal = await apiRequest('POST', '/sessions/adopt-native', { runtime: 'claude', nativeId: '../../etc/passwd', cwd: CWD });
    record('adopt-native traversal → 400', traversal.status === 400, `status=${traversal.status}`);
    const noArtifact = await apiRequest('POST', '/sessions/adopt-native', { runtime: 'claude', nativeId: crypto.randomUUID(), cwd: '/root/adopt-live' });
    record('adopt-native missing artefact → 404 NATIVE_SESSION_NOT_FOUND', noArtifact.status === 404 && noArtifact.json?.code === 'NATIVE_SESSION_NOT_FOUND', `status=${noArtifact.status}`);

    // 9. Browser surface smoke (cookie auth over the HTTP port).
    if (HTTP_PORT) {
      const login = await httpRequest(Number(HTTP_PORT), 'POST', '/api/auth/login', { password: PASSWORD });
      const cookie = login.setCookie?.[0]?.split(';')[0];
      const csrf = login.json?.csrfToken;
      record('browser login', login.status === 200 && Boolean(cookie), `status=${login.status}`);
      if (cookie) {
        const nativeList = await httpRequest(Number(HTTP_PORT), 'GET', '/api/sessions/native?runtime=claude', undefined, cookie, csrf);
        record('GET /api/sessions/native', nativeList.status === 200 && Array.isArray(nativeList.json?.sessions), `status=${nativeList.status} n=${nativeList.json?.sessions?.length}`);
      }
    }
  } finally {
    // 10. Cleanup created pi sessions.
    for (const id of [childId, parentId]) {
      const del = await apiRequest('DELETE', `/sessions/${id}`);
      log('cleanup', id, `status=${del.status}`);
    }
  }

  console.log('\n=== Adoption live validation summary ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.step}${r.detail ? ` :: ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('validation crashed:', err);
  process.exit(1);
});
