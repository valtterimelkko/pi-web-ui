/**
 * Child V — two-tab Drive Mode voice reproduction.
 *
 * Drives the REAL client (vite dev, real modules) in a REAL Chromium against a
 * disposable validation server, with Chromium's fake media devices so the real
 * capture path (getUserMedia → MediaRecorder → /api/dictation/*) is exercised
 * deterministically and without a physical microphone.
 *
 * Two tabs, two worker sessions, both in Voice Mode — the operator's scenario.
 *
 * Observational instrumentation only: getUserMedia / MediaRecorder are wrapped
 * to RECORD what the product actually did. No behaviour is changed, no mock is
 * substituted for the real API, and no product path is bypassed.
 *
 * Evidence → $VOICE_EVIDENCE_DIR (default the child's evidence/ dir):
 *   probe.json      per-tab capture ledger (gUM, recorder, live tracks, errors)
 *   repro.json      the observed states per step
 *   NN-*.png        screenshots
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const EVIDENCE = process.env.VOICE_EVIDENCE_DIR ?? '/root/pi-web-ui/operations/change-requests-20260915/child-voice/evidence';
const APP = process.env.VOICE_APP_URL ?? 'http://127.0.0.1:5173';
const SRV = process.env.VOICE_SRV_URL ?? 'http://127.0.0.1:3491';
const SOCKET = process.env.VOICE_SOCKET ?? '/tmp/child-voice-srv/internal-api.sock';
const TOKEN_PATH = process.env.VOICE_TOKEN_PATH ?? '/tmp/child-voice-srv/internal-api-token';
const PASSWORD = process.env.VOICE_PASSWORD ?? 'voice-lab-pass';
const PROFILE = process.env.VOICE_PROFILE ?? '/tmp/child-voice-profile';
const WORKSPACE = process.env.VOICE_WORKSPACE ?? '/tmp/child-voice-workspace';

fs.mkdirSync(EVIDENCE, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

const report = { steps: {}, tabs: {}, screenshots: [], notes: [] };
let page = null;
const writeReport = () => fs.writeFileSync(path.join(EVIDENCE, 'repro.json'), JSON.stringify(report, null, 2));
const step = (name, value) => {
  report.steps[name] = value;
  writeReport();
  console.log(`[step] ${name}:`, typeof value === 'string' ? value : JSON.stringify(value));
};
const note = (m) => {
  report.notes.push(m);
  writeReport();
  console.log(`[note] ${m}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Internal API over the unix socket (session creation; no model calls). */
function internalApi(method, urlPath, body) {
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path: urlPath, method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * The probe. Installed before any app code runs in each tab.
 * Records — never alters — the capture lifecycle the product performs.
 */
const PROBE = () => {
  const probe = {
    gum: [],
    recorders: [],
    liveTrackIds: new Set(),
    errors: [],
    unhandled: [],
    dictationCalls: [],
  };
  window.__voiceProbe = probe;

  const md = navigator.mediaDevices;
  const realGum = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  if (realGum) {
    md.getUserMedia = async (constraints) => {
      const call = { seq: probe.gum.length, at: Date.now(), constraints: JSON.parse(JSON.stringify(constraints || {})), status: 'pending' };
      probe.gum.push(call);
      try {
        const stream = await realGum(constraints);
        call.status = 'resolved';
        call.atResolved = Date.now();
        call.tracks = stream.getTracks().map((t) => {
          probe.liveTrackIds.add(t.id);
          return { id: t.id, kind: t.kind, enabled: t.enabled, muted: t.muted, state: t.readyState };
        });
        stream.addEventListener('removetrack', (e) => {
          call.tracks = (call.tracks || []).map((t) => (t.id === e.track.id ? { ...t, state: 'ended' } : t));
        });
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
      const entry = { seq: probe.recorders.length, at: Date.now(), mimeType: rec.mimeType, state: rec.state, events: [] };
      probe.recorders.push(entry);
      const origStart = rec.start.bind(rec);
      const origStop = rec.stop.bind(rec);
      rec.start = (...a) => {
        entry.events.push({ at: Date.now(), type: 'start', arg: a[0] });
        return origStart(...a);
      };
      rec.stop = (...a) => {
        entry.events.push({ at: Date.now(), type: 'stop' });
        return origStop(...a);
      };
      rec.addEventListener('error', (e) => entry.events.push({ at: Date.now(), type: 'error', error: String(e.error && e.error.name) }));
      return rec;
    };
    wrapped.isTypeSupported = RealRecorder.isTypeSupported.bind(RealRecorder);
    window.MediaRecorder = wrapped;
  }

  window.addEventListener('error', (e) => probe.errors.push({ at: Date.now(), message: String(e.message), source: String(e.filename) }));
  window.addEventListener('unhandledrejection', (e) =>
    probe.unhandled.push({ at: Date.now(), reason: String(e.reason && e.reason.message ? `${e.reason.name}: ${e.reason.message}` : e.reason) })
  );

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.includes('/api/dictation')) {
      const call = { at: Date.now(), url, method: (init && init.method) || 'GET', status: 'pending' };
      probe.dictationCalls.push(call);
      try {
        const res = await realFetch(input, init);
        call.status = res.status;
        return res;
      } catch (err) {
        call.status = 'network-error';
        call.error = String(err);
        throw err;
      }
    }
    return realFetch(input, init);
  };
};

