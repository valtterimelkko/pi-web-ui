/**
 * P9 — Voice Mode browser end-to-end driver.
 *
 * Drives the REAL UI (vite dev client) against a REAL disposable server and a
 * REAL pi worker session from a REAL Chromium, using Chrome's fake-audio-capture
 * file flag so the dictation pipeline (getUserMedia → MediaRecorder → server
 * STT → cleanup) receives genuine spoken audio.
 *
 * Evidence written to $P9_EVIDENCE_DIR (default /tmp/p9-evidence):
 *   ws-frames.jsonl     every WebSocket frame with timestamp + direction
 *   e2e-result.json     measured values + byte-for-byte comparisons
 *   NN-*.png            screenshots of each driven state
 *
 * Requires: P9_CONFIRM_PASSWORD in env (the disposable server's auth password).
 * Never logs the password.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE = process.env.P9_EVIDENCE_DIR ?? '/tmp/p9-evidence';
const BASE_URL = process.env.P9_BASE_URL ?? 'http://localhost:5173';
const PASSWORD = process.env.P9_CONFIRM_PASSWORD;
const WORKDIR = '/tmp/p9-workdir';
const AUDIO = process.env.P9_AUDIO ?? path.join(EVIDENCE, 'instruction.wav');
const RECORD_MS = Number(process.env.P9_RECORD_MS ?? 7000);

if (!PASSWORD) { console.error('P9_CONFIRM_PASSWORD not set'); process.exit(2); }
if (!fs.existsSync(AUDIO)) { console.error('audio file missing:', AUDIO); process.exit(2); }

fs.mkdirSync(EVIDENCE, { recursive: true });
const framesLog = fs.createWriteStream(path.join(EVIDENCE, 'ws-frames.jsonl'), { flags: 'w' });
let frameSeq = 0;
const frames = []; // {seq, t, dir, payload}
const result = { steps: {}, comparisons: {}, screenshots: [] };
let page;

function normalizeFrame(d) {
  if (d === null || d === undefined) return '';
  if (typeof d === 'string') return d;
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (typeof d === 'object' && 'payload' in d) {
    const p = d.payload;
    if (typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p.toString('utf8');
    if (Array.isArray(p)) return Buffer.from(p).toString('utf8');
    try { return JSON.stringify(p); } catch { return String(p); }
  }
  try { return JSON.stringify(d); } catch { return String(d); }
}

function logFrame(dir, d) {
  const entry = { seq: ++frameSeq, t: Date.now(), dir, payload: normalizeFrame(d) };
  frames.push(entry);
  framesLog.write(JSON.stringify(entry) + '\n');
}

function shot(name) {
  const file = path.join(EVIDENCE, name);
  return page.screenshot({ path: file, fullPage: false }).then(() => {
    result.screenshots.push(name);
    console.log('  screenshot:', name);
  });
}

function fail(stage, err) {
  result.steps[stage] = { ok: false, error: String(err) };
  fs.writeFileSync(path.join(EVIDENCE, 'e2e-result.json'), JSON.stringify(result, null, 2));
  if (page) {
    page.screenshot({ path: path.join(EVIDENCE, `ZZ-failed-${stage}.png`) }).catch(() => {});
  }
  console.error(`FAILED at ${stage}:`, err);
  process.exitCode = 1;
  throw err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Session transcript helpers (the driver reads the disposable server's own
// session files on disk — read-only evidence gathering).
// ---------------------------------------------------------------------------
function readTranscriptEntries(sessionPath) {
  const raw = fs.readFileSync(sessionPath, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function messageEntries(sessionPath) {
  return readTranscriptEntries(sessionPath).filter(
    (e) => e.type === 'message' && e.message && (e.message.role === 'user' || e.message.role === 'assistant')
  );
}

function entryText(entry) {
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  }
  return '';
}

// Extract the worker session path from the WS frame log (session_created).
function findSessionPathFromFrames() {
  for (const f of frames) {
    try {
      const m = JSON.parse(f.payload);
      if (m.type === 'session_created' && typeof m.sessionPath === 'string' && m.sessionPath.includes('/pi-sessions/')) {
        return { path: m.sessionPath, id: m.sessionId, sdkType: m.sdkType, frameSeq: f.seq };
      }
    } catch { /* not json */ }
  }
  return null;
}

