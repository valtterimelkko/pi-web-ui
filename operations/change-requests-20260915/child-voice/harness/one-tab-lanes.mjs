/**
 * Lane work — one-tab multi-lane Voice Mode harness (adapted from
 * two-tab-repro-v2.mjs). Drives the REAL client (vite dev, real modules) in a
 * REAL Chromium against a DISPOSABLE validation server, with Chromium's fake
 * media devices, so the real capture path (getUserMedia → MediaRecorder →
 * /api/dictation/*) and the real speech arbiter scheduling are exercised.
 *
 * THE SHAPE UNDER TEST: ONE tab holds the lanes. No second tab anywhere.
 *
 *   1. single-lane collapse — no rows, no cap counter; the '+' affordance
 *   2. adding a second lane through the existing session picker, in place
 *   3. per-lane addressing (switch without leaving the screen)
 *   4. ONE floor across lanes — the operator is NEVER spoken over:
 *        - speech submitted while ANY lane captures never starts (queues)
 *        - speech already playing DUCKS to 0.15 (never stops) on capture
 *        - two lanes wanting the floor queue by tier then waiting-time order
 *   5. the third lane and the cap — a fourth lane ASKS, never appears
 *   6. closing a lane: capture finalises, nothing leaks
 *
 * Observational instrumentation only (same rules as the two-tab harness):
 * getUserMedia / MediaRecorder / dictation fetch are wrapped to RECORD what
 * the product did. For arbiter-level evidence an observing player (the two-tab
 * harness's pattern) is attached to the page's REAL arbiter: it records every
 * playChunk volume and live setVolume, so the 0.15 duck is observed at the
 * wire level rather than through component state. The capture path is never
 * touched.
 *
 * Evidence → $VOICE_EVIDENCE_DIR (default /tmp/lanes-evidence): lanes.json / NN-*.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const EVIDENCE = process.env.VOICE_EVIDENCE_DIR ?? '/tmp/lanes-evidence';
const APP = process.env.VOICE_APP_URL ?? 'http://127.0.0.1:3503';
const SOCKET = process.env.VOICE_SOCKET ?? '/tmp/lanes-srv/internal-api.sock';
const TOKEN_PATH = process.env.VOICE_TOKEN_PATH ?? '/tmp/lanes-srv/internal-api-token';
const PASSWORD = process.env.VOICE_PASSWORD ?? 'voice-lab-pass';
const PROFILE = process.env.VOICE_PROFILE ?? '/tmp/lanes-profile';
const WORKSPACE = process.env.VOICE_WORKSPACE ?? '/tmp/lanes-workspace';

fs.mkdirSync(EVIDENCE, { recursive: true });

const report = { steps: {}, screenshots: [], verdicts: {}, notes: [] };
const writeReport = () => fs.writeFileSync(path.join(EVIDENCE, 'lanes.json'), JSON.stringify(report, null, 2));
const step = (name, value) => {
  report.steps[name] = value;
  writeReport();
  console.log(`[step] ${name}:`, typeof value === 'string' ? value : JSON.stringify(value).slice(0, 1200));
};
const verdict = (name, ok, detail) => {
  report.verdicts[name] = { ok, detail };
  writeReport();
  console.log(`[verdict] ${name}: ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
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

/** Probe: records the capture lifecycle. Installed before app code runs. */
const PROBE = () => {
  const probe = { gum: [], recorders: [], errors: [], unhandled: [], dictationCalls: [] };
  window.__voiceProbe = probe;
  const md = navigator.mediaDevices;
  const realGum = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  if (realGum) {
    md.getUserMedia = async (constraints) => {
      const call = { seq: probe.gum.length, at: Date.now(), status: 'pending' };
      probe.gum.push(call);
      try {
        const stream = await realGum(constraints);
        call.status = 'resolved';
        probe.streams = probe.streams || [];
        probe.streams.push(stream);
        return stream;
      } catch (err) {
        call.status = 'rejected';
        call.error = String(err && err.name ? `${err.name}: ${err.message}` : err);
        throw err;
      }
    };
  }
  const RealRecorder = window.MediaRecorder;
  if (RealRecorder) {
    const wrapped = function (...args) {
      const rec = new RealRecorder(...args);
      const entry = { seq: probe.recorders.length, at: Date.now(), events: [], ref: rec };
      probe.recorders.push(entry);
      const origStart = rec.start.bind(rec);
      const origStop = rec.stop.bind(rec);
      rec.start = (...a) => { entry.events.push({ at: Date.now(), type: 'start' }); return origStart(...a); };
      rec.stop = (...a) => { entry.events.push({ at: Date.now(), type: 'stop' }); return origStop(...a); };
      return rec;
    };
    wrapped.isTypeSupported = RealRecorder.isTypeSupported.bind(RealRecorder);
    window.MediaRecorder = wrapped;
  }
  window.addEventListener('error', (e) => probe.errors.push({ at: Date.now(), message: String(e.message) }));
  window.addEventListener('unhandledrejection', (e) => probe.unhandled.push({ at: Date.now(), reason: String(e.reason && e.reason.message ? e.reason.message : e.reason) }));
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.includes('/api/dictation')) {
      const call = { at: Date.now(), url: url.replace(/^https?:\/\/[^/]+/, ''), method: (init && init.method) || 'GET', status: 'pending' };
      probe.dictationCalls.push(call);
      try {
        const res = await realFetch(input, init);
        call.status = res.status;
        return res;
      } catch {
        call.status = 'network-error';
        throw err_forward();
      }
      function err_forward() { return new Error('network-error'); }
    }
    return realFetch(input, init);
  };
};

