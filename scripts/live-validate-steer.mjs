#!/usr/bin/env node
/**
 * Live steering validation over the REAL browser WebSocket protocol (path 3:
 * cookie auth + /ws, exactly what the UI speaks).
 *
 * For --runtime commandcode (fixture) and --runtime claude (real SDK backend):
 *   1. prompt a slow multi-step task,
 *   2. steer mid-run           → the steer text must reach the transcript and
 *                                redirect the agent,
 *   3. run another slow task and send a follow_up → it must run as its own
 *                                turn after the current one finishes.
 *
 * Usage:
 *   node scripts/live-validate-steer.mjs \
 *     --url http://127.0.0.1:<port> --password validation-pass \
 *     --runtime commandcode --cwd <dir> [--model qwen/qwen3.8-max]
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import process from 'node:process';
import { WebSocket as WsWebSocket } from 'ws';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const BASE_URL = arg('url', 'http://127.0.0.1:3456');
const PASSWORD = arg('password', 'validation-pass');
const RUNTIME = arg('runtime', 'commandcode');
const CWD = arg('cwd', process.cwd());
const MODEL = arg('model', undefined);
const VERBOSE = process.argv.includes('--verbose');
/** Origin the validation server accepts (its boot banner lists allowed origins). */
const ORIGIN = arg('origin', 'https://tmux.letsautomate.work');

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

const TASKS = {
  commandcode: {
    model: 'qwen/qwen3.8-max',
    slowPrompt: 'COMMAND-CODE-SLOW-RUN',
    steerText: 'Redirect now. Reply with exactly: COMMAND-CODE-LIVE-OK',
    steerExpect: 'COMMAND-CODE-LIVE-OK',
    followUpText: 'Reply with exactly: SECOND-VALIDATION-TURN',
    followUpExpect: 'SECOND-VALIDATION-TURN',
    slowCompleteExpect: 'SLOW-RUN-COMPLETED',
  },
  claude: {
    model: 'sonnet',
    slowPrompt: 'Run exactly 3 Bash calls strictly one at a time (never batch them), each running: sleep 6 . Only after all three, reply with exactly: CLAUDE-SLOW-DONE',
    steerText: 'IMPORTANT: stop the sequence immediately, no more sleep calls. Reply with exactly: CLAUDE-STEERED-OK',
    steerExpect: 'CLAUDE-STEERED-OK',
    followUpText: 'Reply with exactly: CLAUDE-FOLLOWUP-OK',
    followUpExpect: 'CLAUDE-FOLLOWUP-OK',
    slowCompleteExpect: 'CLAUDE-SLOW-DONE',
  },
}[RUNTIME];
if (!TASKS) {
  console.error(`unsupported runtime: ${RUNTIME}`);
  process.exit(1);
}

class Recorder {
  constructor() {
    this.events = [];
    this.texts = [];
    this.userTexts = [];
    this.agentStarts = 0;
    this.agentEnds = 0;
    this.errors = [];
  }
  push(sessionId, event) {
    if (sessionId !== this.sessionId) return;
    this.events.push(event);
    if (event.type === 'agent_start') this.agentStarts += 1;
    if (event.type === 'agent_end') this.agentEnds += 1;
    if (event.type === 'message_start' && event.message?.role === 'user') {
      this.userTexts.push(String(event.message?.content ?? ''));
    }
    if (event.type === 'message_update' && event.message && event.assistantMessageEvent?.delta) {
      this.texts.push(event.assistantMessageEvent.delta);
    }
    if (event.type === 'error') this.errors.push(event);
  }
  fullText() { return this.texts.join(''); }
  has(text) { return this.fullText().includes(text) || this.userTexts.some((u) => u.includes(text)); }
  hasAssistantText(text) { return this.fullText().includes(text); }
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  const body = await res.json();
  return { cookie, csrfToken: body.csrfToken };
}

