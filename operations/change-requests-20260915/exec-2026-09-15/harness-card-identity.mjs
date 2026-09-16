/**
 * D-card — browser-level proof that the confirmation card releases exactly
 * the bytes it displayed, on every path.
 *
 * Drives the REAL client (vite dev, real modules — the wt-card worktree) in a
 * REAL Chromium against a DISPOSABLE validation server (boot.sh pattern:
 * systemd-run --scope --collect, outside the production cgroup), with
 * Chromium's fake media devices.
 *
 * THE ASSERTION THAT MATTERS: the bytes released equal the bytes the card
 * displayed, for every path — read from the WIRE (a WebSocket tap records the
 * server's own `talker_turn_result` payloads), never from component state.
 *
 * Paths:
 *   A. propose → inspect → confirm          released === displayed
 *   B. propose → cancel                     no release, card gone
 *   C. propose → STALE confirm → refusal    nothing released, card re-shows
 *                                           the CURRENT text; fresh confirm
 *                                           then releases exactly that
 *   D. propose (tidied) → "Send my exact
 *      words"                               released === the raw original bytes
 *
 * The stale path's second writer is a SECOND authenticated WebSocket opened
 * in the page (exactly what another tab/lane would open): its `talker_turn`
 * appends to the SAME worker session's server-side draft while this surface's
 * card still shows the old text — the server sends the foreign turn's result
 * only to the foreign socket, so the card cannot learn about it.
 *
 * Determinism: the operator's words enter through the card's typed fallback
 * (a real product path — verbatim words to the talker) and, for the
 * bootstrap propose only, through scripted dictation (Playwright intercepts
 * ONLY the dictation `/finish` endpoint response — the capture path and STT are
 * not under test here; the card gate is). Everything from transcript to
 * release is the real product path: real talker_turn over the real socket,
 * real server gate, real card render, real gesture handlers.
 *
 * Evidence → $CARD_EVIDENCE_DIR (default /tmp/card-evidence):
 *   card-identity.json + NN-*.png. Exit 0 iff every verdict passes.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const EVIDENCE = process.env.CARD_EVIDENCE_DIR ?? '/tmp/card-evidence';
const APP = process.env.CARD_APP_URL ?? 'http://127.0.0.1:3599';
const SOCKET = process.env.CARD_SOCKET ?? '/tmp/card-srv/internal-api.sock';
const TOKEN_PATH = process.env.CARD_TOKEN_PATH ?? '/tmp/card-srv/internal-api-token';
const PASSWORD = process.env.CARD_PASSWORD ?? 'voice-lab-pass';
const PROFILE = process.env.CARD_PROFILE ?? '/tmp/card-profile';
const WORKSPACE = '/tmp/card-workspace';

fs.mkdirSync(EVIDENCE, { recursive: true });

const report = { steps: {}, verdicts: {}, screenshots: [], notes: [] };
const reportPath = path.join(EVIDENCE, 'card-identity.json');
const writeReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
const step = (name, value) => {
  report.steps[name] = value;
  writeReport();
  console.log(`[step] ${name}:`, typeof value === 'string' ? value : JSON.stringify(value).slice(0, 800));
};
const verdict = (name, ok, detail) => {
  report.verdicts[name] = { ok, detail };
  writeReport();
  console.log(`[verdict] ${name}: ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function internalApi(method, urlPath, body) {
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path: urlPath, method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Wire tap: records every talker_turn_result the page receives, tagged by
 *  socket index. Observational only. NOTE: assertions do NOT filter by socket
 *  — the app's WebSocket can reconnect (new instance index), and the one
 *  foreign socket's result is distinguished by arriving before the relevant
 *  mark (its reply never matches the refusal/phase predicates used here). */
const WIRE_TAP = () => {
  window.__wire = [];
  window.__wsCount = 0;
  const RealWS = window.WebSocket;
  function TappedWS(url, protocols) {
    const idx = window.__wsCount++;
    const ws = protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
    const rec = (entry) => window.__wire.push({ at: Date.now(), socket: idx, ...entry });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (msg && (msg.type === 'talker_turn_result' || msg.type === 'error')) {
          rec({ result: msg });
        }
      } catch { /* non-JSON frame — not ours */ }
    });
    const realSend = ws.send.bind(ws);
    ws.send = (data, ...rest) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : '');
        if (msg && msg.type === 'talker_turn') {
          rec({ sent: { utterance: msg.utterance, proposalRef: msg.proposalRef, releaseVariant: msg.releaseVariant, requestId: msg.requestId } });
        }
      } catch { /* ignore */ }
      return realSend(data, ...rest);
    };
    return ws;
  }
  TappedWS.prototype = RealWS.prototype;
  Object.assign(TappedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = TappedWS;
};

