#!/usr/bin/env node
/**
 * P27 Phase B — the talker surface over the REAL WebSocket transport on a
 * DISPOSABLE validation server (never production).
 *
 * Covers the rows that need the wire:
 *   14  receipt ack rides the wire exactly once per batch; release ack on confirm
 *   16  /api/v1/diagnostics: lanes present by default, recentTurns OPT-IN
 *       (?voiceConversation=n, bounded, clamped); "voice turn pi:<worker>"
 *       greppable in the server log
 *   17  WIRE REPRO: a `proposed` talker_turn_result carries NO `proposal`
 *       object (text/cleaned/removed) — the P26 field the confirmation card
 *       reads is never sent, so the card falls back to the RAW utterance and
 *       claims "your words, exactly" while the release is tidied
 *   18  Confirm / Cancel / typed-text over the wire; Cancel (the client's
 *       exact CANCEL_UTTERANCE) clears the card and the P25 regression shape
 *       ("no, cancel that" must not re-draft a residue)
 *   9   PRIMARY INVARIANT at the transport boundary: released.text ==
 *       expected relay form, and the worker transcript receives EXACTLY those
 *       bytes (byte-compare against the session JSONL)
 *   19  digest path with spokenPrefix: summary/headlines never repeat the
 *       already-spoken prefix (real model)
 *
 * Usage (server must be up; see repo docs):
 *   node scripts/p27-ws-transport-validate.mjs --base http://localhost:3907 \
 *     --password validation-pass [--out /tmp/p27-evidence/phaseB.json]
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

const base = flag('base', 'http://localhost:3907');
const password = flag('password', process.env.WS_VALIDATE_PASSWORD ?? 'validation-pass');
const origin = flag('origin', 'https://tmux.letsautomate.work');
const outPath = flag('out', '/tmp/p27-evidence/phaseB.json');
const serverLog = flag('server-log', '/tmp/p27-ws-server.log');
const timeoutMs = Number(flag('timeout', '180000'));

const RECEIPT_ACK = 'Noted — still holding that.';
const RELEASE_ACK = 'sending that now';
const NOTHING_PENDING = "Nothing is held right now, so there is nothing to send. Say the instruction and I'll hold it for your go-ahead.";

const rows = [];
function record(row, drove, observed, ok) {
  rows.push({ row, verdict: ok ? 'PASS' : 'FAIL', drove, observed });
  console.log(`${ok ? '✅' : '❌'} [${row}] ${observed}`);
}

const frames = [];
const waiters = [];
let ws = null;

function send(obj) { ws.send(JSON.stringify(obj)); }

function waitFor(pred, label, ms = timeoutMs) {
  return new Promise((resolve, reject) => {
    const existing = frames.find((f) => { try { return pred(f); } catch { return false; } });
    if (existing) { resolve(existing); return; }
    const w = { pred, resolve, reject, label };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, ms);
  });
}

async function talkerTurn(requestId, utterance, workerSessionId, label) {
  send({ type: 'talker_turn', workerSessionId, utterance, runtime: 'pi', requestId });
  const msg = await waitFor(
    (m) => m.type === 'talker_turn_result' && m.requestId === requestId,
    `talker_turn_result ${requestId} (${label})`,
    150000,
  );
  return msg;
}

async function main() {
  // ── login + connect ──
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
    frames.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      let matched = false;
      try { matched = waiters[i].pred(msg); } catch { matched = false; }
      if (matched) {
        const w = waiters.splice(i, 1)[0];
        i--;
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await waitFor((m) => m.type === 'authenticated', 'authenticated');

  // ── disposable pi worker ──
  send({ type: 'new_session', requestId: 'ns1' });
  const created = await waitFor((m) => m.type === 'session_created' && m.requestId === 'ns1', 'session_created');
  const workerSessionId = created.sessionPath;
  if (!workerSessionId) throw new Error('session_created without sessionPath');
  console.log(`worker session: ${workerSessionId}`);

  // Make the worker BUSY so the confirmed release exercises the mid-run steer.
  send({
    type: 'prompt',
    sessionId: workerSessionId,
    message:
      'Run exactly 4 Bash calls strictly one at a time (never batch them), each running: sleep 12. ' +
      'Only after all four have finished, reply with exactly: P27-WS-SLOW-DONE',
  });
  await waitFor((m) => m.type === 'session_event' && m.event?.type === 'agent_start', 'worker busy (agent_start)', 120000);
  console.log('worker busy on slow task');

  // w1 — stray confirmation with nothing held → mechanical dead end, no model call.
  const w1 = await talkerTurn('w1', 'yes, go ahead', workerSessionId, 'nothing-pending');
  record('18a-wire', '"yes, go ahead" with nothing held',
    `reply=${JSON.stringify(w1.reply)} phase=${w1.phase}`,
    w1.reply === NOTHING_PENDING && w1.phase === 'answered');

  // w2 — messy instruction → proposed; receipt ack on the wire; ROW 17 REPRO:
  // the `proposal` object (text/cleaned/removed) the P26 card reads is ABSENT.
  const messy = 'Um okay, could you ask the worker to reply with exactly P27-WS-RELAY';
  const w2 = await talkerTurn('w2', messy, workerSessionId, 'proposed');
  const hasProposal = Object.prototype.hasOwnProperty.call(w2, 'proposal');
  record('14-wire', `"${messy}" (opens the batch)`,
    `phase=${w2.phase} receiptAck=${JSON.stringify(w2.receiptAck ?? null)}`,
    w2.phase === 'proposed' && w2.receiptAck === RECEIPT_ACK);
  record('17-wire-REPRO', 'inspect the proposed result for the P26 card contract',
    `wire result keys=${JSON.stringify(Object.keys(w2))} — has proposal object: ${hasProposal}`,
    hasProposal === false);

  // w3 — the client's exact CANCEL_UTTERANCE → cancelled; card source cleared.
  const w3 = await talkerTurn('w3', 'no, cancel that', workerSessionId, 'cancel');
  record('18b-wire', 'CANCEL_UTTERANCE "no, cancel that"',
    `phase=${w3.phase} cancelled=${w3.cancelled} reply=${JSON.stringify(w3.reply.slice(0, 80))}`,
    w3.cancelled === true);

  // w4 — P25 regression shape: after that cancel, "yes" must find NOTHING
  // (the cancel must not have re-drafted its own tail as a fresh proposal).
  const w4 = await talkerTurn('w4', 'yes', workerSessionId, 'post-cancel-yes');
  record('18c-wire', '"yes" right after the cancel (P25 card-regression shape)',
    `reply=${JSON.stringify(w4.reply.slice(0, 90))}`,
    w4.reply.startsWith('Nothing is held right now'));

  // w5 — instruction again → proposed (release candidate).
  const instruction = 'tell the worker to reply with exactly P27-WS-RELAY once it finishes';
  const w5 = await talkerTurn('w5', instruction, workerSessionId, 'proposed-2');
  record('18d-wire', `"${instruction}"`,
    `phase=${w5.phase}`,
    w5.phase === 'proposed');

  // w6 — the client's exact CONFIRM_UTTERANCE → released.
  const w6 = await talkerTurn('w6', 'yes, send that', workerSessionId, 'released');
  const releasedText = w6.released?.text ?? null;
  const delivery = w6.released?.delivery ?? null;
  record('18e-wire', 'CONFIRM_UTTERANCE "yes, send that"',
    `phase=${w6.phase} ack=${JSON.stringify(w6.reply)} released=${JSON.stringify(releasedText)} delivery=${JSON.stringify(delivery)}`,
    w6.phase === 'released' && w6.reply === RELEASE_ACK && releasedText === 'reply with exactly P27-WS-RELAY once it finishes'
      && delivery?.outcome === 'delivered');

  // Row 9 at the transport boundary: find the worker transcript and byte-compare.
  const validationDir = flag('dir', '/tmp/p27-ws');
  function findSessionFile(dir) {
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { try { walk(p); } catch { /* skip */ } }
        else if (e.name.endsWith('.jsonl') && p.includes(path.basename(workerSessionId).slice(0, 12))) hits.push(p);
      }
    };
    try { walk(dir); } catch { /* missing dir */ }
    return hits;
  }
  const candidates = findSessionFile(validationDir);
  let transcriptHasExactBytes = false;
  let transcriptEvidence = 'session file not found';
  for (const f of candidates) {
    const content = fs.readFileSync(f, 'utf8');
    if (content.includes('P27-WS-RELAY')) {
      const lines = content.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const userMsgs = lines.filter((l) => l?.type === 'message' && l.message?.role === 'user').map((l) => l.message);
      const landed = userMsgs.some((m) => {
        const c = m.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
        return text.trimEnd() === releasedText;
      });
      transcriptHasExactBytes = landed;
      transcriptEvidence = `${f}: ${userMsgs.length} user messages, exact-byte match=${landed}`;
      break;
    }
  }
  record('9-wire', 'byte-compare released.text against the worker transcript',
    `released=${JSON.stringify(releasedText)}; ${transcriptEvidence}`,
    transcriptHasExactBytes);

  // Malformed talker_turn → honest protocol error.
  send({ type: 'talker_turn', requestId: 'w7' });
  const w7 = await waitFor((m) => m.type === 'error' && m.requestId === 'w7', 'malformed error');
  record('18f-wire', 'malformed talker_turn (missing fields)',
    `error code=${w7.code} message=${JSON.stringify(w7.message)}`,
    w7.code === 'INVALID_MESSAGE');

  // Row 19 — digest with spokenPrefix (real model): never repeat what was heard.
  const longText = Array.from({ length: 8 }, (_, i) =>
    `Item ${i + 1}: the release pipeline stage ${i + 1} completed with no errors and produced verified artefacts for review.`).join(' ');
  send({
    type: 'talker_digest', workerSessionId, kind: 'summary', text: longText,
    spokenPrefix: 'The release pipeline is running smoothly today.', runtime: 'pi', requestId: 'd1',
  });
  const d1 = await waitFor((m) => m.type === 'talker_digest_result' && m.requestId === 'd1', 'digest summary', 120000);
  const digestRepeats = d1.digest != null && d1.digest.includes('The release pipeline is running smoothly today.');
  record('19a-wire', 'talker_digest summary with spokenPrefix',
    `digest=${JSON.stringify((d1.digest ?? '').slice(0, 140))} refused=${d1.refused ?? 'no'} repeatsPrefix=${digestRepeats}`,
    typeof d1.digest === 'string' && d1.digest.length > 0 && !digestRepeats);

  send({
    type: 'talker_digest', workerSessionId, kind: 'headlines', text: longText,
    spokenPrefix: longText.slice(0, 120), runtime: 'pi', requestId: 'd2',
  });
  const d2 = await waitFor((m) => m.type === 'talker_digest_result' && m.requestId === 'd2', 'digest headlines', 120000);
  record('19b-wire', 'talker_digest headlines',
    `digest=${JSON.stringify((d2.digest ?? '').slice(0, 140))} length=${(d2.digest ?? '').length}`,
    typeof d2.digest === 'string' && d2.digest.length > 0 && d2.digest.length <= 400);

  // Row 16 — diagnostics route: lanes by default; recentTurns ONLY behind opt-in.
  // The diagnostics route lives on the Internal API (unix socket + bearer
  // token), not the browser HTTP port — query it the way agents do.
  const { execSync } = await import('node:child_process');
  const socketPath = flag('socket', '/tmp/p27-ws/internal-api.sock');
  const tokenPath = flag('token', '/tmp/p27-ws/internal-api-token');
  const diag = (q) => {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    const raw = execSync(
      `curl -s --unix-socket ${socketPath} -H "Authorization: Bearer ${token}" "http://localhost/api/v1/diagnostics${q}"`,
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    return JSON.parse(raw);
  };
  const def = diag('');
  const voiceDefault = def.voiceMode ?? {};
  record('16b-route', 'GET /api/v1/diagnostics (no opt-in)',
    `voice.lanes=${JSON.stringify(voiceDefault.lanes ?? null)?.slice(0, 160)} recentTurns key present: ${'recentTurns' in voiceDefault}`,
    Array.isArray(voiceDefault.lanes) && voiceDefault.lanes.some((l) => l.workerSessionId === workerSessionId)
      && !('recentTurns' in voiceDefault));

  const opt2 = diag('?voiceConversation=2');
  const turns2 = opt2.voiceMode?.recentTurns ?? null;
  const bounded = Array.isArray(turns2) && turns2.length <= 2 && turns2.length > 0
    && turns2.every((t) => typeof t.utteranceExcerpt === 'string' && t.utteranceExcerpt.length <= 500);
  record('16c-route', 'GET /api/v1/diagnostics?voiceConversation=2',
    `recentTurns=${turns2?.length} excerpts bounded=${bounded} last utterance=${JSON.stringify(turns2?.at(-1)?.utteranceExcerpt?.slice(0, 60))}`,
    bounded);

  const optBig = diag('?voiceConversation=99999');
  const turnsBig = optBig.voiceMode?.recentTurns ?? [];
  record('16d-route', 'GET /api/v1/diagnostics?voiceConversation=99999 (clamp)',
    `recentTurns=${turnsBig.length} (ring cap 50)`,
    turnsBig.length <= 50 && turnsBig.length >= turns2.length);

  // Row 16 — log line names the worker session (greppable without JSON).
  let logLineOk = false;
  try {
    const log = fs.readFileSync(serverLog, 'utf8');
    logLineOk = log.includes(`voice turn pi:${workerSessionId}`) && log.includes(`voice release pi:${workerSessionId}`);
  } catch { logLineOk = false; }
  record('16e-log', `grep ${path.basename(serverLog)} for "voice turn pi:<worker>"`,
    `turn line present + release line present: ${logLineOk}`,
    logLineOk);

  ws.close();
  const fails = rows.filter((r) => r.verdict === 'FAIL');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ workerSessionId, rows }, null, 2));
  console.log(`\nrows: ${rows.length}, PASS: ${rows.length - fails.length}, FAIL: ${fails.length} → ${outPath}`);
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('P27 PHASE B FAILED:', err.message);
  console.error(JSON.stringify({ lastFrames: frames.slice(-4) }, null, 2).slice(0, 2000));
  process.exit(1);
});
