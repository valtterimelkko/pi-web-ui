/**
 * P13 — Voice Mode BARGE-IN browser end-to-end driver.
 *
 * Reproduces the operator's production gesture: start read-aloud playback of a
 * verbose assistant answer, then PRESS THE MIC MID-PLAYBACK (barge-in). The
 * driver captures everything the browser says — console errors, uncaught
 * exceptions (pageerror), unhandled rejections (injected listener installed
 * before any app code), and the React error boundary text — plus every
 * WebSocket frame, so a client-side failure that the server never sees is
 * still fully evidenced.
 *
 * Extends (does not modify) scripts/voice-mode-browser-e2e.mjs (P9).
 *
 * Evidence written to $P13_EVIDENCE_DIR (default /tmp/p13-evidence):
 *   ws-frames.jsonl     every WebSocket frame with timestamp + direction
 *   barge-in-result.json  measured values, captured browser errors, verdicts
 *   NN-*.png            screenshots of each driven state
 *   crash-diagnostics.json  the manual browser diagnostic bundle if the
 *                       error boundary appeared (captured via its Download
 *                       diagnostics button)
 *
 * Requires: P13_CONFIRM_PASSWORD (the disposable server's auth password).
 * Never logs the password. Disposable servers only — never production.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE = process.env.P13_EVIDENCE_DIR ?? '/tmp/p13-evidence';
const BASE_URL = process.env.P13_BASE_URL ?? 'http://localhost:5199';
const PASSWORD = process.env.P13_CONFIRM_PASSWORD;
const WORKDIR = '/tmp/p13-workdir';
const AUDIO = process.env.P13_AUDIO ?? path.join(EVIDENCE, 'instruction.wav');
const RECORD_MS = Number(process.env.P13_RECORD_MS ?? 9000);
/** Voice Mode picker label of the worker model to drive. */
const MODEL_LABEL = process.env.P13_MODEL_LABEL ?? 'Codex / GPT-5.6 Sol';
/** Silence after read-aloud starts before the mic press (mid-chunk timing). */
const BARGE_DELAY_MS = Number(process.env.P13_BARGE_DELAY_MS ?? 2500);

if (!PASSWORD) { console.error('P13_CONFIRM_PASSWORD not set'); process.exit(2); }
if (!fs.existsSync(AUDIO)) { console.error('audio file missing:', AUDIO); process.exit(2); }

fs.mkdirSync(EVIDENCE, { recursive: true });
const framesLog = fs.createWriteStream(path.join(EVIDENCE, 'ws-frames.jsonl'), { flags: 'w' });
let frameSeq = 0;
const frames = [];
const result = { steps: {}, browserErrors: [], consoleErrors: [], screenshots: [] };
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
  return page.screenshot({ path: path.join(EVIDENCE, name), fullPage: false }).then(() => {
    result.screenshots.push(name);
    console.log('  screenshot:', name);
  }).catch(() => {});
}