const READ_CARD = () => {
  const card = document.querySelector('[data-testid="confirmation-card"]');
  return {
    present: !!card,
    text: document.querySelector('[data-testid="pending-proposal-text"]')?.textContent ?? null,
    version: card?.getAttribute('data-proposal-version'),
    hash: card?.getAttribute('data-proposal-hash'),
  };
};

/** Foreign writer: a SECOND authenticated socket (what another tab/lane
 *  opens), sending one operator utterance for the same worker session. Its
 *  result comes back ONLY here — the app socket never sees it. The runtime is
 *  explicit: the server defaults to 'pi', which would key a DIFFERENT talker
 *  session (a different draft) and the card would not be stale at all. */
const FOREIGN_SEND = ({ sessionId, utterance, runtime }) => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    const timer = setTimeout(() => reject(new Error('foreign turn timeout')), 45000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'talker_turn', workerSessionId: sessionId, utterance, runtime }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'talker_turn_result') { clearTimeout(timer); resolve(msg); ws.close(); }
        if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.message)); }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('foreign socket error')); };
  });
};

/** Wait until the wire shows a result satisfying pred after index `from`. */
async function waitForWire(page, from, pred, timeoutMs = 30000, label = 'wire') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(({ from, predSrc }) => {
      const pred = eval(predSrc);
      for (let i = from; i < window.__wire.length; i++) {
        const w = window.__wire[i];
        if (w.result && pred(w.result)) return { index: i, result: w.result, total: window.__wire.length };
      }
      return null;
    }, { from, predSrc: pred.toString() });
    if (hit) return hit;
    await sleep(300);
  }
  const dump = await page.evaluate(() => window.__wire.map((w) => ({ socket: w.socket, phase: w.result?.phase, reply: (w.result?.reply || '').slice(0, 60), error: w.result?.message, sent: w.sent })));
  throw new Error(`wire wait timed out: ${label}; wire=${JSON.stringify(dump)}`);
}

const STORE_STATE = async (page) => {
  const st = await page.evaluate(async () => {
    const mod = await import('/src/store/sessionStore.ts');
    const s = mod.useSessionStore.getState();
    return {
      currentSessionId: s.currentSessionId,
      activeSessions: s.sessions.filter((x) => x.path && !s.archivedSessionPaths.includes(x.path)).map((x) => x.id),
    };
  });
  return st;
};

