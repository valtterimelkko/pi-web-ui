/**
 * P9 bisect probe — proves WHERE the UI release failure comes from.
 *
 * Finding under test: the Voice Mode UI sends `workerSessionId` = the session
 * ID (UUID) that the server itself issued in `session_created`; the pi delivery
 * adapter resolves that value against MultiSessionManager, which is keyed by
 * session PATH (multi-session-manager.ts:708/849) — so release is refused with
 * "Session <uuid> does not exist". Earlier server-side validations passed the
 * PATH in the same parameter (talker-live-validate.ts:150,
 * voice-relay-scenarios-validate.ts:439), which is why they never hit this.
 *
 * This probe repeats the exact UI conversation against the SAME disposable
 * server, differing ONLY in passing sessionPath (not sessionId) as
 * workerSessionId. If the gate/relay machinery then works end to end, the
 * defect is precisely the id-vs-path identity wiring.
 *
 * Evidence: prints each frame result, then byte-compares the instruction with
 * the worker transcript's user entry. Read-only on product code.
 */
import WebSocket from '/root/pi-web-ui/node_modules/ws/index.js';
import fs from 'node:fs';

const EVIDENCE = '/tmp/p9-evidence';
const cookieLine = fs.readFileSync(`${EVIDENCE}/cookies.txt`, 'utf8')
  .split('\n').find((l) => l.includes('accessToken'));
const f = cookieLine.split('\t');
const cookie = `${f[5].trim()}=${f[6].trim()}`;

const INSTRUCTION = process.argv[2] ?? 'Tell the worker to reply with exactly "pineapple" and nothing else.';

const ws = new WebSocket('ws://localhost:3777/ws', {
  headers: { Cookie: cookie, Origin: 'http://localhost:5173' },
});

const results = [];
let sessionPath = null;
let sessionId = null;
let step = 'connecting';
const waiters = [];

// Full frame log for ack-ordering evidence.
const framesLog = fs.createWriteStream('/tmp/p9-evidence/probe-ws-frames.jsonl', { flags: 'w' });
let frameSeq = 0;
const frames = [];
function logFrame(dir, data) {
  const entry = { seq: ++frameSeq, t: Date.now(), dir, payload: data.toString() };
  frames.push(entry);
  framesLog.write(JSON.stringify(entry) + '\n');
}
function firstFrameContaining(needle, afterSeq = 0) {
  for (const f of frames) {
    if (f.seq <= afterSeq) continue;
    if (f.payload.includes(needle)) return f;
  }
  return null;
}

function notify(type, msg) { results.push({ step, type, msg }); console.log(`[${step}] ${type}:`, JSON.stringify(msg).slice(0, 300)); }
function waitFor(pred, label, ms = 120000) {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve, label };
    waiters.push(w);
    const existing = results.find(({ type, msg }) => pred(type, msg));
    if (existing) { resolve(existing.msg); return; }
    setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
  });
}
function pump() {
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    const hit = [...results].reverse().find(({ type, msg }) => w.pred(type, msg));
    if (hit) { waiters.splice(i, 1); i--; w.resolve(hit.msg); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
  step = 'new_session';
  const payload = JSON.stringify({ type: 'new_session', cwd: '/tmp/p9-workdir', sdkType: 'pi' });
  logFrame('sent', Buffer.from(payload));
  ws.send(payload);
});

ws.on('message', (data) => {
  logFrame('received', data);
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === 'session_created') {
    sessionId = msg.sessionId;
    sessionPath = msg.sessionPath;
    notify('session_created', { sessionId, sessionPath });
    pump();
  } else if (msg.type === 'talker_turn_result') {
    notify('talker_turn_result', msg);
    pump();
  } else if (msg.type === 'error') {
    notify('error', msg);
    pump();
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });

function sendTalkerTurn(utterance) {
  step = `talker_turn(${utterance.slice(0, 40)}...)`;
  const payload = JSON.stringify({ type: 'talker_turn', workerSessionId: sessionPath, utterance, runtime: 'pi' });
  logFrame('sent', Buffer.from(payload));
  ws.send(payload);
}