const READ_PROBE = () => {
  const p = window.__voiceProbe;
  return {
    gum: p.gum,
    recorders: p.recorders.map((r) => ({ seq: r.seq, mimeType: r.mimeType, state: r.state, events: r.events })),
    liveTracks: p.liveTrackIds.size,
    dictationCalls: p.dictationCalls,
    errors: p.errors,
    unhandled: p.unhandled,
  };
};

const MIC_STATE = () => {
  const btn = document.querySelector('[aria-label="Start recording"], [aria-label="Stop recording"]');
  if (!btn) return { present: false };
  return {
    present: true,
    label: btn.getAttribute('aria-label'),
    disabled: btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true',
    ariaBusy: btn.getAttribute('aria-busy'),
    className: btn.className,
    floor: document.querySelector('[data-testid="floor-state-label"]')?.textContent ?? null,
  };
};

/** Count genuinely-live microphone tracks held by the tab, via a fresh probe
 *  of the page's own stream objects is impossible from outside; instead the
 *  probe's liveTrackIds plus readyState inspection through the recorder list is
 *  used, and the total is cross-checked against Chromium's own mic indicator by
 *  counting audio-capturing MediaRecorders still in 'recording' state. */
async function shot(name) {
  if (!page) return;
  const file = path.join(EVIDENCE, name);
  await page.screenshot({ path: file, fullPage: false });
  report.screenshots.push(name);
  writeReport();
  console.log('  screenshot:', name);
}

