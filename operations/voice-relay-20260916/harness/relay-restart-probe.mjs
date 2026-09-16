#!/usr/bin/env node
/**
 * Voice relay across a server restart — the operator's lost-instruction probe.
 *
 * Operator report (2026-09-16): they dictated an instruction in Voice Mode,
 * pressed Confirm, the front-end showed a green "Sent to the worker", and the
 * talker then said it could not deliver. The worker never received it.
 *
 * Discovered cause: Pi keys sessions by PATH and loads them LAZILY. The relay
 * resolved the wire id to a path only against the LOADED set, so after a
 * production restart (nothing loaded) it prompted by id, the MultiSessionManager
 * threw "Session <id> does not exist", and the delivery adapter refused.
 *
 * This probe reproduces that exact condition against a DISPOSABLE validation
 * server and drives the real browser seam (cookie login → /ws → talker_turn),
 * never a helper:
 *
 *   phase seed   create a worker session and let it be written to disk
 *   <external>   restart the disposable server (nothing is loaded afterwards)
 *   phase relay  dictate an instruction, confirm, and read the delivery outcome
 *
 * It then checks the WORKER'S OWN transcript for the instruction — the only
 * proof that matters to the operator — and the server's release log line.
 *
 * Usage:
 *   node relay-restart-probe.mjs --phase seed|relay [--out <json>]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const OPS = process.env.VOICE_RELAY_OPS ?? '/root/pi-web-ui/operations/voice-relay-20260916';
const base = flag('base', 'http://127.0.0.1:3531');
const origin = flag('origin', 'http://127.0.0.1:3532');
const password = flag('password', 'voice-lab-pass');
const phase = flag('phase', 'relay');
const statePath = flag('state', '/tmp/voice-relay-state.json');
const outPath = flag('out', path.join(OPS, 'evidence', 'relay-restart.json'));
const model = flag('model', 'openrouter/anthropic/claude-haiku-4.5');
const timeoutMs = Number(flag('timeout', '180000'));

/** The instruction, and the marker that proves the worker received it. */
const MARKER = 'RELAY-PROBE-OK';
const INSTRUCTION = `Reply with exactly ${MARKER} and nothing else.`;
const CONFIRM = 'yes, send that';

const report = JSON.parse(
  fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : JSON.stringify({ phases: {} })
);
const writeReport = () => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
};
const step = (key, value) => {
  report.phases[phase] = { ...(report.phases[phase] ?? {}), [key]: value };
  writeReport();
  console.log(`[${phase}] ${key}: ${JSON.stringify(value).slice(0, 600)}`);
};
const check = (name, ok, detail) => {
  const row = { name, ok: !!ok, detail };
  report.assertions = [...(report.assertions ?? []).filter((a) => a.name !== name), row];
  writeReport();
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let reqSeq = 0;
const pendingFrames = [];
const waiters = [];

function send(obj, tag) {
  ws.send(JSON.stringify(obj));
  if (tag) report.phases[phase] = { ...(report.phases[phase] ?? {}), [`sent_${tag}`]: obj };
}

function waitFor(pred, label, ms = timeoutMs) {
  const existing = pendingFrames.find((f) => {
    try { return pred(f); } catch { return false; }
  });
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { pred, resolve, label };
    waiters.push(waiter);
    setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, ms);
  });
}

async function talkerTurn(utterance, opts = {}) {
  const requestId = `r${++reqSeq}`;
  pendingFrames.length = 0;
  send({ type: 'talker_turn', workerSessionId: opts.workerSessionId, utterance, runtime: 'pi', requestId }, requestId);
  const settled = await Promise.race([
    waitFor((m) => m.type === 'talker_turn_result' && m.requestId === requestId, `result ${requestId}`)
      .then((m) => ({ kind: 'result', m }))
      .catch(() => null),
    waitFor((m) => m.type === 'error' && m.requestId === requestId, `error ${requestId}`)
      .then((m) => ({ kind: 'error', m }))
      .catch(() => null),
  ]);
  if (!settled) throw new Error(`no talker_turn_result and no error frame for ${requestId}`);
  return settled.kind === 'result' ? { result: settled.m, error: null } : { result: null, error: settled.m };
}

/** The worker's own transcript: did the instruction actually land there? */
function transcriptScan(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { exists: false, userTexts: [], assistantTexts: [], mtimeIso: null };
  }
  const stat = fs.statSync(sessionPath);
  const userTexts = [];
  const assistantTexts = [];
  for (const line of fs.readFileSync(sessionPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'message') continue;
    const role = entry?.message?.role;
    const content = entry?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : '';
    if (!text) continue;
    if (role === 'user') userTexts.push(text);
    if (role === 'assistant') assistantTexts.push(text);
  }
  return { exists: true, userTexts, assistantTexts, mtimeIso: stat.mtime.toISOString() };
}

async function connect() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie, Origin: origin } });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    pendingFrames.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      let matched = false;
      try { matched = waiters[i].pred(msg); } catch { matched = false; }
      if (matched) {
        const w = waiters.splice(i, 1)[0];
        i -= 1;
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await waitFor((m) => m.type === 'authenticated', 'authenticated');
}