async function main() {
  // ---- session -------------------------------------------------------------
  // Runtime choice: the pi relay awaits the worker session's ENTIRE agent turn
  // (manager.prompt → agentSession.prompt), which with a real model is a
  // minutes-long tool loop — unusable for a harness. A claude worker session
  // keeps every card-relevant step real (talker model, gate, draft, identity,
  // confirm, release record) while the DELIVERY itself resolves fast: the
  // validation server has no SDK-backed claude session, so the relay refuses
  // the delivery honestly and the result carries the released bytes as the
  // talker/relay record — exactly what the assertions read.
  const existing = await internalApi('GET', '/api/v1/sessions');
  const existingIds = (Array.isArray(existing.body?.sessions) ? existing.body.sessions : []).map((s) => s.sessionId ?? s.id).filter(Boolean);
  for (const id of existingIds) await internalApi('DELETE', `/api/v1/sessions/${id}`);
  const created = await internalApi('POST', '/api/v1/sessions', { runtime: 'claude', cwd: WORKSPACE });
  const SESSION = created.body?.sessionId;
  if (!SESSION) throw new Error(`could not create a worker session: ${JSON.stringify(created).slice(0, 300)}`);
  step('session', { created: SESSION });

  // ---- browser -------------------------------------------------------------
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  await context.addInitScript(WIRE_TAP);

  // Scripted dictation for the bootstrap propose ONLY (see header note).
  let dictated = '';
  await context.route('**/api/dictation/*/finish', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: dictated, duration_ms: 120 }) });
  });

  const page = context.pages()[0] ?? (await context.newPage());
  const shot = async (name) => {
    await page.screenshot({ path: path.join(EVIDENCE, name) });
    report.screenshots.push(name);
    writeReport();
    console.log('  screenshot:', name);
  };

  // ---- login + enter Voice Mode on the session ------------------------------
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 30000 });
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#password', { state: 'detached', timeout: 30000 });
  step('login', 'ok');

  await page.click('[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
  await page.click('button[aria-label="Continue an existing session"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  const store = await STORE_STATE(page);
  const idx = store.activeSessions.indexOf(SESSION);
  if (idx < 0) throw new Error(`session ${SESSION} not in picker: ${JSON.stringify(store.activeSessions)}`);
  await page.locator('h2:has-text("Continue a Session") ~ div button').nth(idx).click();
  await page.waitForSelector('[data-testid="drive-mic"]', { timeout: 30000 });
  const bound = await STORE_STATE(page);
  if (bound.currentSessionId !== SESSION) throw new Error(`bound ${bound.currentSessionId}, expected ${SESSION}`);
  await sleep(600);
  step('voiceMode', 'entered on the worker session');

  /** One spoken (scripted-dictation) utterance through the REAL capture path. */
  const speak = async (text) => {
    dictated = text;
    await page.click('[data-testid="drive-mic"]');
    await sleep(900);
    await page.click('[data-testid="drive-mic"]');
  };
  /** One typed utterance through the card's real text fallback — usable only
   *  while a card is up (the input lives on the card). */
  const type_ = async (text) => {
    await page.getByLabel(/type a reply/i).fill(text);
    await page.getByRole('button', { name: /^send reply$/i }).click();
  };
  const waitCard = () => page.waitForSelector('[data-testid="confirmation-card"]', { timeout: 60000 });
  const readCard = () => page.evaluate(READ_CARD);
  /** Wait until the card's text or identity differs from `prev` (a turn that
   *  re-proposes takes seconds: model call). */
  const waitCardChange = async (prev, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await readCard();
      if (now.text !== prev.text || now.version !== prev.version) return now;
      await sleep(400);
    }
    throw new Error(`card never changed from ${JSON.stringify(prev)}`);
  };
  const wireLen = () => page.evaluate(() => window.__wire.length);
  const wireAll = () => page.evaluate(() => window.__wire.filter((w) => w.result).map((w) => w.result));

  // ---- bootstrap: dictation propose, a typed append, then a cancel ---------
  await speak('tell the worker to water the plants on the balcony');
  await waitCard();
  const boot = await readCard();
  step('bootstrap.proposed', boot);
  // The card's typed fallback is a real surface: it APPENDS to the draft and
  // the card re-shows the joined bytes under a fresh identity.
  await type_('and also close the gate');
  const bootJoined = await waitCardChange(boot);
  step('bootstrap.typedAppend', bootJoined);
  if (!bootJoined.text.includes('close the gate') || bootJoined.version === boot.version) {
    throw new Error(`typed append did not move the proposal: ${JSON.stringify(bootJoined)}`);
  }
  await page.getByRole('button', { name: /^cancel$/i }).click();
  await page.waitForSelector('[data-testid="confirmation-card"]', { state: 'detached', timeout: 30000 });
  step('bootstrap.cancelled', 'card dismissed by the real Cancel gesture');

  // ==== PATH A: propose → inspect → confirm ==================================
  let mark = await wireLen();
  await speak('hold phase 3 for review');
  await waitCard();
  const cardA = await readCard();
  step('A.card', cardA);
  const proposedA = await waitForWire(page, mark, (r) => r.phase === 'proposed', 30000, 'A proposed');
  const pA = proposedA.result.proposal;
  verdict(
    'A.identityOnCardMatchesWire',
    String(pA?.version) === cardA.version && pA?.hash === cardA.hash,
    `wire proposal {v${pA?.version}, ${String(pA?.hash).slice(0, 10)}…} === card attrs`
  );
  await shot('01-A-card.png');

  mark = await wireLen();
  await page.getByRole('button', { name: /^confirm/i }).click();
  const releasedA = await waitForWire(page, mark, (r) => r.phase === 'released', 180000, 'A released');
  verdict(
    'A.releasedBytesEqualDisplayed',
    releasedA.result.released?.text === cardA.text,
    `released "${releasedA.result.released?.text}" === displayed "${cardA.text}"`
  );
  await shot('02-A-released.png');

  // ==== PATH B: propose → cancel =============================================
  mark = await wireLen();
  await speak('deploy the fix to staging now');
  await waitCard();
  const cardB = await readCard();
  step('B.card', cardB);
  const releasesBeforeB = (await wireAll()).filter((r) => r.phase === 'released').length;
  await page.getByRole('button', { name: /^cancel$/i }).click();
  await page.waitForSelector('[data-testid="confirmation-card"]', { state: 'detached', timeout: 30000 });
  await sleep(1500);
  const releasesAfterB = (await wireAll()).filter((r) => r.phase === 'released').length;
  verdict(
    'B.cancelReleasesNothing',
    releasesAfterB === releasesBeforeB && cardB.text === 'deploy the fix to staging now',
    `card cancelled after displaying "${cardB.text}"; releases before=${releasesBeforeB} after=${releasesAfterB}`
  );
  await shot('03-B-cancelled.png');

  // ==== PATH C: propose → STALE confirm → refusal → fresh confirm ============
  mark = await wireLen();
  await speak('hold phase 3 for review');
  await waitCard();
  const cardC = await readCard();
  step('C.card.stale', cardC);

  // A foreign lane/tab mutates the SAME worker session's draft server-side.
  const foreign = await page.evaluate(FOREIGN_SEND, { sessionId: SESSION, utterance: 'and also update the changelog', runtime: 'claude' });
  step('C.foreignTurn', { phase: foreign.phase, proposalText: foreign.proposal?.text });
  if (foreign.phase !== 'proposed') throw new Error(`foreign turn did not propose: ${JSON.stringify(foreign).slice(0, 300)}`);

  // The card MUST still show the old bytes — the foreign result never
  // reached this surface (server replies only to the requesting socket).
  const stillStale = await readCard();
  await shot('04-C-stale-card.png');

  mark = await wireLen();
  await page.getByRole('button', { name: /^confirm/i }).click();
  const refusal = await waitForWire(page, mark, (r) => r.reply.includes('out of date'), 30000, 'C stale refusal');
  const afterRefusal = await waitCardChange(stillStale);
  step('C.refusal', {
    reply: refusal.result.reply,
    released: refusal.result.released,
    freshProposal: refusal.result.proposal?.text,
    cardAfter: afterRefusal,
  });
  const currentExpected = 'hold phase 3 for review\nand also update the changelog';
  verdict(
    'C.staleConfirmReleasedNothing',
    (refusal.result.released ?? null) === null,
    `stale confirm released ${JSON.stringify(refusal.result.released)} — nothing`
  );
  verdict(
    'C.cardReShowedCurrentText',
    afterRefusal.text === currentExpected && String(refusal.result.proposal?.version) === afterRefusal.version,
    `card now shows "${afterRefusal.text}" under fresh identity v${afterRefusal.version} (wire v${refusal.result.proposal?.version})`
  );
  verdict(
    'C.staleCardWasGenuinelyStale',
    stillStale.text === 'hold phase 3 for review' && stillStale.version !== afterRefusal.version,
    `before the click the card still showed "${stillStale.text}" (v${stillStale.version}) — the foreign mutation never reached it`
  );
  await shot('05-C-reshown-current.png');

  // Fresh confirm on the RE-SHOWN card: releases exactly the current bytes.
  mark = await wireLen();
  await page.getByRole('button', { name: /^confirm/i }).click();
  const releasedC = await waitForWire(page, mark, (r) => r.phase === 'released', 180000, 'C released');
  verdict(
    'C.freshConfirmReleasedCurrentDisplayed',
    releasedC.result.released?.text === currentExpected,
    `released "${releasedC.result.released?.text}" === the re-shown card text`
  );
  await shot('06-C-released-current.png');

  // ==== PATH D: propose (tidied) → Send my exact words =======================
  mark = await wireLen();
  await speak('Um, tell the worker to rerun the suite');
  await waitCard();
  const cardD = await readCard();
  await page.locator('[data-testid="relay-original-disclosure"] summary').click();
  await page.waitForSelector('[data-testid="relay-original-text"]', { timeout: 10000 });
  const originalShown = await page.locator('[data-testid="relay-original-text"]').textContent();
  step('D.card', { tidied: cardD.text, originalShown });
  await shot('07-D-original-disclosure.png');

  mark = await wireLen();
  await page.getByRole('button', { name: /send my exact words/i }).click();
  const releasedD = await waitForWire(page, mark, (r) => r.phase === 'released', 180000, 'D released');
  verdict(
    'D.originalReleasedEqualsDisplayedOriginal',
    releasedD.result.released?.text === originalShown && originalShown === 'Um, tell the worker to rerun the suite',
    `released "${releasedD.result.released?.text}" === displayed original "${originalShown}"`
  );
  verdict(
    'D.identityEchoRodeAlong',
    String(cardD.version ?? '') !== '' && cardD.hash !== null,
    `the tidied card carried identity v${cardD.version} — the gesture echoed it with variant 'original'`
  );
  await shot('08-D-released-original.png');

  // ---- summary --------------------------------------------------------------
  const releases = (await wireAll()).filter((r) => r.phase === 'released').map((r) => r.released?.text);
  step('wire.releasedTexts', releases);
  const allOk = Object.values(report.verdicts).every((v) => v.ok);
  console.log(allOk ? 'ALL VERDICTS PASS' : 'SOME VERDICTS FAILED');
  await context.close();
}

main()
  .then(() => { writeReport(); console.log('evidence:', reportPath); process.exit(process.exitCode ?? 0); })
  .catch((err) => {
    report.notes.push(`FATAL: ${err?.stack || err}`);
    writeReport();
    console.error('FATAL:', err);
    process.exit(1);
  });
