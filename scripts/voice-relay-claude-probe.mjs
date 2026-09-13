#!/usr/bin/env node
/**
 * P6 Phase 5 — Claude SDK talker-relay probe (A8 per-runtime delivery honesty).
 *
 * Drives the browser WebSocket path against a DISPOSABLE validation server:
 *   1. creates a Claude worker session on an SDK-backend provider profile
 *      (new_session { sdkType:'claude', model:'profile:<id>' });
 *   2. makes it BUSY on a slow multi-step Bash task;
 *   3. drives talker_turn (runtime 'claude'): conversational → propose (nothing
 *      sent) → confirm (release);
 *   4. proves the release verbatim: the operator's utterance is read back from
 *      THE WORKER'S OWN transcript — the Claude session JSONL written by the
 *      server's ClaudeSessionStore — and compared by UTF-8 byte equality.
 *
 * The claude delivery adapter may report steer (mid-run) or follow_up (queued)
 * — both are honest outcomes; the probe records which happened and, for
 * follow_up, waits for the queued turn to finish before the byte check.
 *
 * Usage:
 *   node scripts/voice-relay-claude-probe.mjs --base http://localhost:3093 \
 *     --origin https://pi.letsautomate.work --password validation-pass \
 *     [--profile glm53-claude-sdk-native-profile] [--out /tmp/path.json]
 *
 * The TALKER model key must be in the SERVER's environment (the talker_turn
 * handler runs server-side). Exits 0 on PASS.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const base = flag('base', 'http://localhost:3093');
const origin = flag('origin', 'https://pi.letsautomate.work');
const password = flag('password', 'validation-pass');
const profile = flag('profile', 'glm53-claude-sdk-native-profile');
const claudeSessionDir = flag('claude-session-dir', '/tmp/pi-vc-p6/claude-sessions');
const outPath = flag('out', `/tmp/voice-relay-claude-${Date.now()}.json`);

const INSTRUCTION = 'Please tell the worker to reply with exactly CLAUDE-RELAY-OK once it finishes the current task.';
const CONFIRM = 'Yes, go ahead.';
const CONVERSATIONAL = 'how is the worker doing right now?';
const BUSY_PROMPT =
  'Run exactly 4 Bash calls strictly one at a time (never batch them), each running: sleep 12 . ' +
  'Only after all four have finished, reply with exactly: CLAUDE-SLOW-TASK-DONE';

const frames = [];
const proofs = { profile };
let ws;
let done = false;
function finish(verdict, extra = {}) {
  if (done) return;
  done = true;
  const record = { verdict, proofs, frames: frames.slice(-40), ...extra };
  fs.writeFileSync(outPath, JSON.stringify(record, null, 1));
  console.log(`verdict: ${verdict}`);
  console.log(`json: ${outPath}`);
  try { ws?.close(); } catch { /* */ }
  process.exit(verdict.startsWith('OK') ? 0 : 1);
}
setTimeout(() => finish('TIMEOUT after 420s'), 420_000);