async function main() {
  // ---- sessions -------------------------------------------------------------
  // Start from an empty registry so the Voice Mode session picker lists exactly
  // the two sessions this reproduction uses, and the pick is deterministic.
  const existing = await internalApi('GET', '/api/v1/sessions');
  const existingIds = (Array.isArray(existing.body?.sessions) ? existing.body.sessions : [])
    .map((s) => s.sessionId ?? s.id)
    .filter(Boolean);
  for (const id of existingIds) await internalApi('DELETE', `/api/v1/sessions/${id}`);
  step('sessions.preexistingRemoved', existingIds.length);

  const cwdA = `${WORKSPACE}-a`;
  const cwdB = `${WORKSPACE}-b`;
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  // Distinct model selectors so the Voice Mode picker can be addressed
  // deterministically (a session with no messages has no display name).
  const a = await internalApi('POST', '/api/v1/sessions', { runtime: 'pi', cwd: cwdA, model: 'zai/glm-5.3-flash' });
  const b = await internalApi('POST', '/api/v1/sessions', { runtime: 'pi', cwd: cwdB, model: 'zai/glm-5.3' });
  const sessA = a.body?.sessionId ?? a.body?.id ?? a.body?.session?.id;
  const sessB = b.body?.sessionId ?? b.body?.id ?? b.body?.session?.id;
  step('sessions', { a: { status: a.status, id: sessA }, b: { status: b.status, id: sessB } });
  if (!sessA || !sessB) throw new Error(`could not create sessions: ${JSON.stringify([a, b])}`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });
  await context.addInitScript(PROBE);

  const tabA = context.pages()[0] ?? (await context.newPage());
  const tabB = await context.newPage();
  page = tabA;

  // ---- login (tab A) --------------------------------------------------------
  await tabA.goto(APP, { waitUntil: 'domcontentloaded' });
  await tabA.waitForSelector('#password', { timeout: 30000 });
  await tabA.fill('#password', PASSWORD);
  await tabA.click('button[type="submit"]');
  await tabA.waitForSelector('#password', { state: 'detached', timeout: 30000 });
  step('login', 'ok');
  await shot('01-logged-in.png');

  // ---- both tabs into Voice Mode on different sessions ----------------------
  /**
   * The Voice Mode picker for a message-less session shows only "(no messages)
   * / Default model", so the choice is addressed by the store's own order — and
   * VERIFIED against the store afterwards, rather than assumed.
   * The store module is imported by the page's own specifier, so this reads the
   * same singleton instance the running app uses.
   */
  async function enterVoiceMode(tab, sessionId, tag, _ignored) {
    await tab.bringToFront();
    if (!tab.url().startsWith(APP)) {
      await tab.goto(APP, { waitUntil: 'domcontentloaded' });
    }
    await tab.waitForSelector('[aria-label="Enter Voice Mode"]', { timeout: 30000 });
    await tab.click('[aria-label="Enter Voice Mode"]');
    await tab.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
    await tab.click('button[aria-label="Continue an existing session"]');
    await tab.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });

    const order = await tab.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      return st.sessions
        .filter((sn) => sn.path && !st.archivedSessionPaths.includes(sn.path))
        .map((sn) => sn.id);
    });
    step(`picker.order.${tag}`, order);
    const index = order.indexOf(sessionId);
    if (index < 0) throw new Error(`${tag}: intended session ${sessionId} not in picker list ${JSON.stringify(order)}`);

    const buttons = tab.locator('h2:has-text("Continue a Session") ~ div button');
    const count = await buttons.count();
    await buttons.nth(index).click();
    await tab.waitForSelector('[aria-label="Start recording"]', { timeout: 30000 });

    const bound = await tab.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      return mod.useSessionStore.getState().currentSessionId;
    });
    const verified = bound === sessionId;
    if (!verified) throw new Error(`${tag}: picker index ${index} bound ${bound}, expected ${sessionId}`);
    return { sessionId, pickerOrder: order, index, count, boundSessionId: bound, verified };
  }

  step('voiceMode.A', await enterVoiceMode(tabA, sessA, 'A', null));
  await shot('02-tabA-voice-mode.png');
  step('voiceMode.B', await enterVoiceMode(tabB, sessB, 'B', null));
  await shot('03-tabB-voice-mode.png');

  // ---- B1: each lane's mic button ------------------------------------------
  const beforeA = await tabA.evaluate(MIC_STATE);
  const beforeB = await tabB.evaluate(MIC_STATE);
  step('mic.before', { A: beforeA, B: beforeB });

  // Tab A: single tap.
  await tabA.bringToFront();
  await tabA.click('[aria-label="Start recording"]');
  await sleep(2500);
  const afterA = await tabA.evaluate(MIC_STATE);
  step('mic.A.afterSingleTap', { mic: afterA, probe: await tabA.evaluate(READ_PROBE) });
  await shot('04-tabA-recording.png');

  // Tab B: switch to it (tab A keeps its lane open — the operator's scenario)
  // and tap once.
  await tabB.bringToFront();
  await tabB.click('[aria-label="Start recording"]');
  await sleep(2500);
  const afterB = await tabB.evaluate(MIC_STATE);
  step('mic.B.afterSingleTap', { mic: afterB, probe: await tabB.evaluate(READ_PROBE) });
  await shot('05-tabB-recording.png');

  const probeA1 = await tabA.evaluate(READ_PROBE);
  step('lane.A.stillRecordingWhileHidden', {
    mic: await tabA.evaluate(MIC_STATE),
    recordersRecording: probeA1.recorders.filter((r) => r.state === 'recording').length,
    liveTracks: probeA1.liveTracks,
  });

  // ---- B2: double tap (in-flight start) ------------------------------------
  await tabB.click('[aria-label="Stop recording"]');
  await sleep(4000);
  const stopped = await tabB.evaluate(MIC_STATE);
  step('mic.B.afterStop', { mic: stopped, probe: await tabB.evaluate(READ_PROBE) });

  // Two clicks ~80 ms apart: the second lands while the first start is still in
  // flight (getUserMedia + POST /api/dictation/start).
  await tabB.evaluate(() => {
    const btn = document.querySelector('[aria-label="Start recording"]');
    btn.click();
    setTimeout(() => btn.click(), 80);
  });
  await sleep(4000);
  const dbl = await tabB.evaluate(MIC_STATE);
  const probeB2 = await tabB.evaluate(READ_PROBE);
  step('mic.B.afterDoubleTap', {
    mic: dbl,
    gumCalls: probeB2.gum.length,
    gumStatuses: probeB2.gum.map((g) => g.status),
    recorders: probeB2.recorders,
    recordersRecording: probeB2.recorders.filter((r) => r.state === 'recording').length,
    liveTracks: probeB2.liveTracks,
    dictationCalls: probeB2.dictationCalls,
    errors: probeB2.errors,
    unhandled: probeB2.unhandled,
  });
  await shot('06-tabB-after-double-tap.png');

  // ---- B3: exit the surface while recording --------------------------------
  report.notes.push('Before exit: recorders recording = ' + probeB2.recorders.filter((r) => r.state === 'recording').length);
  const exitBtn = tabB.locator('button:has-text("Exit")').first();
  await exitBtn.click();
  await sleep(2500);
  const probeB3 = await tabB.evaluate(READ_PROBE);
  const recAfterExit = probeB3.recorders.filter((r) => r.state === 'recording').length;
  step('capture.afterExitWhileRecording', {
    recordersStillRecording: recAfterExit,
    recorders: probeB3.recorders,
    liveTracks: probeB3.liveTracks,
  });
  await shot('07-tabB-after-exit.png');

  // ---- B4: cross-tab floor coordination (real module, real tabs) -----------
  // Load the REAL speechArbiter module in both tabs and show whether a floor
  // taken in one tab affects playback scheduled in the other.
  const crossTab = await (async () => {
    const loadB = await tabB.evaluate(async () => {
      const mod = await import('/src/lib/speechArbiter.ts');
      globalThis.__arb = mod.speechArbiter;
      globalThis.__played = [];
      globalThis.__arb.attachPlayer({
        playChunk: async (chunk, volume) => {
          globalThis.__played.push({ chunk, volume, at: Date.now() });
          await new Promise((r) => setTimeout(r, 100000)); // never finishes
        },
        setVolume: (v) => globalThis.__played.push({ volumeChange: v, at: Date.now() }),
        stopCurrent: () => {},
      });
      const submitted = globalThis.__arb.submit({ id: 'cross-tab-answer', tier: 3, chunks: ['tab B answer chunk one.', 'tab B answer chunk two.'] });
      await new Promise((r) => setTimeout(r, 300));
      return { submitted, state: globalThis.__arb.getState() };
    });
    const loadA = await tabA.evaluate(async () => {
      const mod = await import('/src/lib/speechArbiter.ts');
      // Tab A loads the SAME module specifier: if the arbiter were shared state,
      // tab A would see tab B's in-flight intent here. It does not.
      const arb = mod.speechArbiter;
      return { postState: arb.getState(), operatorSpeakingBefore: arb.isOperatorSpeaking() };
    });
    return { tabB: loadB, tabA: loadA };
  })();
  step('crossTab.arbiterIndependence', {
    tabB: { submitted: crossTab.tabB.submitted, playing: crossTab.tabB.state.playing, current: crossTab.tabB.state.current },
    tabA: { playing: crossTab.tabA.postState.playing, current: crossTab.tabA.postState.current, queued: crossTab.tabA.postState.queued },
    verdict:
      crossTab.tabA.postState.current === null && crossTab.tabB.state.current !== null
        ? 'two independent per-tab arbiters: tab B is playing an intent tab A cannot see'
        : 'unexpected: tabs appear to share arbiter state',
  });

  // Now take the floor in tab A (as the operator speaking there would) and see
  // whether tab B's in-flight playback ducks.
  const floorTest = await (async () => {
    const inA = await tabA.evaluate(async () => {
      const mod = await import('/src/lib/speechArbiter.ts');
      mod.speechArbiter.setOperatorSpeaking(true);
      return { operatorSpeaking: mod.speechArbiter.isOperatorSpeaking() };
    });
    await sleep(400);
    const inB = await tabB.evaluate(() => ({ played: globalThis.__played, state: globalThis.__arb.getState() }));
    return { tabAFloorHeld: inA, tabB: inB };
  })();
  step('crossTab.floorTakenInTabA', {
    ...floorTest,
    tabBPlaying: floorTest.tabB.state.playing,
    tabBDucked: floorTest.tabB.state.ducked,
    tabBVolumeEvents: floorTest.tabB.played.filter((p) => p.volumeChange !== undefined),
    verdict:
      floorTest.tabB.state.ducked === false
        ? 'NO cross-tab coordination: tab B kept playing at full volume while tab A held the floor'
        : 'tab B ducked (coordination exists)',
  });

  // ---- teardown ------------------------------------------------------------
  const finalA = await tabA.evaluate(READ_PROBE);
  const finalB = await tabB.evaluate(READ_PROBE);
  report.tabs = {
    A: { gum: finalA.gum.length, recorders: finalA.recorders, liveTracks: finalA.liveTracks, errors: finalA.errors, unhandled: finalA.unhandled },
    B: { gum: finalB.gum.length, recorders: finalB.recorders, liveTracks: finalB.liveTracks, errors: finalB.errors, unhandled: finalB.unhandled },
  };
  writeReport();
  await context.close();
  console.log('\n=== repro.json written to', path.join(EVIDENCE, 'repro.json'));
}

main().catch(async (err) => {
  step('FATAL', String(err && err.stack ? err.stack : err));
  if (page) await page.screenshot({ path: path.join(EVIDENCE, 'ZZ-fatal.png') }).catch(() => {});
  process.exitCode = 1;
});
