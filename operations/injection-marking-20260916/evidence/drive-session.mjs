#!/usr/bin/env node
/*
 * Injection marking (2026-09-16) — drive one disposable pi session and capture
 * the evidence over the SAME surfaces the browser uses (HTTP port + cookie WS).
 *
 *  1. login (cookie), resolve the child-route model selector from /models
 *  2. open the browser WebSocket (/ws, cookie auth) and subscribe to the
 *     session — the wire-level record of every event the browser receives,
 *     INCLUDING the routine capture injection's message_start
 *  3. create the session (runtime pi, cwd = lab workspace)
 *  4. prompt real work (bash tool → ≥5 message entries → capture decision
 *     eligible); wait for the turn AND the injection-triggered follow-up turn
 *  5. dump: WS frames (message_start roles/types), transcript?view=screen,
 *     transcript?scope=visible_full, history, session info
 *
 * Usage: node drive-session.mjs <port> <tokenPath> <outDir> <label>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const [port, tokenPath, outDir, label] = process.argv.slice(2);
if (!port || !tokenPath || !outDir || !label) {
  console.error('usage: drive-session.mjs <port> <tokenPath> <outDir> <label>');
  process.exit(2);
}
const socket = tokenPath.replace(/[^/]+$/, 'internal-api.sock');
const BASE = `http://127.0.0.1:${port}`;
mkdirSync(outDir, { recursive: true });
const token = readFileSync(tokenPath, 'utf8').trim();
const LAB = '/root/inject-lab-20260916';
const PASSWORD = 'voice-lab-pass'; // disposable bcrypt baked into boot-ab.sh

const log = (...a) => console.log(`[${label}]`, ...a);

async function req(method, path, body, cookie) {
  const headers = { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* raw */ }
  return { status: res.status, headers: res.headers, json, raw };
}

/** /api/v1/* lives on the unix socket only (Internal API surface). */
function sockReq(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      { socketPath: socket, path: `/api/v1${path}`, method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
          ...(cookie ? { cookie } : {}),
          authorization: `Bearer ${token}`,
        } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* raw */ }
          resolve({ status: res.statusCode, headers: res.headers, json, raw: buf });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---- 1. login → cookie -----------------------------------------------------
const login = await req('POST', '/api/auth/login', { password: PASSWORD });
if (login.status !== 200) { console.error('login failed', login.status, login.raw.slice(0, 200)); process.exit(1); }
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
log('login ok');

// ---- 2. model discovery (live /models; canonical child route) ---------------
const models = await sockReq('GET', '/models?runtime=pi', undefined, cookie);
const all = models.json?.models ?? {};
const entries = Array.isArray(all) ? all : (all.pi ?? []);
const sel = entries.filter((m) => (m.selector ?? '') === 'zai/glm-5.3-flash');
if (sel.length !== 1) {
  console.error(`selector zai/glm-5.3-flash: ${sel.length} matches — refusing (routing discipline)`);
  console.error('available:', entries.map((m) => m.selector).filter(Boolean).slice(0, 30));
  process.exit(1);
}
log('model resolved: zai/glm-5.3-flash');

// ---- 3. create the session --------------------------------------------------
const create = await sockReq('POST', '/sessions', {
  runtime: 'pi',
  cwd: `${LAB}/workspace`,
  model: 'zai/glm-5.3-flash',
  thinkingLevel: 'high',
}, cookie);
if (create.status !== 201) { console.error('create failed', create.status, create.raw.slice(0, 300)); process.exit(1); }
const { sessionId, sessionPath } = create.json;
log('session', sessionId, 'path', sessionPath);
writeFileSync(join(outDir, `${label}-create.json`), JSON.stringify(create.json, null, 2));

// ---- 4. WS capture (what the browser receives) ------------------------------
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: `http://localhost:${port}` } });
const frames = [];
const wsReady = new Promise((resolve, reject) => {
  ws.on('open', () => { ws.send(JSON.stringify({ type: 'subscribe_session', sessionPath })); log('ws subscribed', sessionPath); resolve(); });
  ws.on('error', reject);
});
ws.on('message', (d) => {
  try { frames.push(JSON.parse(d.toString())); } catch { frames.push({ raw: d.toString().slice(0, 2000) }); }
});

// ---- 5. real work (bash tool) ------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await wsReady;
await sleep(500);
const prompt = await sockReq('POST', `/sessions/${sessionId}/prompt`, {
  message: 'Use the bash tool to create a file named inject-lab.txt in the current directory containing exactly MARKER then reply with the file contents plus at least one short paragraph (about 120 words) summarising what you did and why capturing work artefacts matters.',
  verbosity: 'tasks',
}, cookie);
log('prompt status', prompt.status, 'dispatchMode', prompt.json?.dispatchMode);
writeFileSync(join(outDir, `${label}-prompt-result.json`), JSON.stringify(prompt.json ?? prompt.raw, null, 2));

// The capture injection fires at agent_end and triggers a FOLLOW-UP turn.
// Wait until the session has been idle for a stable window after the follow-up.
let idleStreak = 0;
let lastMsgCount = -1;
for (let i = 0; i < 120; i++) {
  await sleep(3000);
  const info = await sockReq('GET', `/sessions/${sessionId}`, undefined, cookie);
  const st = info.json?.status ?? info.json?.session?.status;
  const t = await sockReq('GET', `/sessions/${sessionId}/transcript?scope=visible_full`, undefined, cookie);
  const msgs = t.json?.messages ?? t.json?.entries ?? [];
  if (st === 'idle' || st === undefined) idleStreak++; else idleStreak = 0;
  if (msgs.length !== lastMsgCount) { log(`t=${i * 3}s status=${st} entries=${msgs.length}`); lastMsgCount = msgs.length; }
  if (idleStreak >= 3 && i > 5) break;
}
await sleep(2000);

// ---- 6. evidence dumps -------------------------------------------------------
writeFileSync(join(outDir, `${label}-ws-frames.json`), JSON.stringify(frames, null, 1));
const starts = [];
for (const f of frames) {
  const ev = f.event ?? f;
  if (ev?.type === 'message_start') {
    const m = ev.message ?? {};
    starts.push({ id: m.id, role: m.role, customType: m.customType, preview: JSON.stringify(m.content ?? '').slice(0, 120) });
  }
}
writeFileSync(join(outDir, `${label}-message-starts.json`), JSON.stringify(starts, null, 2));
log('message_start events on the wire:', JSON.stringify(starts, null, 1));

for (const [name, path] of [
  ['screen', `/sessions/${sessionId}/transcript?view=screen`],
  ['full', `/sessions/${sessionId}/transcript?scope=visible_full`],
  ['history', `/sessions/${sessionId}/history`],
  ['info', `/sessions/${sessionId}`],
]) {
  const r = await sockReq('GET', path, undefined, cookie);
  writeFileSync(join(outDir, `${label}-${name}.json`), JSON.stringify(r.json ?? r.raw, null, 2));
}
ws.close();
log('DONE — evidence in', outDir);
