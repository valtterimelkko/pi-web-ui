#!/usr/bin/env node
/**
 * Browser-WebSocket live validation — drive a session over the exact same
 * authenticated WebSocket path the browser UI uses (cookie login + /ws).
 *
 * This is the third live-validation option (see docs/LIVE-VALIDATION.md).
 * Use it to validate behaviours that only exist on the browser path and are
 * invisible to the Internal API:
 *   - extension slash commands and their `notification` toasts
 *   - the browser-native `compact` message (the UI intercepts `/compact`
 *     client-side and sends {type:'compact'}, not a prompt)
 *   - any WebSocket protocol message in shared/src/protocol-types.ts
 *
 * Always target a DISPOSABLE validation server (npm run validate:server),
 * never production, unless the user explicitly authorised production.
 * The validation server must be booted with a known AUTH_PASSWORD; when
 * NODE_ENV=production (common because of .env), it must be a bcrypt hash:
 *
 *   HASH=$(node -e "console.log(require('bcrypt').hashSync('validation-pass',10))")
 *   AUTH_PASSWORD="$HASH" npm run validate:server -- --dir /tmp/pi-vc --port 3093 \
 *     --claude-ws-port 43210 --claude-hook-port 43211 --opencode-port 44197
 *
 * Usage:
 *   node scripts/ws-validate.mjs --session <sessionPath> --step <step> [--text "..."]
 *     [--base http://localhost:3093] [--password validation-pass]
 *     [--origin https://tmux.letsautomate.work] [--timeout 90000]
 *     [--ws-url ws://host:port/ws]   # override the WS endpoint only (login
 *                                    # still goes to --base) — used by the
 *                                    # talker fault-injection drop proxy
 *
 * Steps:
 *   command  Send --text as-is (e.g. "/autocompact75"); succeeds on the first
 *            `notification` received AFTER the command was sent (session-start
 *            notifications from other extensions are recorded but ignored).
 *            Pass --expect <substring> to only accept a matching notification.
 *            Extension commands run without an LLM turn.
 *   prompt   Send --text as an LLM prompt; succeeds on `agent_end`.
 *   compact  Send the browser-native {type:'compact'} message; succeeds on a
 *            clean `compaction_end` / `compaction_result`.
 *   talker   Browser↔server talker transport probe (no --session/--text):
 *            creates a disposable Pi worker session over the socket, makes it
 *            BUSY on a slow task, then drives the full talker_turn /
 *            talker_turn_result scenario — conversational turn (answered),
 *            instruction turn (proposed, nothing sent), confirm turn
 *            (released; the operator's VERBATIM utterance must land in the
 *            worker transcript byte-for-byte, mid-run), and a malformed turn
 *            (rejected with 'Invalid talker_turn message format'). Every raw
 *            frame is captured in the output under `probe.frames`. Needs
 *            TALKER_API_KEY / OPENROUTER_API_KEY in the SERVER's environment.
 *   resume   Send --text as an LLM prompt and require the auto-compact-75
 *            resume chain: a compaction must fire during/after the run and the
 *            agent must then continue on its own (an assistant message_end
 *            after compaction_end, then agent_end). Fails fast if the run
 *            completes with no compaction. Use a session seeded past the 75%
 *            threshold and a prompt that forces tool use.
 *
 * Output: one JSON object with `verdict` ("OK ..." exit 0, otherwise exit 1)
 * and the captured `events` as evidence. Paste that JSON into your report.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const sessionPath = flag('session');
const step = flag('step');
const text = flag('text', '');
const expect = flag('expect', '');
const base = flag('base', 'http://localhost:3093');
const password = flag('password', process.env.WS_VALIDATE_PASSWORD ?? 'validation-pass');
// Origin must be in the server's allowed-origins list (see startup log line
// "Allowed origins: ..."). The production .env value is the usual default.
const origin = flag('origin', 'https://tmux.letsautomate.work');
const wsUrl = flag('ws-url', '');
const timeoutMs = Number(
  flag('timeout', step === 'prompt' ? '120000' : step === 'resume' || step === 'talker' ? '420000' : '90000'),
);

if (!['command', 'prompt', 'compact', 'resume', 'talker'].includes(step ?? '')) {
  console.error('Usage: ws-validate.mjs --session <sessionPath> --step command|prompt|compact|resume [--text "..."] | --step talker');
  process.exit(2);
}
if (step !== 'talker' && !sessionPath) {
  console.error('--session <sessionPath> is required for this step (only the talker step creates its own session)');
  process.exit(2);
}
if (step === 'talker' && sessionPath) {
  console.error('--step talker creates its own worker session; do not pass --session');
  process.exit(2);
}
if ((step === 'command' || step === 'prompt' || step === 'resume') && !text) {
  console.error(`--text is required for step "${step}"`);
  process.exit(2);
}

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.error(
    `login failed: ${login.status} ${await login.text()} — boot the validation server with a known AUTH_PASSWORD (bcrypt hash when NODE_ENV=production; see header comment)`,
  );
  process.exit(1);
}
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const ws = new WebSocket(wsUrl || `${base.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin } });
const events = [];
let done = false;
let sent = false;
let compactionStarted = false;
let compactionEnded = false;
let assistantAfterCompaction = false;

function finish(verdict, extra = {}) {
  if (done) return;
  done = true;
  console.log(JSON.stringify({ verdict, step, sessionPath, events, ...extra }, null, 1));
  ws.close();
  process.exit(verdict.startsWith('OK') ? 0 : 1);
}

setTimeout(() => finish(`TIMEOUT after ${timeoutMs}ms`), timeoutMs);

ws.on('error', (e) => finish(`WS ERROR: ${e.message} — is the validation server up and the origin allowed?`));

// ── talker step (browser↔server talker transport probe) ────────────────────
// Scenario mirrors scripts/talker-live-validate.ts (the proven server-side
// H6 validation) but drives EVERYTHING through the authenticated WebSocket
// path the browser uses: session creation, the busy prompt, and the
// talker_turn / talker_turn_result pair. Raw frames are captured verbatim.

const TALKER = {
  slowPrompt:
    'Run exactly 4 Bash calls strictly one at a time (never batch them), each running: sleep 15 . ' +
    'Only after all four have finished, reply with exactly: SLOW-TASK-DONE',
  conversational: 'how is the worker doing right now?',
  instruction:
    'Please tell the worker to reply with exactly TALKER-RELAY-OK once it finishes the current task.',
  confirm: 'yes, go ahead',
  marker: 'TALKER-RELAY-OK',
  releaseAck: 'sending that now', // fixed RELEASE_ACK (server/src/talker/ack.ts)
};

const talkerProbe = { frames: [], waiters: [], proofs: {} };

function talkerSend(obj) {
  const frame = JSON.stringify(obj);
  talkerProbe.frames.push({ dir: 'sent', frame });
  ws.send(frame);
}

function talkerWait(label, predicate, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { label, predicate, timer: null };
    waiter.timer = setTimeout(() => {
      const i = talkerProbe.waiters.indexOf(waiter);
      if (i !== -1) talkerProbe.waiters.splice(i, 1);
      finish(`FAILED timeout (${timeoutMs}ms) waiting for ${label}`, { probe: talkerProbe });
    }, timeoutMs);
    talkerProbe.waiters.push(waiter);
    // Resolve from handleTalkerMessage when a matching frame arrives.
    waiter.resolve = (msg) => resolve(msg);
  });
}

function handleTalkerMessage(msg) {
  talkerProbe.frames.push({ dir: 'recv', frame: JSON.stringify(msg) });
  for (let i = 0; i < talkerProbe.waiters.length; i++) {
    const waiter = talkerProbe.waiters[i];
    let matched = false;
    try { matched = waiter.predicate(msg); } catch { matched = false; }
    if (matched) {
      clearTimeout(waiter.timer);
      talkerProbe.waiters.splice(i, 1);
      waiter.resolve(msg);
      return;
    }
  }
}

/** Worker-transcript user messages, read from the session JSONL on disk
 *  (same host as the disposable validation server — mirrors
 *  talker-live-validate.ts readUserMessages). */