try {
  await waitFor((t) => t === 'session_created', 'session_created', 30000);
  console.log('worker session path :', sessionPath);
  console.log('worker session id   :', sessionId, '(what the UI sends as workerSessionId)');

  // 1. The instruction.
  sendTalkerTurn(INSTRUCTION);
  await waitFor((t, m) => t === 'talker_turn_result' && m.phase === 'proposed', 'proposal');

  // 2. The explicit confirmation gesture (what the UI's Confirm button sends).
  sendTalkerTurn('yes, send that');
  let released = null;
  try {
    released = await waitFor((t, m) => t === 'talker_turn_result' && (m.phase === 'released' || m.phase === 'refused'), 'release', 45000);
  } catch {
    // Observed 2026-09-13: the released result frame only arrives when the
    // worker's ENTIRE turn completes (manager.prompt resolves then). A stalled
    // worker turn delays the frame indefinitely — the delivery itself may still
    // have happened. Check the transcript before declaring failure.
    console.log('no released result frame within 45s — checking transcript for actual delivery…');
  }
  console.log('released.delivery   :', JSON.stringify(released?.released?.delivery));
  console.log('released.text       :', JSON.stringify(released?.released?.text));

  // 3. Wait for the worker's answer in the transcript.
  console.log('waiting for worker turn…');
  let answerText = null;
  const deadline = Date.now() + 240000;
  let lastSize = -1, stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    let size = 0;
    try { size = fs.statSync(sessionPath).size; } catch { /* gone */ }
    if (size === lastSize) {
      if (stableSince && Date.now() - stableSince > 5000) {
        const raw = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const msgs = raw.filter((e) => e.type === 'message' && e.message?.role);
        const assistants = msgs.filter((e) => e.message.role === 'assistant');
        answerText = assistants.length ? assistants[assistants.length - 1] : null;
        break;
      }
      stableSince = Date.now();
    } else { stableSince = 0; lastSize = size; }
  }

  const raw = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const userEntries = raw.filter((e) => e.type === 'message' && e.message?.role === 'user');
  const workerUserText = userEntries.length
    ? (typeof userEntries[userEntries.length - 1].message.content === 'string'
      ? userEntries[userEntries.length - 1].message.content
      : userEntries[userEntries.length - 1].message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''))
    : null;

  const blen = (s) => (s == null ? null : Buffer.byteLength(s, 'utf8'));

  // Ack-ordering evidence from the frame log (successful full chain).
  const proposedResultFrame = frames.find((fr) => fr.dir === 'received' && fr.payload.includes('"phase":"proposed"'));
  const ackFrame = frames.find((fr) => fr.dir === 'received' && fr.payload.includes('"receiptAck"'));
  const releasedFrameEntry = frames.find((fr) => fr.dir === 'received' && fr.payload.includes('"phase":"released"'));
  let firstAnswerFrame = null;
  if (answerText) {
    const rawAnswer = typeof answerText === 'string' ? answerText : JSON.stringify(answerText);
    const needle = rawAnswer.replace(/^"|"$/g, '').slice(0, 12).replace(/["\\]/g, '');
    firstAnswerFrame = firstFrameContaining(needle, releasedFrameEntry?.seq ?? 0);
  }
  const ackOrdering = {
    instructionSentSeq: frames.find((fr) => fr.dir === 'sent' && fr.payload.includes('"talker_turn"'))?.seq ?? null,
    proposedResultSeq: proposedResultFrame?.seq ?? null,
    receiptAckSeq: ackFrame?.seq ?? null,
    confirmSentSeq: frames.filter((fr) => fr.dir === 'sent' && fr.payload.includes('"talker_turn"')).pop()?.seq ?? null,
    releasedResultSeq: releasedFrameEntry?.seq ?? null,
    firstAnswerFrameSeq: firstAnswerFrame?.seq ?? null,
    ackBeforeReleased: !!(ackFrame && releasedFrameEntry && ackFrame.seq < releasedFrameEntry.seq),
    releasedBeforeAnswer: firstAnswerFrame ? releasedFrameEntry.seq < firstAnswerFrame.seq : 'answer never appeared in WS frames',
  };

  const comparison = {
    instructionSent: INSTRUCTION,
    releasedTextServer: released?.released?.text ?? null,
    workerTranscriptUserText: workerUserText,
    byteCounts: {
      instructionSent: blen(INSTRUCTION),
      releasedTextServer: blen(released?.released?.text ?? null),
      workerTranscriptUserText: blen(workerUserText),
    },
    equalities: {
      instruction_eq_released: INSTRUCTION === (released?.released?.text ?? null),
      released_eq_worker: (released?.released?.text ?? null) === workerUserText,
      instruction_eq_worker: INSTRUCTION === workerUserText,
    },
    releasedResultFrameReceived: !!released,
    deliveryObservedInTranscript: workerUserText === INSTRUCTION,
    workerAnswerText: answerText ? JSON.stringify(answerText).slice(0, 400) : null,
    sessionPath,
    sessionId,
    ackOrdering,
  };
  console.log('---- byte-for-byte (workerSessionId = PATH) ----');
  fs.writeFileSync(`${EVIDENCE}/release-path-probe-result.json`, JSON.stringify(comparison, null, 2));
  framesLog.end();
  console.log(JSON.stringify({ byteCounts: comparison.byteCounts, equalities: comparison.equalities, ackOrdering: comparison.ackOrdering }, null, 2));
  process.exit(0);
} catch (err) {
  console.error('PROBE FAILED:', err.message);
  // Never overwrite a good result JSON with failure output.
  fs.writeFileSync(`${EVIDENCE}/release-path-probe-FAILED.json`, JSON.stringify({ failed: err.message, results }, null, 2));
  framesLog.end();
  process.exit(1);
}