async function seed() {
  await connect();
  const requestId = 'seed-1';
  send({ type: 'new_session', requestId, model }, requestId);
  const created = await waitFor((m) => m.type === 'session_created' && m.requestId === requestId, 'session_created', 120000);
  send({ type: 'set_model', modelId: model }, 'set_model');
  await waitFor((m) => m.type === 'model_changed', 'model_changed', 60000).catch(() => null);
  // One real turn, so the session exists on disk with content.
  send({ type: 'prompt', sessionPath: created.sessionPath, message: 'Reply with the single word READY.' }, 'seed_prompt');
  await waitFor((m) => m.type === 'agent_end' || m.type === 'stream_end', 'seed turn end', 120000).catch(() => null);
  await sleep(1500);

  const state = { sessionId: created.sessionId, sessionPath: created.sessionPath, model };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  step('seeded', state);
  step('seededTranscript', { userTexts: transcriptScan(created.sessionPath).userTexts.length });
  ws.close();
}

/** Is the worker in the server's memory? The relay's whole problem lived here. */
async function loadedSessionIds() {
  const token = fs.readFileSync('/tmp/voice-relay-srv/internal-api-token', 'utf8').trim();
  const { default: http } = await import('node:http');
  const body = await new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: '/tmp/voice-relay-srv/internal-api.sock', path: '/api/v1/diagnostics', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); }
    );
    req.on('error', reject);
    req.end();
  });
  const parsed = JSON.parse(body);
  return {
    lanes: parsed?.voiceMode?.lanes ?? [],
    loadStatus: parsed?.sources?.registry?.state ?? null,
  };
}

async function relay() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const before = transcriptScan(state.sessionPath);
  step('workerBeforeRelay', { exists: before.exists, userTexts: before.userTexts.length, assistantTexts: before.assistantTexts.length, mtimeIso: before.mtimeIso });
  step('serverStateBeforeRelay', await loadedSessionIds());

  await connect();

  // 1. Dictate the instruction: the talker proposes it.
  const proposed = await talkerTurn(INSTRUCTION, { workerSessionId: state.sessionId });
  step('proposalReply', { reply: proposed.result?.reply ?? null, phase: proposed.result?.phase ?? null, released: proposed.result?.released ?? null });
  check('the talker proposes the dictated instruction for confirmation', proposed.result?.phase === 'proposed', proposed.result?.phase ?? proposed.error);

  // 2. The operator confirms.
  const released = await talkerTurn(CONFIRM, { workerSessionId: state.sessionId });
  const delivery = released.result?.released?.delivery ?? null;
  step('release', { phase: released.result?.phase ?? null, reply: released.result?.reply ?? null, delivery });

  const outcome = delivery?.outcome ?? null;
  check('the confirmed relay is DELIVERED to an idle, unloaded worker', outcome === 'delivered', delivery);
  if (outcome !== 'delivered') {
    // Keep the honest refusal in the evidence.
  }

  // 3. The only proof the operator cares about: the worker's own transcript.
  const deadline = Date.now() + 60000;
  let after = transcriptScan(state.sessionPath);
  let landed = after.userTexts.some((t) => t.includes(MARKER));
  while (!landed && Date.now() < deadline) {
    await sleep(1000);
    after = transcriptScan(state.sessionPath);
    landed = after.userTexts.some((t) => t.includes(MARKER));
  }
  const answered = after.assistantTexts.some((t) => t.includes(MARKER));
  step('workerAfterRelay', {
    userTexts: after.userTexts.length,
    assistantTexts: after.assistantTexts.length,
    mtimeIso: after.mtimeIso,
    landedInstruction: after.userTexts.filter((t) => t.includes(MARKER)),
  });
  check('the instruction is in the WORKER transcript (it really arrived)', landed, { marker: MARKER });
  check('the worker answered the relayed instruction (a real turn ran)', answered);

  // 4. Diagnosability: the release outcome is readable from the journal line.
  const logPath = path.join(OPS, 'logs', 'server.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const releaseLines = log.split('\n').filter((l) => l.includes('voice release '));
  step('journalReleaseLines', releaseLines.slice(-3));
  check(
    'the journal states the delivery outcome (and the reason when refused)',
    releaseLines.some((l) => l.includes('delivered') || l.includes('refused')),
    releaseLines.slice(-1)
  );

  ws.close();
}

async function main() {
  report.startedAt = report.startedAt ?? new Date().toISOString();
  report.base = base;
  if (phase === 'seed') await seed();
  else await relay();
  report.finishedAt = new Date().toISOString();
  writeReport();
  const failed = (report.assertions ?? []).filter((a) => !a.ok);
  console.log(`\n=== ${outPath} — ${(report.assertions ?? []).length - failed.length}/${(report.assertions ?? []).length} assertions passed`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map((a) => a.name).join(' | ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  step('FATAL', String(err?.stack ?? err));
  process.exit(1);
});