function send(obj) {
  frames.push({ dir: 'sent', frame: JSON.stringify(obj).slice(0, 400) });
  ws.send(JSON.stringify(obj));
}
function wait(label, predicate, timeoutMs, startTimer = true) {
  return new Promise((resolve, reject) => {
    const waiter = { label, predicate, resolve };
    waiters.push(waiter);
    if (startTimer) {
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timeout (${timeoutMs}ms) waiting for ${label}`));
      }, timeoutMs);
    }
  });
}
const waiters = [];
let pendingCreate = null;
function route(msg) {
  frames.push({ dir: 'recv', frame: JSON.stringify(msg).slice(0, 400) });
  if (msg?.type === 'error' && pendingCreate) {
    // Fail fast with the server's own error message.
    pendingCreate = null;
    for (const w of waiters.splice(0)) if (w.timer) clearTimeout(w.timer);
    finish(`FAILED server rejected session create: ${msg.message} (code=${msg.code})`);
  }
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    let matched = false;
    try { matched = w.predicate(msg); } catch { matched = false; }
    if (matched) {
      if (w.timer) clearTimeout(w.timer);
      waiters.splice(i, 1);
      w.resolve(msg);
      return true;
    }
  }
  return false;
}

/** Worker-transcript user messages from the CLAUDE session JSONL (server-side store). */
function readClaudeUserTexts(sessionId) {
  const file = `${claudeSessionDir}/${sessionId}.jsonl`;
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'user' || typeof e?.content !== 'string') continue;
    out.push(e.content);
  }
  return out;
}
function readClaudeAllRoles(sessionId) {
  const file = `${claudeSessionDir}/${sessionId}.jsonl`;
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === 'user' || e?.type === 'assistant') out.push({ role: e.type, text: String(e.content ?? '') });
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) finish(`FAILED login: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie, origin } });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    route(msg);
  });
  ws.on('error', (e) => finish(`FAILED ws error: ${e.message}`));

  await wait('authenticated', (m) => m.type === 'authenticated', 30_000);

  // 1. Create the Claude worker on the SDK profile.
  send({ type: 'new_session', sdkType: 'claude', model: `profile:${profile}`, requestId: 'ns1' });
  pendingCreate = true;
  console.log('creating claude session on profile (SDK startup can take 1-4 min on first use)...');
  const created = await wait('session_created (claude)', (m) => m.type === 'session_created' && m.requestId === 'ns1', 240_000);
  const sessionId = created.sessionId;
  proofs.workerSession = { sessionId, sdkType: created.sdkType, model: created.model };
  console.log(`claude worker session: ${sessionId} (sdkType=${created.sdkType}, model=${created.model})`);

  // 2. Make it BUSY.
  send({ type: 'prompt', sessionId, message: BUSY_PROMPT });
  await wait('claude busy (agent_start)', (m) => m.type === 'session_event' && m.event?.type === 'agent_start', 120_000);
  proofs.workerBusy = true;
  console.log('claude worker BUSY');

  // 3a. Conversational turn.
  send({ type: 'talker_turn', workerSessionId: sessionId, utterance: CONVERSATIONAL, runtime: 'claude', requestId: 't1' });
  const r1 = await wait('talker_turn_result t1', (m) => m.type === 'talker_turn_result' && m.requestId === 't1', 120_000);
  if (r1.phase !== 'answered' || !r1.reply?.trim()) finish(`FAILED t1 conversational: phase=${r1.phase} reply=${JSON.stringify(r1.reply)}`);
  proofs.conversational = { phase: r1.phase, replyPreview: r1.reply.slice(0, 140) };
  console.log(`conversational: ${JSON.stringify(r1.reply.slice(0, 110))}`);

  // 3b. Instruction turn — propose, NOTHING sent.
  send({ type: 'talker_turn', workerSessionId: sessionId, utterance: INSTRUCTION, runtime: 'claude', requestId: 't2' });
  const r2 = await wait('talker_turn_result t2', (m) => m.type === 'talker_turn_result' && m.requestId === 't2', 120_000);
  if (r2.phase !== 'proposed' || r2.released !== null) finish(`FAILED t2 propose: phase=${r2.phase} released=${JSON.stringify(r2.released)}`);
  const beforeConfirm = readClaudeUserTexts(sessionId);
  if (beforeConfirm.some((t) => t.includes('CLAUDE-RELAY-OK') || t === INSTRUCTION)) {
    finish('FAILED gate breach: instruction present in the claude worker transcript BEFORE confirmation');
  }
  proofs.proposal = { phase: r2.phase, claudeTranscriptUserMessages: beforeConfirm.length, instructionInTranscriptBeforeConfirm: false };
  console.log(`proposed; transcript user messages before confirm: ${beforeConfirm.length} (no instruction) reply=${JSON.stringify(r2.reply.slice(0, 110))}`);

  // 3c. Confirm — release.
  send({ type: 'talker_turn', workerSessionId: sessionId, utterance: CONFIRM, runtime: 'claude', requestId: 't3' });
  const r3 = await wait('talker_turn_result t3', (m) => m.type === 'talker_turn_result' && m.requestId === 't3', 120_000);
  if (r3.phase !== 'released' || !r3.released) finish(`FAILED t3 release: phase=${r3.phase} released=${JSON.stringify(r3.released)}`);
  if (r3.released.text !== INSTRUCTION) finish(`FAILED t3 release text mismatch: ${JSON.stringify(r3.released.text)}`);
  proofs.release = {
    ack: r3.reply,
    delivery: r3.released.delivery,
    sentBytes: Buffer.byteLength(INSTRUCTION, 'utf8'),
  };
  console.log(`released; delivery=${JSON.stringify(r3.released.delivery)}`);

  // 4. Verbatim proof from the CLAUDE worker's own transcript. For follow_up
  // (queued) delivery the text lands after the current turn; allow up to 5 min.
  const sentBuf = Buffer.from(INSTRUCTION, 'utf8');
  let hit = null;
  const start = Date.now();
  while (Date.now() - start < 300_000) {
    hit = readClaudeUserTexts(sessionId).find((t) => sentBuf.equals(Buffer.from(t, 'utf8')));
    if (hit) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!hit) finish(`FAILED byte-for-byte: instruction never appeared in the claude worker transcript; have: ${JSON.stringify(readClaudeUserTexts(sessionId))}`);
  const roleTexts = readClaudeAllRoles(sessionId);
  const steerIdx = roleTexts.findIndex((e) => e.role === 'user' && sentBuf.equals(Buffer.from(e.text, 'utf8')));
  const lastAssistantIdx = roleTexts.map((e) => e.role).lastIndexOf('assistant');
  proofs.byteForByte = {
    method: 'Buffer.equals on UTF-8 bytes of the operator utterance vs the CLAUDE session JSONL user entry',
    sentBytes: sentBuf.byteLength,
    receivedBytes: Buffer.byteLength(hit, 'utf8'),
    equal: true,
    deliveryMechanism: r3.released.delivery?.mechanism,
    ordering: { instructionEntryIndex: steerIdx, lastAssistantIndex: lastAssistantIdx },
    finalAssistantPreview: (roleTexts[lastAssistantIdx]?.text ?? '').slice(0, 100),
  };
  console.log(`byte-for-byte OK: ${sentBuf.byteLength}B sent == received (mechanism=${r3.released.delivery?.mechanism})`);
  finish('OK claude talker relay proven: answered + proposed(nothing sent) + released(verbatim into the claude worker transcript)');
}

main().catch((e) => finish(`FAILED ${e instanceof Error ? e.message : String(e)}`));
