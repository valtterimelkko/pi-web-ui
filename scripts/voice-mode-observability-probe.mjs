#!/usr/bin/env node
/**
 * P10 Voice Mode observability probe — drives a short voice conversation
 * through the REAL browser-WebSocket talker path on a DISPOSABLE validation
 * server, deliberately covering the gate-refusal signatures the design's
 * verification section demands:
 *
 *   t1  a stray confirmation with nothing held  → gate refusal (nothing_pending)
 *   t2  an instruction (opens the draft)        → proposed
 *   t3  "no, forget it"                         → cancelled (cancel_classified)
 *   t4  the instruction again                   → proposed
 *   t5  "yes, go ahead"                         → released (adapter verdict recorded)
 *
 * Read-only on product code: it only speaks the same talker_turn protocol the
 * browser speaks. The server-side trace is then retrieved via the documented
 * diagnostics path (see docs/OBSERVABILITY.md § Voice Mode observability).
 *
 * Usage:
 *   node scripts/voice-mode-observability-probe.mjs --base http://localhost:PORT \
 *        [--password validation-pass] [--timeout 60000]
 *
 * NEVER point this at production. Disposable validation servers only.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const base = flag('base', 'http://localhost:3093');
const password = flag('password', process.env.WS_VALIDATE_PASSWORD ?? 'validation-pass');
const origin = flag('origin', 'https://tmux.letsautomate.work');
const timeoutMs = Number(flag('timeout', '180000'));

const results = [];
const waiters = [];
let ws = null;

function send(obj) {
  ws.send(JSON.stringify(obj));
}

function waitFor(pred, label, ms = timeoutMs) {
  return new Promise((resolve, reject) => {
    const existing = results.find((r) => { try { return pred(r); } catch { return false; } });
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

async function talkerTurn(requestId, utterance, workerSessionId, phase) {
  send({ type: 'talker_turn', workerSessionId, utterance, runtime: 'pi', requestId });
  const msg = await waitFor(
    (m) => m.type === 'talker_turn_result' && m.requestId === requestId,
    `talker_turn_result ${requestId} (${phase})`,
    150000,
  );
  results.push({ probeStep: phase, result: msg });
  return msg;
}

async function main() {
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
    try { msg = JSON.parse(data.toString()); } catch { return; /* non-JSON frame */ }
    results.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i];
      let matched = false;
      try { matched = w.pred(msg); } catch { matched = false; }
      if (matched) {
        waiters.splice(i, 1);
        i--;
        w.resolve(msg);
      }
    }
  });

  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await opened;
  await waitFor((m) => m.type === 'authenticated', 'authenticated');

  // Disposable Pi worker session (path identity — the proven talker wiring).
  send({ type: 'new_session', requestId: 'ns1' });
  const created = await waitFor((m) => m.type === 'session_created' && m.requestId === 'ns1', 'session_created');
  const workerSessionId = created.sessionPath;
  if (!workerSessionId) throw new Error('session_created without sessionPath');

  const out = { workerSessionId, turns: {} };

  // Make the worker BUSY on a slow task so the confirmed release exercises
  // the mid-run steer mechanism (the proven fast-ack path; releasing into an
  // idle worker dispatches a full worker prompt whose dispatch latency is
  // dominated by the run itself).
  send({
    type: 'prompt',
    sessionId: workerSessionId,
    message:
      'Run exactly 4 Bash calls strictly one at a time (never batch them), each running: sleep 15. ' +
      'Only after all four have finished, reply with exactly: P10-SLOW-TASK-DONE',
  });
  await waitFor((m) => m.type === 'session_event' && m.event?.type === 'agent_start', 'worker busy (agent_start)', 120000);
  out.workerBusy = true;

  // t1 — stray confirmation, nothing held → mechanical refusal (no model call).
  const t1 = await talkerTurn('t1', 'yes, go ahead', workerSessionId, 'refused-nothing-pending');
  out.turns.refusal = { wirePhase: t1.phase, reply: t1.reply };

  // t2 — instruction opens the draft. The fake key exercises the scrubber:
  // it must reach the worker verbatim but appear as [REDACTED] in the ring.
  const instruction =
    'use key sk-p10fakekey1234567890 and then tell the worker to reply with exactly P10-OBS-OK';
  const t2 = await talkerTurn('t2', instruction, workerSessionId, 'proposed');
  out.turns.proposed = { wirePhase: t2.phase, receiptAck: t2.receiptAck ?? null };

  // t3 — cancel the held draft.
  const t3 = await talkerTurn('t3', 'no, forget it', workerSessionId, 'cancelled');
  out.turns.cancelled = { wirePhase: t3.phase, cancelled: t3.cancelled };

  // t4 — the instruction again.
  const instruction2 = 'tell the worker to reply with exactly P10-OBS-OK once it finishes';
  const t4 = await talkerTurn('t4', instruction2, workerSessionId, 'proposed-2');
  out.turns.proposed2 = { wirePhase: t4.phase };

  // t5 — confirm → release; the delivery adapter's own verdict comes back.
  const t5 = await talkerTurn('t5', 'yes, go ahead', workerSessionId, 'released');
  out.turns.released = {
    wirePhase: t5.phase,
    releasedText: t5.released?.text ?? null,
    delivery: t5.released?.delivery ?? null,
    ack: t5.reply,
  };

  console.log(JSON.stringify(out, null, 2));
  ws.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('PROBE FAILED:', err.message);
    console.error(JSON.stringify({ lastFrames: results.slice(-6) }, null, 2));
    process.exit(1);
  },
);