const READ_PROBE = () => {
  const p = window.__voiceProbe;
  return {
    recordersRecording: p.recorders.filter((r) => r.ref.state === 'recording').length,
    liveTracksNow: (p.streams || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length,
    dictationCalls: p.dictationCalls.slice(-8),
    errors: p.errors,
    unhandled: p.unhandled,
  };
};

const STRIP = () => {
  const rows = [...document.querySelectorAll('[data-testid="lane-row"]')];
  return {
    collapsed: !!document.querySelector('[data-testid="lane-strip-collapsed"]'),
    present: rows.length > 0,
    cap: document.querySelector('[data-testid="lane-cap"]')?.textContent ?? null,
    rows: rows.map((row) => ({
      session: row.getAttribute('data-lane-session'),
      addressed: row.getAttribute('aria-current') === 'true',
      state: row.querySelector('[data-testid="lane-state-label"]')?.textContent ?? null,
      floorMarker: row.querySelector('[data-testid="lane-floor-marker"]')?.textContent ?? null,
    })),
  };
};

/** The page's REAL speech arbiter state (the module the product speaks through). */
const ARB_STATE = () => {
  const st = window.__arb.getState();
  return {
    playing: st.playing,
    ducked: st.ducked,
    operatorSpeaking: st.operatorSpeaking,
    current: st.current?.id ?? null,
    queued: st.queued.map((q) => q.id),
    played: window.__played,
    volumeChanges: window.__volumeChanges,
  };
};

/** Attach an OBSERVING player to the page's real arbiter (two-tab-harness
 *  pattern): records volumes; chunks hang until the test advances them. */
const ATTACH_OBSERVER = () => {
  window.__played = [];
  window.__volumeChanges = [];
  window.__chunkResolvers = [];
  return import('/src/lib/speechArbiter.ts').then((m) => {
    window.__arb = m.speechArbiter;
    window.__arb.attachPlayer({
      playChunk: async (chunk, volume) => {
        window.__played.push({ chunk, volume, at: Date.now() });
        await new Promise((r) => window.__chunkResolvers.push(r));
      },
      setVolume: (v) => window.__volumeChanges.push({ v, at: Date.now() }),
      stopCurrent: () => {
        while (window.__chunkResolvers.length) window.__chunkResolvers.shift()();
      },
    });
    return window.__arb.getState();
  });
};

const STORE_STATE = async () => {
  const mod = await import('/src/store/sessionStore.ts');
  const st = mod.useSessionStore.getState();
  return {
    currentSessionId: st.currentSessionId,
    activeSessions: st.sessions
      .filter((s) => s.path && !st.archivedSessionPaths.includes(s.path))
      .map((s) => s.id),
  };
};

async function main() {
  // ---- sessions -------------------------------------------------------------
  const existing = await internalApi('GET', '/api/v1/sessions');
  const existingIds = (Array.isArray(existing.body?.sessions) ? existing.body.sessions : []).map((s) => s.sessionId ?? s.id).filter(Boolean);
  for (const id of existingIds) await internalApi('DELETE', `/api/v1/sessions/${id}`);
  const created = [];
  for (const suffix of ['a', 'b', 'c', 'd']) {
    const r = await internalApi('POST', '/api/v1/sessions', { runtime: 'pi', cwd: `${WORKSPACE}-${suffix}`, model: 'zai/glm-5.3-flash' });
    created.push(r.body?.sessionId);
  }
  step('sessions', { created });
  const [sessA, sessB, sessC, sessD] = created;
  if (!sessA || !sessB || !sessC || !sessD) throw new Error('could not create four sessions');

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  await context.addInitScript(PROBE);
  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(EVIDENCE, name) });
    report.screenshots.push(name);
    writeReport();
    console.log('  screenshot:', name);
  };

  const pickFromPicker = async (sessionId, tag) => {
    const store = await page.evaluate(STORE_STATE);
    const index = store.activeSessions.indexOf(sessionId);
    if (index < 0) throw new Error(`${tag}: intended session ${sessionId} not in picker list ${JSON.stringify(store.activeSessions)}`);
    await page.locator('h2:has-text("Continue a Session") ~ div button').nth(index).click();
  };

  // ---- ONE page: login ------------------------------------------------------
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 30000 });
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#password', { state: 'detached', timeout: 30000 });
  step('login', 'ok (ONE page only — no second tab is ever opened)');

  // ---- enter Voice Mode on session A ---------------------------------------
  await page.click('[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
  await page.click('button[aria-label="Continue an existing session"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  await pickFromPicker(sessA, 'laneA');
  await page.waitForSelector('[aria-label="Start recording"]', { timeout: 30000 });
  const bound = await page.evaluate(STORE_STATE);
  if (bound.currentSessionId !== sessA) throw new Error(`bound ${bound.currentSessionId}, expected ${sessA}`);
  await sleep(600);
  const collapsed = await page.evaluate(STRIP);
  step('voiceMode.A.entered', { strip: collapsed });
  await shot(page, '01-single-lane.png');
  verdict(
    'singleLane.collapse',
    collapsed.collapsed === true && collapsed.present === false,
    collapsed.collapsed ? 'one lane: no rows, no cap counter — the shipped surface with only the "+" affordance' : `strip unexpectedly visible: ${JSON.stringify(collapsed)}`
  );

  // ---- 2. add lane B through the picker, in place --------------------------
  await page.click('[aria-label="Add a lane"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  await pickFromPicker(sessB, 'laneB');
  await sleep(1500);
  const twoLanes = await page.evaluate(STRIP);
  step('lanes.two', { strip: twoLanes });
  await shot(page, '02-two-lanes.png');
  verdict(
    'lanes.two.inOneTab',
    twoLanes.present && twoLanes.cap === '2 of 3' && twoLanes.rows.length === 2,
    twoLanes.cap === '2 of 3' ? 'two lane rows in ONE page, cap visible "2 of 3"' : `unexpected strip: ${JSON.stringify(twoLanes)}`
  );

  // Both lane surfaces remain mounted (hidden when not addressed).
  const mounted = await page.evaluate(() => ({
    surfaces: [...document.querySelectorAll('[data-drive-session]')].map((el) => ({
      session: el.getAttribute('data-drive-session'),
      hidden: el.hasAttribute('hidden'),
    })),
  }));
  step('lanes.mountedSurfaces', mounted);
  verdict(
    'lanes.perLane.surfacesMounted',
    mounted.surfaces.length === 2 && mounted.surfaces.filter((s) => s.hidden).length === 1,
    'both lanes stay mounted; exactly one (the addressed lane) is visible'
  );

  // ---- 3. addressing switches live -----------------------------------------
  await page.locator('[data-testid="lane-row"]').nth(0).click();
  await sleep(600);
  const afterSwitch = await page.evaluate(STRIP);
  step('lanes.addressSwitched', { strip: afterSwitch });
  verdict(
    'lanes.addressSwitch',
    afterSwitch.rows[0]?.addressed === true && afterSwitch.rows[1]?.addressed === false,
    'one tap on a lane row addresses that worker — without leaving Voice Mode'
  );

  // ---- 4. ONE floor: the operator is never spoken over ----------------------
  await page.evaluate(ATTACH_OBSERVER);
  await sleep(300);

  // 4a. capture is unconditional: take the mic on the addressed lane.
  await page.click('[data-testid="drive-mic"]');
  await sleep(1500);
  const rec = await page.evaluate(READ_PROBE);
  const micState = await page.evaluate(() => document.querySelector('[data-testid="drive-mic"]')?.getAttribute('aria-label'));
  step('floor.A.recording', { probe: rec, micState });
  verdict(
    'capture.unconditional',
    rec.recordersRecording === 1 && micState === 'Stop recording',
    'one capture live, one recorder, mic shows Stop — capture took the floor'
  );

  // 4a-bis. The STRIP shows which lane is audible and which holds the floor
  // (the objective's display clause, asserted during REAL capture).
  const stripDuringCapture = await page.evaluate(STRIP);
  const floorRow = stripDuringCapture.rows.find((row) => row.state?.match(/you have the floor/i));
  const markerRows = stripDuringCapture.rows.filter((row) => row.floorMarker && /has the floor/i.test(row.floorMarker));
  step('floor.stripDuringCapture', { strip: stripDuringCapture });
  await shot(page, '03b-strip-floor-during-capture.png');
  verdict(
    'strip.floorDuringCapture',
    !!floorRow && markerRows.length === stripDuringCapture.rows.length - 1,
    `strip during capture: capturing row reads "${floorRow?.state ?? 'none'}" and the other ${markerRows.length} row(s) announce the floor holder`
  );

  // 4b. NO lane may start speech over the capture: submit a real tier-3
  // answer for lane B through the page's REAL arbiter.
  const submitOutcome = await page.evaluate((sessionB) => {
    return window.__arb.submit({ id: `answer-${sessionB}`, tier: 3, text: 'Worker B answer sentence one. Sentence two.' });
  }, sessB);
  await sleep(1500);
  const duringCapture = await page.evaluate(ARB_STATE);
  step('floor.speechWhileCapture', { submitOutcome, arb: duringCapture });
  verdict(
    'floor.noSpeechOverCapture',
    submitOutcome === 'queued' && duringCapture.operatorSpeaking === true && duringCapture.playing === false && duringCapture.played.length === 0,
    'with capture live, lane B\'s answer queues and not a single chunk plays — nothing speaks over the operator (§4.4 rule 1)'
  );

  // 4c. release; the answer plays at normal volume.
  await page.click('[aria-label="Stop recording"]');
  await sleep(1500);
  const playing = await page.evaluate(ARB_STATE);
  step('floor.playingAfterRelease', { arb: { ...playing, played: playing.played.map((p) => ({ chunk: p.chunk, volume: p.volume })) } });
  verdict(
    'floor.speaksWhenFloorFree',
    playing.playing === true && playing.played.length === 1 && playing.played[0].volume === 1,
    'floor released: lane B\'s answer now plays at volume 1'
  );

  // 4d. capture begins mid-speech: DUCK to 0.15, never stop.
  await page.click('[data-testid="drive-mic"]');
  await sleep(700);
  const ducked = await page.evaluate(ARB_STATE);
  const recAfterDuck = await page.evaluate(READ_PROBE);
  step('floor.duckOnCapture', {
    ducked: ducked.ducked,
    current: ducked.current,
    played: ducked.played.map((p) => ({ chunk: p.chunk, volume: p.volume })),
    volumeChanges: ducked.volumeChanges,
    recordersRecording: recAfterDuck.recordersRecording,
  });
  await shot(page, '03-capture-ducks-speech.png');
  const liveDuck = ducked.volumeChanges.some((c) => c.v === 0.15);
  verdict(
    'floor.duckNeverStop',
    ducked.operatorSpeaking === true && ducked.ducked === true && ducked.current !== null && (liveDuck || ducked.played.some((p) => p.volume === 0.15)),
    'capture began mid-speech: the in-flight chunk ducks (0.15 observed) and stays current — never cut'
  );
  // Clean the floor; hard-stop the hung chunk.
  await page.click('[aria-label="Stop recording"]');
  await sleep(400);
  await page.evaluate(() => window.__arb.stopAll());
  await sleep(400);

  // 4e. two lanes wanting the floor: tier then waiting-time order (arrival).
  await page.evaluate(({ sessA_, sessB_ }) => {
    window.__arb.stopAll();
    window.__played = [];
    window.__volumeChanges = [];
    window.__arb.submit({ id: `answer-${sessB_}`, tier: 3, text: 'Lane B asked first and speaks first.' });
    window.__arb.submit({ id: `answer-${sessA_}`, tier: 3, text: 'Lane A waits its turn.' });
  }, { sessA_: sessA, sessB_: sessB });
  await sleep(600);
  const fairness = await page.evaluate(ARB_STATE);
  step('floor.queueFairness', { arb: { current: fairness.current, queued: fairness.queued, played: fairness.played.map((p) => p.chunk) } });
  verdict(
    'floor.tierThenFifo',
    fairness.current === `answer-${sessB}` && fairness.queued.includes(`answer-${sessA}`) && fairness.played.filter((p) => p.volume === 1).length === 1,
    'same tier, B submitted first: B plays, A queues — waiting-time fairness, never simultaneous'
  );
  await page.evaluate(() => window.__arb.stopAll());
  await sleep(300);

  // ---- 5. the third lane and the cap ---------------------------------------
  await page.click('[aria-label="Add a lane"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  await pickFromPicker(sessC, 'laneC');
  await sleep(1500);
  const threeLanes = await page.evaluate(STRIP);
  step('lanes.three', { strip: threeLanes });
  await shot(page, '04-three-lanes.png');
  verdict(
    'lanes.three.capVisible',
    threeLanes.present && threeLanes.cap === '3 of 3' && threeLanes.rows.length === 3,
    'three lane rows, cap reads "3 of 3"'
  );

  // The fourth lane ASKS — replace or cancel — never appears silently.
  await page.click('[aria-label="Add a lane"]');
  await page.waitForSelector('[data-testid="lane-cap-ask"]', { timeout: 10000 });
  const askText = await page.evaluate(() => document.querySelector('[data-testid="lane-cap-ask"]')?.textContent ?? '');
  const askButtons = await page.evaluate(() => [...document.querySelectorAll('[data-testid="lane-cap-ask"] button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()));
  step('cap.ask', { askText: askText.slice(0, 160), buttons: askButtons });
  await shot(page, '05-cap-ask.png');
  const stripAfterAsk = await page.evaluate(STRIP);
  verdict(
    'cap.fourthLaneAsks',
    askButtons.some((t) => /replace/i.test(t ?? '')) && stripAfterAsk.rows.length === 3,
    'at the cap the "+" asks replace-or-cancel; still exactly 3 lanes — never a silent fourth'
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('[data-testid="lane-cap-ask"] button')]
      .find((b) => /cancel/i.test(b.textContent ?? ''))
      ?.click();
  });
  await sleep(500);

  // ---- 5b. the replace CHOICE, end to end: ask → pick a lane → pick a
  // session → the lane swaps in place, still exactly 3 lanes.
  await page.click('[aria-label="Add a lane"]');
  await page.waitForSelector('[data-testid="lane-cap-ask"]', { timeout: 10000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('[data-testid="lane-cap-ask"] button')]
      .find((b) => /replace/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))
      ?.click();
  });
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  await pickFromPicker(sessD, 'replaceTarget');
  await sleep(1500);
  const afterReplace = await page.evaluate(STRIP);
  const replacedSessions = afterReplace.rows.map((row) => row.session);
  step('cap.replace', { strip: afterReplace });
  await shot(page, '05b-after-replace.png');
  verdict(
    'cap.replace.inPlace',
    afterReplace.rows.length === 3 &&
      afterReplace.cap === '3 of 3' &&
      replacedSessions.includes(sessD) &&
      !replacedSessions.includes(sessA) &&
      replacedSessions.includes(sessB) &&
      replacedSessions.includes(sessC),
    'choosing replace swapped lane 1 for the picked session in place — still exactly 3 lanes, no silent fourth'
  );

  // ---- 6. closing a lane: capture finalises, nothing leaks ------------------
  await page.locator('[data-testid="lane-close"]').last().click();
  await sleep(1500);
  const backToTwo = await page.evaluate(STRIP);
  const finalProbe = await page.evaluate(READ_PROBE);
  step('lanes.afterClose', { strip: backToTwo, probe: finalProbe });
  await shot(page, '06-after-close.png');
  verdict(
    'lanes.close.noLeak',
    backToTwo.rows.length === 2 && backToTwo.cap === '2 of 3' && finalProbe.recordersRecording === 0 && finalProbe.liveTracksNow === 0,
    'lane closed: two rows remain, no recorder or microphone track left live'
  );

  // ---- final ----------------------------------------------------------------
  const failed = Object.entries(report.verdicts).filter(([, v]) => !v.ok);
  report.final = { allOk: failed.length === 0, failed: failed.map(([k]) => k) };
  writeReport();
  await context.close();
  console.log(`\n=== lanes harness ${failed.length === 0 ? 'ALL VERDICTS PASS' : `FAILURES: ${failed.map(([k]) => k).join(', ')}`} — written ${path.join(EVIDENCE, 'lanes.json')}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  step('FATAL', String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