// Find sent talker_turn utterances and received talker_turn_result frames.
function talkerFrames() {
  const sent = [];
  const received = [];
  for (const f of frames) {
    try {
      const m = JSON.parse(f.payload);
      if (f.dir === 'sent' && m.type === 'talker_turn') sent.push({ seq: f.seq, t: f.t, utterance: m.utterance, workerSessionId: m.workerSessionId, runtime: m.runtime });
      if (f.dir === 'received' && m.type === 'talker_turn_result') received.push({ seq: f.seq, t: f.t, ...m });
    } catch { /* not json */ }
  }
  return { sent, received };
}

function firstFrameContaining(needle, afterSeq = 0) {
  for (const f of frames) {
    if (f.seq <= afterSeq) continue;
    if (f.payload.includes(needle)) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${AUDIO}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
  });
  // Seed the uiStore's persisted recentFolders so the (localStorage-fed)
  // folder picker offers the disposable workdir. Client-local state only.
  await context.addInitScript((dir) => {
    localStorage.setItem('pi-web-ui-ui-store', JSON.stringify({
      state: { recentFolders: [{ path: dir, label: 'p9-workdir', count: 1, lastUsed: Date.now() }] },
      version: 0,
    }));
  }, WORKDIR);

  page = await context.newPage();
  page.on('websocket', (ws) => {
    console.log('ws opened:', ws.url());
    ws.on('framesent', (d) => logFrame('sent', d));
    ws.on('framereceived', (d) => logFrame('received', d));
    ws.on('close', () => console.log('ws closed:', ws.url()));
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200));
  });

  // --- Login ---------------------------------------------------------------
  console.log('step: login');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  try {
    await page.fill('#password', PASSWORD, { timeout: 8000 });
    await page.click('button[type="submit"]');
  } catch {
    // Already authenticated (persisted session) — continue.
  }
  await page.waitForSelector('button[aria-label="Enter Voice Mode"]', { timeout: 20000 });
  await shot('01-logged-in-main-ui.png');
  result.steps.login = { ok: true };

  // --- Open Voice Mode ------------------------------------------------------
  console.log('step: open voice mode');
  await page.click('button[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Start a new session"]', { timeout: 10000 });
  await shot('02-voice-mode-entry.png');
  result.steps.voiceModeEntry = { ok: true };

  // --- New session → model pick ---------------------------------------------
  console.log('step: model pick (Kimi for Coding, pi)');
  await page.click('button[aria-label="Start a new session"]');
  await page.waitForSelector('button:has-text("Kimi for Coding")', { timeout: 10000 });
  await shot('03-model-pick.png');
  await page.click('button:has-text("Kimi for Coding")');
  result.steps.modelPick = { ok: true, model: 'kimi-coding/kimi-for-coding (pi)' };

  // --- Folder pick ------------------------------------------------------------
  console.log('step: folder pick');
  await page.waitForSelector(`button:has-text("${WORKDIR}")`, { timeout: 10000 });
  await shot('04-folder-pick.png');
  await page.click(`button:has-text("${WORKDIR}")`);
  result.steps.folderPick = { ok: true, cwd: WORKDIR };

  // --- Dictate surface ---------------------------------------------------------
  console.log('step: wait for dictate surface');
  await page.waitForSelector('button[aria-label="Start recording"]', { timeout: 30000 });
  await sleep(1200); // let session_created + floor banner settle
  const sessionRef = findSessionPathFromFrames();
  if (!sessionRef) fail('session-bind', new Error('no session_created with a /pi-sessions/ path in frame log'));
  result.steps.workerSession = { ok: true, ...sessionRef };
  console.log('  worker session:', sessionRef.path, '(id', sessionRef.id + ')');
  await shot('05-dictate-idle.png');

  // --- Record the instruction (real audio file via fake capture) ---------------
  console.log('step: record instruction', `(${RECORD_MS}ms)`);
  await page.click('button[aria-label="Start recording"]');
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 10000 });
  await shot('06-recording.png');
  await sleep(RECORD_MS);
  await page.click('button[aria-label="Stop recording"]');
  result.steps.recordInstruction = { ok: true, recordMs: RECORD_MS, audio: AUDIO };

  // --- Proposal → confirmation card ---------------------------------------------
  console.log('step: wait for confirmation card (STT + cleanup + talker classify)');
  await page.waitForSelector('[data-testid="confirmation-card"]', { timeout: 120000 });
  const proposalShown = await page.textContent('[data-testid="pending-proposal-text"]');
  await sleep(1500); // let any in-flight transcript writes land before the snapshot

  // The worker's transcript must contain NOTHING at this point.
  const entriesAtProposal = messageEntries(sessionRef.path);
  const userEntriesAtProposal = entriesAtProposal.filter((e) => e.message.role === 'user');
  result.steps.proposal = {
    ok: true,
    proposalShown,
    workerTranscriptMessageEntries: entriesAtProposal.length,
    workerTranscriptUserEntries: userEntriesAtProposal.length,
  };
  console.log('  proposal shown:', JSON.stringify(proposalShown));
  console.log('  worker transcript message entries at proposal time:', entriesAtProposal.length,
    '| user entries:', userEntriesAtProposal.length);
  fs.writeFileSync(path.join(EVIDENCE, 'transcript-at-proposal.json'),
    JSON.stringify({ sessionPath: sessionRef.path, entries: readTranscriptEntries(sessionRef.path) }, null, 2));
  await shot('07-proposal-card.png');

  // --- Confirm → release → worker receives byte-for-byte ------------------------
  console.log('step: confirm release');
  await page.click('[data-testid="confirmation-card"] button:has-text("Confirm")');
  const confirmAt = { seq: frameSeq, t: Date.now() };
  await page.waitForSelector('[data-testid="released-outcome"]', { timeout: 60000 });
  const releasedShown = await page.textContent('[data-testid="released-outcome"]');
  result.steps.release = { ok: true, releasedShown };
  console.log('  released banner:', JSON.stringify(releasedShown));
  await shot('08-released.png');

  // --- Wait for the worker's answer ----------------------------------------------
  console.log('step: wait for worker answer');
  let answerText = null;
  const deadline = Date.now() + 300000;
  let stableSince = 0;
  let lastSize = -1;
  while (Date.now() < deadline) {
    await sleep(2000);
    let size = 0;
    try { size = fs.statSync(sessionRef.path).size; } catch { /* file gone? */ }
    if (size === lastSize) {
      if (stableSince && Date.now() - stableSince > 4000) {
        const entries = messageEntries(sessionRef.path);
        const assistants = entries.filter((e) => e.message.role === 'assistant' && entryText(e).trim());
        if (assistants.length > 0) { answerText = entryText(assistants[assistants.length - 1]); break; }
        if (userEntriesAtProposal.length !== entries.filter((e) => e.message.role === 'user').length) {
          // user entry landed but no assistant text — keep waiting until stable
        }
      } else {
        stableSince = Date.now();
      }
    } else {
      stableSince = 0;
      lastSize = size;
    }
  }
  if (answerText === null) {
    // Answer may legitimately be empty text; still capture final state.
    const entries = messageEntries(sessionRef.path);
    const assistants = entries.filter((e) => e.message.role === 'assistant');
    answerText = assistants.length ? entryText(assistants[assistants.length - 1]) : null;
    console.log('  answer wait timed out or empty; last assistant text:', JSON.stringify(answerText));
  }
  console.log('  worker answer:', JSON.stringify(answerText?.slice(0, 120)));
  await sleep(1500);
  await shot('09-answer-ready.png');
  result.steps.workerAnswer = { ok: true, answerText };

  // --- Byte-for-byte comparisons ---------------------------------------------------
  console.log('step: comparisons');
  const { sent, received } = talkerFrames();
  const GESTURES = ['yes, send that', 'no, cancel that'];
  const instructionSentFrame = sent.find((s) => !GESTURES.includes(s.utterance)) ?? null;
  const confirmSentFrame = sent.find((s) => GESTURES.includes(s.utterance)) ?? null;
  const releasedFrame = received.find((r) => r.phase === 'released');
  const proposedFrame = received.find((r) => r.phase === 'proposed');
  const userEntriesFinal = messageEntries(sessionRef.path).filter((e) => e.message.role === 'user');
  const workerUserText = userEntriesFinal.length ? entryText(userEntriesFinal[userEntriesFinal.length - 1]) : null;

  const utteranceSent = instructionSentFrame?.utterance ?? null;
  const blen = (s) => (s === null || s === undefined ? null : Buffer.byteLength(String(s), 'utf8'));

  result.comparisons = {
    talkerTurnsSent: sent.map((s) => ({ seq: s.seq, utterance: s.utterance, workerSessionId: s.workerSessionId, runtime: s.runtime })),
    talkerResults: received.map((r) => ({
      seq: r.seq, phase: r.phase, receiptAck: r.receiptAck ?? null, reply: r.reply ?? null,
      released: r.released ?? null, delivery: r.released?.delivery ?? null,
    })),
    utteranceSent,
    confirmGestureSent: confirmSentFrame?.utterance ?? null,
    instructionSentFrameSeq: instructionSentFrame?.seq ?? null,
    proposalShownInCard: proposalShown,
    releasedTextServerFrame: releasedFrame?.released?.text ?? null,
    deliveryOutcome: releasedFrame?.released?.delivery ?? null,
    workerTranscriptUserText: workerUserText,
    byteCounts: {
      utteranceSent: blen(utteranceSent),
      proposalShownInCard: blen(proposalShown),
      releasedTextServerFrame: blen(releasedFrame?.released?.text ?? null),
      workerTranscriptUserText: blen(workerUserText),
    },
    equalities: {
      utterance_eq_card: utteranceSent === proposalShown,
      card_eq_worker: proposalShown === workerUserText,
      released_eq_worker: (releasedFrame?.released?.text ?? null) === workerUserText,
      utterance_eq_worker: utteranceSent === workerUserText,
    },
    // Set when the confirm gate worked but the delivery was refused — the
    // operator was told honestly and the worker transcript stays untouched.
    deliveryWasRefused: releasedFrame?.released?.delivery?.outcome === 'refused',
  };
  console.log('  byte counts:', JSON.stringify(result.comparisons.byteCounts));
  console.log('  equalities:', JSON.stringify(result.comparisons.equalities));

  // --- Receipt-ack ordering ----------------------------------------------------------
  const ackFrame = firstFrameContaining('"receiptAck"');
  const releaseAckSeq = releasedFrame?.seq ?? null;
  let firstAnswerFrame = null;
  if (answerText && answerText.length >= 12) {
    firstAnswerFrame = firstFrameContaining(answerText.slice(0, 12).replace(/["\\]/g, ''), confirmAt.seq);
  }
  result.ackOrdering = {
    proposedReceiptAck: proposedFrame ? { seq: proposedFrame.seq, receiptAck: proposedFrame.receiptAck ?? null } : null,
    releasedAckFrameSeq: releaseAckSeq,
    releasedReply: releasedFrame?.reply ?? null,
    firstAnswerFrame: firstAnswerFrame ? { seq: firstAnswerFrame.seq, t: firstAnswerFrame.t } : null,
    ackBeforeAnswer: ackFrame ? (firstAnswerFrame ? ackFrame.seq < firstAnswerFrame.seq : 'no answer frame found') : 'no receiptAck frame found',
    confirmClickedAtSeq: confirmAt.seq,
  };
  console.log('  ack ordering:', JSON.stringify(result.ackOrdering, null, 2));

  result.ok = true;
  fs.writeFileSync(path.join(EVIDENCE, 'e2e-result.json'), JSON.stringify(result, null, 2));
  console.log('E2E DRIVER COMPLETE — evidence in', EVIDENCE);
} catch (err) {
  fail('driver', err);
} finally {
  framesLog.end();
  await browser.close().catch(() => {});
}