function openSocket(auth) {
  return new Promise((resolve, reject) => {
    // The `ws` package is required: Node's global WHATWG WebSocket cannot send
    // the auth Cookie header.
    const ws = new WsWebSocket(`${BASE_URL.replace('http', 'ws')}/ws`, {
      headers: { Cookie: auth.cookie, Origin: ORIGIN },
    });
    ws.once('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', csrfToken: auth.csrfToken }));
      resolve(ws);
    });
  });
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function main() {
  log(`steer live validation: runtime=${RUNTIME} url=${BASE_URL}`);
  const auth = await login();
  const ws = await openSocket(auth);

  const recorder = new Recorder();
  ws.addEventListener('message', (frame) => {
    const msg = JSON.parse(frame.data);
    if (msg.type === 'session_event') {
      if (VERBOSE) log('event:', msg.event?.type, JSON.stringify(msg.event?.message?.content ?? '').slice(0, 60));
      recorder.push(msg.sessionId, msg.event);
    } else if (msg.type === 'error') {
      log('SERVER ERROR:', JSON.stringify(msg));
    }
  });

  const send = (obj) => ws.send(JSON.stringify(obj));
  const sessionCreated = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no session_created')), 20000);
    ws.addEventListener('message', (frame) => {
      const msg = JSON.parse(frame.data);
      if (msg.type === 'session_created') { clearTimeout(timer); resolve(msg); }
    });
  });
  send({ type: 'new_session', cwd: CWD, sdkType: RUNTIME, ...(MODEL ? { model: MODEL } : {}) });
  const created = await sessionCreated;
  recorder.sessionId = created.sessionId;
  log(`session created: ${created.sessionId} (model=${created.model ?? TASKS.model})`);

  // ── Scenario A: steer mid-run ────────────────────────────────────────────
  send({ type: 'prompt', sessionId: recorder.sessionId, message: TASKS.slowPrompt });
  await waitFor(() => recorder.texts.length > 0 || recorder.agentStarts >= 1, 60000, 'first run activity');
  log('run is live; sending steer');
  send({ type: 'steer', message: TASKS.steerText });
  await waitFor(() => recorder.hasAssistantText(TASKS.steerExpect), 180000, `steer result ${TASKS.steerExpect}`);
  log(`steer delivered and redirected (agentStarts=${recorder.agentStarts})`);
  if (!recorder.userTexts.some((u) => u.includes(TASKS.steerExpect) || u.includes('Redirect now') || u.includes('stop the sequence'))) {
    throw new Error('steer user message never appeared in the transcript');
  }
  // The slow run must NOT have completed normally for commandcode (interrupted).
  if (RUNTIME === 'commandcode' && recorder.has(TASKS.slowCompleteExpect)) {
    throw new Error('slow run completed despite steer — abort hand-off did not interrupt it');
  }
  await waitFor(() => recorder.agentEnds >= 1, 60000, 'steer run end');
  log(`scenario A PASS: steer redirected the agent; user bubble present; agentEnds=${recorder.agentEnds}`);

  // ── Scenario B: follow-up queued while running ───────────────────────────
  const beforeText = recorder.fullText();
  send({ type: 'prompt', sessionId: recorder.sessionId, message: TASKS.slowPrompt });
  await waitFor(() => recorder.texts.length > 0 && recorder.fullText() !== beforeText, 60000, 'second run activity');
  log('second run is live; sending follow_up');
  send({ type: 'follow_up', message: TASKS.followUpText });
  // Wait for the follow-up's ASSISTANT text (the user bubble alone would
  // resolve the wait before the ordering check can see the assistant turn).
  await waitFor(() => recorder.hasAssistantText(TASKS.followUpExpect), 240000, `follow-up result ${TASKS.followUpExpect}`);
  log('follow-up ran as its own turn');
  const followUpIdx = recorder.fullText().indexOf(TASKS.followUpExpect);
  const slowIdx = recorder.fullText().indexOf(TASKS.slowCompleteExpect, beforeText.length);
  if (RUNTIME === 'commandcode') {
    if (slowIdx < 0) throw new Error('commandcode: slow run did not complete before follow-up');
    if (followUpIdx < slowIdx) throw new Error('commandcode: follow-up ran before the current run finished');
  }
  log('scenario B PASS: follow-up delivered after the live run');

  log('✅ LIVE-VALIDATED — steering + follow-up on the browser WebSocket protocol');
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ FAILED —', err.message);
  process.exit(1);
});