function readTranscriptUserTexts(sessionFile) {
  const out = [];
  for (const line of fs.readFileSync(sessionFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'message' || entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    const textContent = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join(' ')
        : '';
    out.push(textContent);
  }
  return out;
}

async function runTalkerProbe() {
  const proofs = talkerProbe.proofs;

  // 1. Create the disposable Pi worker session over the socket.
  await talkerWait('authenticated', (m) => m.type === 'authenticated', 30000);
  talkerSend({ type: 'new_session', requestId: 'ns1' });
  const created = await talkerWait(
    'session_created (ns1)',
    (m) => m.type === 'session_created' && m.requestId === 'ns1',
    60000,
  );
  const sessionPath = created.sessionPath;
  if (!sessionPath) finish('FAILED session_created without sessionPath', { probe: talkerProbe });
  proofs.workerSession = { sdkType: created.sdkType, sessionPath };

  // 2. Make the worker BUSY on a slow multi-step task.
  talkerSend({ type: 'prompt', sessionId: sessionPath, message: TALKER.slowPrompt });
  await talkerWait(
    'worker agent_start (busy)',
    (m) => m.type === 'session_event' && m.event?.type === 'agent_start',
    120000,
  );
  proofs.workerBusy = true;

  // 3. Conversational turn — the talker model must actually answer.
  talkerSend({ type: 'talker_turn', workerSessionId: sessionPath, utterance: TALKER.conversational, runtime: 'pi', requestId: 't1' });
  const r1 = await talkerWait(
    'talker_turn_result (t1, conversational) — no result means a silent drop',
    (m) => m.type === 'talker_turn_result' && m.requestId === 't1',
    120000,
  );
  if (r1.workerSessionId !== sessionPath) {
    finish(`FAILED t1 result session mismatch: ${r1.workerSessionId}`, { probe: talkerProbe });
  }
  if (r1.phase !== 'answered' || !r1.reply || !r1.reply.trim()) {
    finish(`FAILED t1 conversational turn: phase=${r1.phase}, reply=${JSON.stringify(r1.reply)}`, { probe: talkerProbe });
  }
  proofs.conversational = { phase: r1.phase, replyPreview: r1.reply.slice(0, 120) };

  // 4. Instruction turn — a proposal must be raised, NOTHING relayed.
  talkerSend({ type: 'talker_turn', workerSessionId: sessionPath, utterance: TALKER.instruction, runtime: 'pi', requestId: 't2' });
  const r2 = await talkerWait(
    'talker_turn_result (t2, instruction)',
    (m) => m.type === 'talker_turn_result' && m.requestId === 't2',
    120000,
  );
  if (r2.phase !== 'proposed' || r2.released !== null) {
    finish(`FAILED t2 instruction turn: phase=${r2.phase}, released=${JSON.stringify(r2.released)}`, { probe: talkerProbe });
  }
  // Nothing-sent proof: the worker transcript must not contain the relay yet.
  const beforeConfirm = readTranscriptUserTexts(sessionPath);
  if (beforeConfirm.some((t) => t.includes(TALKER.marker))) {
    finish('FAILED gate breach: relay marker present in worker transcript BEFORE confirmation', { probe: talkerProbe });
  }
  proofs.proposal = { phase: r2.phase, transcriptUserMessagesBeforeConfirm: beforeConfirm.length, markerInTranscriptBeforeConfirm: false };

  // 5. Confirm turn — the gate releases the operator's VERBATIM utterance.
  talkerSend({ type: 'talker_turn', workerSessionId: sessionPath, utterance: TALKER.confirm, runtime: 'pi', requestId: 't3' });
  const r3 = await talkerWait(
    'talker_turn_result (t3, confirm)',
    (m) => m.type === 'talker_turn_result' && m.requestId === 't3',
    120000,
  );
  if (r3.phase !== 'released' || !r3.released) {
    finish(`FAILED t3 confirm turn: phase=${r3.phase}, released=${JSON.stringify(r3.released)}`, { probe: talkerProbe });
  }
  if (r3.released.text !== TALKER.instruction) {
    finish(`FAILED t3 release text mismatch: ${JSON.stringify(r3.released.text)}`, { probe: talkerProbe });
  }
  if (r3.released.delivery?.outcome !== 'delivered') {
    finish(`FAILED t3 delivery not delivered: ${JSON.stringify(r3.released.delivery)}`, { probe: talkerProbe });
  }
  if (r3.released.delivery?.mechanism !== 'steer') {
    finish(`FAILED t3 expected mid-run steer (worker was busy), got mechanism=${r3.released.delivery?.mechanism}`, { probe: talkerProbe });
  }
  proofs.release = {
    phase: r3.phase,
    ack: r3.reply,
    delivery: r3.released.delivery,
    releasedTextBytes: Buffer.byteLength(r3.released.text, 'utf8'),
  };

  // 6. Wait for the worker run to finish, then prove byte-for-byte arrival.
  await talkerWait(
    'worker agent_end (run finished after steer)',
    (m) => m.type === 'session_event' && m.event?.type === 'agent_end',
    300000,
  );
  const receivedTexts = readTranscriptUserTexts(sessionPath);
  const markerMessages = receivedTexts.filter((t) => t.includes(TALKER.marker));
  if (markerMessages.length === 0) {
    finish('FAILED relayed instruction never appeared in the worker transcript', { probe: talkerProbe });
  }
  const sentBuf = Buffer.from(TALKER.instruction, 'utf8');
  const exactMatch = markerMessages.find((t) => sentBuf.equals(Buffer.from(t, 'utf8')));
  if (!exactMatch) {
    finish(
      `FAILED byte-for-byte mismatch: operator sent ${sentBuf.byteLength} bytes ${JSON.stringify(TALKER.instruction)}; transcript has ${JSON.stringify(markerMessages)}`,
      { probe: talkerProbe },
    );
  }
  // Ordering proof: the steered message must have arrived MID-RUN (worker
  // activity after the steer entry), not after the run ended.
  const roleTexts = [];
  for (const line of fs.readFileSync(sessionPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== 'message' || !e.message) continue;
      const c = e.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c)
        ? c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join(' ')
        : '';
      roleTexts.push({ role: e.message.role, text: t });
    } catch { /* skip */ }
  }
  const steerIdx = roleTexts.findIndex((e) => e.role === 'user' && sentBuf.equals(Buffer.from(e.text, 'utf8')));
  const lastAssistantIdx = roleTexts.map((e) => e.role).lastIndexOf('assistant');
  proofs.byteForByte = {
    method: 'Buffer.equals on UTF-8 bytes of the operator utterance vs the transcript user message',
    sentBytes: sentBuf.byteLength,
    receivedBytes: Buffer.byteLength(exactMatch, 'utf8'),
    equal: true,
    receivedCount: markerMessages.length,
    midRunOrdering: { steerEntryIndex: steerIdx, lastAssistantIndex: lastAssistantIdx, continuedAfterSteer: lastAssistantIdx > steerIdx },
    finalAssistantTextPreview: (roleTexts[lastAssistantIdx]?.text ?? '').slice(0, 120),
  };
  if (!(steerIdx >= 0 && lastAssistantIdx > steerIdx)) {
    finish('FAILED steering arrived without mid-run worker activity (ordering proof)', { probe: talkerProbe });
  }

  // 7. Transport honesty: a malformed talker_turn is rejected, connection stays usable.
  talkerSend({ type: 'talker_turn', workerSessionId: sessionPath, requestId: 't4' }); // utterance missing → guard must reject
  const malformedError = await talkerWait(
    'error frame for malformed talker_turn (t4)',
    (m) => m.type === 'error' && m.requestId === 't4',
    30000,
  );
  if (malformedError.message !== 'Invalid talker_turn message format' || malformedError.code !== 'INVALID_MESSAGE') {
    finish(`FAILED unexpected malformed-turn rejection: ${JSON.stringify(malformedError)}`, { probe: talkerProbe });
  }
  talkerSend({ type: 'ping', requestId: 'p1' });
  await talkerWait('pong after malformed rejection (connection survived)', (m) => m.type === 'pong', 15000);
  proofs.malformedTurn = { rejected: true, errorMessage: malformedError.message, errorCode: malformedError.code, connectionSurvived: true };

  finish('OK talker transport proven: answered + proposed(nothing sent) + released(verbatim, mid-run steer) + malformed rejected', { probe: talkerProbe });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const t = msg.type;

  if (step === 'talker') {
    handleTalkerMessage(msg);
    return;
  }

  if (t === 'authenticated') {
    // Bind this client to the session, exactly like opening it in the browser.
    ws.send(JSON.stringify({ type: 'switch_session', sessionPath }));
    setTimeout(() => {
      if (step === 'compact') {
        ws.send(JSON.stringify({ type: 'compact', sessionId: sessionPath }));
      } else {
        // 'prompt' and 'resume' both send a normal prompt; they differ in
        // what event sequence counts as success.
        ws.send(JSON.stringify({ type: 'prompt', sessionId: sessionPath, message: text }));
      }
      sent = true;
    }, 1500);
    return;
  }

  if (t === 'notification') {
    events.push({ notification: msg.notification, beforeSend: !sent || undefined });
    if (!sent) return; // session-start noise from other extensions
    if (expect && !msg.notification.message.includes(expect)) return;
    if (step === 'command') finish('OK notification received');
    if (step === 'compact' && /compaction failed|summarization failed/i.test(msg.notification.message)) {
      finish(`FAILED: ${msg.notification.message}`);
    }
    return;
  }

  if (t === 'compaction_result') {
    events.push({ compaction_result: msg });
    if (step === 'compact') finish(msg.error ? `FAILED compaction_result: ${msg.error}` : 'OK compaction_result');
    return;
  }

  if (t === 'error') {
    events.push({ error: msg });
    finish(`FAILED server error: ${msg.message ?? JSON.stringify(msg)}`);
    return;
  }

  if (t === 'session_event') {
    // Pi events are forwarded with their fields directly on `event`
    // (see server/src/pi/event-forwarder.ts), not under `event.data`.
    const e = msg.event ?? {};
    const et = e.type;
    if (['compaction_start', 'compaction_end', 'agent_end', 'extension_error'].includes(et)) {
      events.push({
        event: et,
        ...(et === 'compaction_start' ? { reason: e.reason } : {}),
        ...(et === 'compaction_end'
          ? { aborted: e.aborted, errorMessage: e.errorMessage, tokensBefore: e.result?.tokensBefore }
          : {}),
      });
    }
    if (step === 'resume') {
      // Success = compaction fired during the run AND the agent continued by
      // itself afterwards (assistant output post-compaction, then agent_end).
      if (et === 'turn_end') {
        events.push({ event: et, stopReason: e.message?.stopReason });
      }
      if (et === 'message_start' && e.message?.role === 'custom') {
        events.push({ event: et, role: 'custom', customType: e.message.customType });
      }
      if (et === 'compaction_start') compactionStarted = true;
      if (et === 'compaction_end') {
        if (e.errorMessage) finish(`FAILED compaction_end: ${e.errorMessage}`);
        else compactionEnded = true;
      }
      if (et === 'message_start' && compactionEnded && e.message?.role === 'assistant') {
        assistantAfterCompaction = true;
      }
      if (et === 'agent_end') {
        const msgs = Array.isArray(e.messages) ? e.messages : [];
        const lastAssistant = [...msgs].reverse().find((m) => m?.role === 'assistant');
        const textOf = (m) => Array.isArray(m?.content)
          ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 300)
          : undefined;
        events.push({
          event: et,
          lastAssistantStopReason: lastAssistant?.stopReason,
          lastAssistantText: textOf(lastAssistant),
        });
        if (compactionEnded && assistantAfterCompaction) {
          finish('OK resumed after compaction: agent continued and completed the task');
        } else if (!compactionStarted) {
          // Give compaction_start a grace window: ctx.compact() aborts the
          // run first, so this agent_end can race ahead of compaction_start.
          setTimeout(() => {
            if (!compactionStarted) {
              finish('FAILED: agent run completed without any compaction — threshold never fired');
            }
          }, 20000);
        }
        // else: this agent_end belongs to the run the compaction aborted;
        // keep waiting for the auto-resumed run.
      }
      return;
    }
    if (step === 'prompt' && et === 'agent_end') finish('OK agent_end');
    if (step === 'compact' && et === 'compaction_end') {
      finish(e.errorMessage || e.aborted
        ? `FAILED compaction_end: ${JSON.stringify({ aborted: e.aborted, errorMessage: e.errorMessage })}`
        : 'OK compaction_end');
    }
  }
});

// Talker probe kick-off — deliberately AFTER the message handler is
// registered above: frames arriving before a listener exists would be lost,
// and the probe state must be initialised before the first frame is routed.
if (step === 'talker') {
  runTalkerProbe();
}