function finish(code) {
  fs.writeFileSync(path.join(EVIDENCE, 'barge-in-result.json'), JSON.stringify(result, null, 2));
  process.exitCode = code;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await context.addInitScript((dir) => {
    localStorage.setItem('pi-web-ui-ui-store', JSON.stringify({
      state: { recentFolders: [{ path: dir, label: 'p13-workdir', count: 1, lastUsed: Date.now() }] },
      version: 0,
    }));
  }, WORKDIR);
  // Install error capture BEFORE any app code runs: uncaught exceptions and
  // unhandled rejections, recorded verbatim (message + stack) into window.
  await context.addInitScript(() => {
    window.__p13errors = [];
    const push = (kind, err) => {
      try {
        window.__p13errors.push({
          kind,
          at: new Date().toISOString(),
          message: err && err.message ? String(err.message) : String(err),
          stack: err && err.stack ? String(err.stack).slice(0, 4000) : null,
        });
      } catch { /* never break the page */ }
    };
    window.addEventListener('error', (e) => push('uncaught_error', e.error ?? e.message), true);
    window.addEventListener('unhandledrejection', (e) => push('unhandled_rejection', e.reason));
  }, );

  page = await context.newPage();
  page.on('websocket', (ws) => {
    console.log('ws opened:', ws.url());
    ws.on('framesent', (d) => logFrame('sent', d));
    ws.on('framereceived', (d) => logFrame('received', d));
    ws.on('close', () => console.log('ws closed:', ws.url()));
  });
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      result.consoleErrors.push({ type: t, text: m.text().slice(0, 6000) });
      console.log(`  [console.${t}]`, m.text().slice(0, 400));
    }
  });
  page.on('pageerror', (err) => {
    result.browserErrors.push({ kind: 'pageerror', message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 4000) });
    console.log('  [pageerror]', String(err?.message ?? err).slice(0, 300));
  });

  // --- Login ---------------------------------------------------------------
  console.log('step: login');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  try {
    await page.fill('#password', PASSWORD, { timeout: 8000 });
    await page.click('button[type="submit"]');
  } catch {
    // Already authenticated — continue.
  }
  await page.waitForSelector('button[aria-label="Enter Voice Mode"]', { timeout: 20000 });
  result.steps.login = { ok: true };

  // --- Open Voice Mode → new session → model → folder -----------------------
  console.log('step: open voice mode');
  await page.click('button[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Start a new session"]', { timeout: 10000 });
  await page.click('button[aria-label="Start a new session"]');
  await page.waitForSelector(`button:has-text("${MODEL_LABEL}")`, { timeout: 15000 });
  await page.click(`button:has-text("${MODEL_LABEL}")`);
  await page.waitForSelector(`button:has-text("${WORKDIR}")`, { timeout: 10000 });
  await page.click(`button:has-text("${WORKDIR}")`);
  await page.waitForSelector('button[aria-label="Start recording"]', { timeout: 30000 });
  await sleep(1200);
  const sessionRef = findSessionPathFromFrames();
  if (!sessionRef) { result.steps.session = { ok: false, error: 'no session_created' }; finish(1); throw new Error('no session_created'); }
  result.steps.session = { ok: true, ...sessionRef };
  console.log('  worker session:', sessionRef.path);
  await shot('01-dictate-idle.png');

  // --- Record the verbose instruction ---------------------------------------
  console.log('step: record instruction', `(${RECORD_MS}ms)`);
  await page.click('button[aria-label="Start recording"]');
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 10000 });
  await sleep(RECORD_MS);
  await page.click('button[aria-label="Stop recording"]');
  result.steps.recordInstruction = { ok: true, recordMs: RECORD_MS };

  // --- Confirm → wait for the mechanical delivery (transcript proof) ---------
  console.log('step: confirm release');
  await page.click('[data-testid="confirmation-card"] button:has-text("Confirm")');
  // The release gate is mechanical server-side (no model call), but the
  // released RESULT rides behind the whole worker turn — so prove delivery
  // from the worker transcript instead of the released-outcome banner.
  let delivered = false;
  const deliveryDeadline = Date.now() + 90000;
  while (Date.now() < deliveryDeadline) {
    await sleep(1000);
    try {
      const users = messageEntries(sessionRef.path).filter((e) => e.message.role === 'user');
      if (users.length > 0) { delivered = true; break; }
    } catch { /* transcript not written yet */ }
  }
  result.steps.delivery = { ok: delivered };
  if (!delivered) { result.ok = false; result.why = 'release never reached the worker transcript'; finish(1); throw new Error('no delivery'); }
  console.log('  released utterance in worker transcript');
  await shot('02-released.png');

  // --- Wait for the verbose answer -------------------------------------------
  console.log('step: wait for verbose answer (first pi turn runs agent-os recall — slow)');
  let answerText = null;
  const deadline = Date.now() + 480000;
  let stableSince = 0;
  let lastSize = -1;
  while (Date.now() < deadline) {
    await sleep(2000);
    let size = 0;
    try { size = fs.statSync(sessionRef.path).size; } catch { /* gone */ }
    if (size === lastSize) {
      if (stableSince && Date.now() - stableSince > 4000) {
        const entries = messageEntries(sessionRef.path);
        const assistants = entries.filter((e) => e.message.role === 'assistant' && entryText(e).trim());
        if (assistants.length > 0) { answerText = entryText(assistants[assistants.length - 1]); break; }
      } else {
        stableSince = Date.now();
      }
    } else {
      stableSince = 0;
      lastSize = size;
    }
  }
  if (answerText === null) {
    const entries = messageEntries(sessionRef.path);
    const assistants = entries.filter((e) => e.message.role === 'assistant');
    answerText = assistants.length ? entryText(assistants[assistants.length - 1]) : null;
  }
  result.steps.workerAnswer = { ok: !!answerText, chars: answerText?.length ?? 0, excerpt: answerText?.slice(0, 120) ?? null };
  console.log('  answer chars:', answerText?.length ?? 0);
  if (!answerText || answerText.length < 180) {
    console.log('  ANSWER NOT VERBOSE ENOUGH — barge-in needs long playback; aborting with evidence');
    result.ok = false; result.why = 'answer too short for barge-in';
    finish(1);
    throw new Error('answer too short');
  }
  await shot('03-answer-ready.png');

  // --- Wait for the worker turn to end, THEN for talker playback ------------
  // ONE continuous watch: the auto tier-3 answer submit fires on the
  // streaming→false transition and can start (and even finish) while this
  // driver is still looking at the transcript — so watch the floor label AND
  // the arbiter probe from the moment the answer is detected, and only fall
  // back to pressing Read Aloud (capped: rapid clicks toggle play/stop).
  console.log('step: wait for turn end + talker playback (floor + arbiter watch)');
  const floorLabel = async () => {
    try { return (await page.textContent('[data-testid="floor-state-label"]', { timeout: 2000 }))?.trim() ?? null; }
    catch { return null; }
  };
  const arbiterSnapshot = async () => {
    try {
      return await page.evaluate(() => {
        const a = (window).__speechArbiter;
        return a ? a.getState() : 'no-probe';
      });
    } catch { return 'eval-failed'; }
  };
  let talking = false;
  const talkDeadline = Date.now() + 180000;
  const floorTimeline = [];
  let readAloudClicks = 0;
  let lastClickAt = 0;
  const stepStartedAt = Date.now();
  let streamingSeen = false;
  let lastArbiter = null;
  while (Date.now() < talkDeadline) {
    const label = await floorLabel();
    if (label && (floorTimeline.length === 0 || floorTimeline[floorTimeline.length - 1].label !== label)) {
      floorTimeline.push({ t: new Date().toISOString(), label });
      console.log('  floor:', label);
    }
    if (label === 'Working silently') streamingSeen = true;
    const arb = await arbiterSnapshot();
    const busy = arb && arb !== 'no-probe' && arb !== 'eval-failed'
      && ((arb.current !== null) || (arb.queued && arb.queued.length > 0));
    if (JSON.stringify(arb) !== JSON.stringify(lastArbiter)) {
      lastArbiter = arb;
      if (busy || (arb && arb.paused)) console.log('  arbiter:', JSON.stringify(arb).slice(0, 300));
    }
    if (label === 'Talker speaking' || busy) { talking = true; break; }
    // Read Aloud fallback — at most twice, 15s apart, only after the worker
    // turn has plausibly ended (streaming seen ended, or 25s have passed).
    const turnSettled = streamingSeen || Date.now() - stepStartedAt > 25000;
    if (turnSettled && readAloudClicks < 2 && Date.now() - lastClickAt > 15000) {
      const btn = await page.locator('button:has-text("Read Aloud")').count();
      if (btn > 0) {
        console.log('  Read Aloud click', readAloudClicks + 1, '| arbiter:', JSON.stringify(arb).slice(0, 250));
        await page.click('button:has-text("Read Aloud")').catch(() => {});
        readAloudClicks += 1;
        lastClickAt = Date.now();
        await sleep(2000);
        const after = await arbiterSnapshot();
        console.log('  arbiter after click:', JSON.stringify(after).slice(0, 300));
        if (after && typeof after === 'object' && (after.current !== null || (Array.isArray(after.queued) && after.queued.length > 0))) {
          talking = true;
          break;
        }
      }
    }
    await sleep(500);
  }
  result.steps.playback = { ok: talking, floorTimeline };
  if (!talking) { result.ok = false; result.why = 'playback never started — cannot barge in'; finish(1); throw new Error('no playback'); }
  await shot('04-read-aloud-playing.png');
  await sleep(BARGE_DELAY_MS); // land MID-CHUNK, the operator's actual timing

  // --- BARGE-IN: press the mic while playback is in flight --------------------
  console.log('step: BARGE-IN — press mic mid-playback');
  const pressFloor = await floorLabel();
  await page.click('button[aria-label="Start recording"]');
  result.steps.bargeInPress = { ok: true, at: new Date().toISOString(), floorAtPress: pressFloor };
  console.log('  pressed mic while floor was:', pressFloor);
  await shot('05-barge-in-pressed.png');

  // Follow the floor for a few seconds — ducking/restoring is visible here.
  for (let i = 0; i < 10; i++) {
    await sleep(800);
    const label = await floorLabel();
    const ducked = await page.locator('[data-testid="floor-ducked-badge"]').count().catch(() => 0);
    const entry = { t: new Date().toISOString(), label, ducked: ducked > 0 };
    if (!result.floorAfterBarge || JSON.stringify(result.floorAfterBarge[result.floorAfterBarge.length - 1]) !== JSON.stringify(entry)) {
      (result.floorAfterBarge ??= []).push(entry);
      console.log('  floor:', label, ducked > 0 ? '(ducked)' : '');
    }
  }

  // Give any late failure a further window, then assess.
  await sleep(4000);

  const boundary = await page.locator('text=Something went wrong').count();
  const boundaryText = boundary > 0 ? await page.locator('h1:has-text("Something went wrong") + p, text=Something went wrong').first().textContent().catch(() => null) : null;
  result.steps.afterBargeIn = {
    errorBoundary: boundary > 0,
    boundaryText,
    windowErrors: await page.evaluate(() => window.__p13errors ?? []).catch(() => null),
  };
  console.log('  error boundary:', boundary > 0 ? 'PRESENT' : 'absent');
  console.log('  window errors:', JSON.stringify(result.steps.afterBargeIn.windowErrors, null, 2)?.slice(0, 2000));
  await shot('06-after-barge-in.png');

  // If the boundary appeared, capture the manual diagnostic bundle via its
  // own Download button (the only path production has today).
  if (boundary > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('button:has-text("Download diagnostics")'),
      ]);
      const crashPath = path.join(EVIDENCE, 'crash-diagnostics.json');
      await download.saveAs(crashPath);
      result.crashDiagnostics = crashPath;
      console.log('  manual bundle saved:', crashPath);
    } catch (e) {
      result.crashDiagnosticsError = String(e);
    }
    await shot('07-crash-boundary.png');
  }

  // Let the barge dictation finish (stop after a few seconds) — the floor
  // releases and any queued speech restores at the next chunk boundary.
  const stopVisible = await page.locator('button[aria-label="Stop recording"]').count().catch(() => 0);
  if (stopVisible > 0) {
    await sleep(3000);
    await page.click('button[aria-label="Stop recording"]').catch(() => {});
  }

  // Continue the operator's flow: the spoken barge utterance reaches the
  // talker and typically PROPOSES (card mounts while speech may still be
  // playing) — then confirm and let the tier-2 receipt ack preempt the
  // still-playing answer. Every step is a place the production crash could
  // fire, and none of it is gated on playback state by design.
  try {
    await page.waitForSelector('[data-testid="confirmation-card"]', { timeout: 90000 });
    result.steps.postBargeProposal = { ok: true };
    await shot('09-post-barge-proposal.png');
    await sleep(1500); // let the receipt ack (tier 2) start preempting
    await page.click('[data-testid="confirmation-card"] button:has-text("Confirm")').catch(() => {});
    await sleep(8000);
    await shot('10-post-barge-confirmed.png');
  } catch {
    result.steps.postBargeProposal = { ok: false, note: 'no proposal after barge utterance (not instruction-classified?)' };
  }
  await sleep(4000);
  await shot('08-final-state.png');

  // Phase 1 verdict FIRST — the P13 proof errors below must not muddy it.
  result.ok = result.steps.afterBargeIn.errorBoundary || (result.steps.afterBargeIn.windowErrors ?? []).length > 0 || result.browserErrors.length > 0;
  result.verdict = result.steps.afterBargeIn.errorBoundary
    ? 'CRASH REPRODUCED — error boundary shown on barge-in'
    : ((result.steps.afterBargeIn.windowErrors ?? []).length > 0 || result.browserErrors.length > 0)
      ? 'CLIENT ERROR CAPTURED (no boundary) — see browserErrors/windowErrors'
      : 'NO CLIENT ERROR OBSERVED — honest negative';
  console.log('VERDICT:', result.verdict);

  // --- P13 Phase 2 live proof: client errors must reach the server ring -----
  // (a) genuine uncaught error + unhandled rejection through the REAL global
  //     handlers installed by main.tsx; the ring context carries the barge-in
  //     story these events just followed.
  console.log('step: P13 proof — genuine uncaught error + unhandled rejection');
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('P13 synthetic uncaught error — voice surface error class'); });
    void Promise.reject(new Error('P13 synthetic unhandled rejection — voice surface error class'));
  });
  await sleep(3000);

  // (b) a CORRELATED voice-surface error through the REAL dictation path:
  // revoke mic permission, then press the mic — useDictation reports the
  // failure with runtime + workerSessionId.
  console.log('step: P13 proof — real dictation error (mic permission revoked)');
  await context.clearPermissions().catch(() => {});
  const micClickable = await page.locator('button[aria-label="Start recording"], button[aria-label="Stop recording"]').count().catch(() => 0);
  if (micClickable > 0) {
    const stopFirst = await page.locator('button[aria-label="Stop recording"]').count().catch(() => 0);
    if (stopFirst > 0) await page.click('button[aria-label="Stop recording"]').catch(() => {});
    await sleep(1000);
    await page.click('button[aria-label="Start recording"]').catch(() => {});
    await sleep(4000);
  }
  result.p13Proof = { issued: true, phase1Verdict: result.verdict, note: 'retrieve via GET /api/v1/diagnostics?component=ClientVoice' };
  await shot('11-after-p13-proof.png');

  result.phase1Ok = result.ok;
  result.ok = true; // the driver completes; verdicts live in result.verdict / result.phase1Ok
  finish(0);
} catch (err) {
  result.steps.driver = { ok: false, error: String(err) };
  if (page) await shot('ZZ-failed.png');
  console.error('DRIVER FAILED:', err);
  finish(1);
} finally {
  framesLog.end();
  await browser.close().catch(() => {});
}
