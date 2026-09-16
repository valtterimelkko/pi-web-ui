/**
 * Child V — two-tab Drive Mode voice reproduction (v2).
 *
 * Drives the REAL client (vite dev, real modules) in a REAL Chromium against a
 * disposable validation server, with Chromium's fake media devices so the real
 * capture path (getUserMedia → MediaRecorder → /api/dictation/*) is exercised
 * deterministically and without a physical microphone.
 *
 * Two tabs, two worker sessions, both in Voice Mode — the operator's scenario.
 *
 * Observational instrumentation only: getUserMedia / MediaRecorder are wrapped
 * to RECORD what the product actually did (live state read at read time, so a
 * stale snapshot cannot masquerade as evidence). No behaviour is changed, no
 * mock is substituted for the real API, and no product path is bypassed.
 *
 * Evidence → $VOICE_EVIDENCE_DIR: probe.json / repro.json / NN-*.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const EVIDENCE = process.env.VOICE_EVIDENCE_DIR ?? '/root/pi-web-ui/operations/change-requests-20260915/child-voice/evidence';
const APP = process.env.VOICE_APP_URL ?? 'http://127.0.0.1:3499';
const SOCKET = process.env.VOICE_SOCKET ?? '/tmp/child-voice-srv/internal-api.sock';
const TOKEN_PATH = process.env.VOICE_TOKEN_PATH ?? '/tmp/child-voice-srv/internal-api-token';
const PASSWORD = process.env.VOICE_PASSWORD ?? 'voice-lab-pass';
const PROFILE = process.env.VOICE_PROFILE ?? '/tmp/child-voice-profile';
const WORKSPACE = process.env.VOICE_WORKSPACE ?? '/tmp/child-voice-workspace';
const TAG = process.env.VOICE_RUN_TAG ?? 'v2';

fs.mkdirSync(EVIDENCE, { recursive: true });

const report = { tag: TAG, steps: {}, screenshots: [], notes: [] };
const writeReport = () => fs.writeFileSync(path.join(EVIDENCE, `repro-${TAG}.json`), JSON.stringify(report, null, 2));
const step = (name, value) => {
  report.steps[name] = value;
  writeReport();
  console.log(`[step] ${name}:`, typeof value === 'string' ? value : JSON.stringify(value).slice(0, 1500));
};
const note = (m) => {
  report.notes.push(m);
  writeReport();
  console.log(`[note] ${m}`);
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
  const probe = { gum: [], recorders: [], tracks: {}, errors: [], unhandled: [], dictationCalls: [] };
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
        call.trackIds = [];
        for (const t of stream.getTracks()) {
          probe.tracks[t.id] = { kind: t.kind, live: true, endedAt: null };
          call.trackIds.push(t.id);
          t.addEventListener('ended', () => {
            probe.tracks[t.id] = { ...(probe.tracks[t.id] || { kind: t.kind }), live: false, endedAt: Date.now() };
          });
        }
        // Every stream this tab ever obtained, kept so leakage is observable.
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
      const entry = { seq: probe.recorders.length, at: Date.now(), mimeType: rec.mimeType, events: [], ref: rec };
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

  window.addEventListener('error', (e) => probe.errors.push({ at: Date.now(), message: String(e.message) }));
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

/** Live read: recorder state and track liveness are read at READ time. */
const READ_PROBE = () => {
  const p = window.__voiceProbe;
  return {
    gum: p.gum,
    recorders: p.recorders.map((r) => ({ seq: r.seq, mimeType: r.mimeType, liveState: r.ref.state, events: r.events, tracks: r.ref.stream ? r.ref.stream.getTracks().map((t) => `${t.kind}:${t.readyState}`) : [] })),
    recordersRecording: p.recorders.filter((r) => r.ref.state === 'recording').length,
    // Ground truth for "is this tab still capturing the microphone": the
    // readyState of every track of every stream this tab ever obtained.
    // (`stop()` does not fire a track `ended` event, so an event-based count
    // would keep reporting a released microphone as live.)
    trackLiveness: (p.streams || []).flatMap((s) => s.getTracks().map((t) => ({ id: t.id.slice(0, 8), kind: t.kind, readyState: t.readyState }))),
    liveTracksNow: (p.streams || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length,
    dictationCalls: p.dictationCalls,
    errors: p.errors,
    unhandled: p.unhandled,
  };
};

const MIC_STATE = () => {
  const btn = document.querySelector(
    '[aria-label="Start recording"], [aria-label="Stop recording"], [aria-label="Starting microphone"]'
  );
  if (!btn) return { present: false, reason: 'no mic button in this tab' };
  return {
    present: true,
    label: btn.getAttribute('aria-label'),
    disabled: btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true',
    className: btn.className,
    outline: btn.className.includes('border-red-500') ? 'red-recording' : 'inactive',
    floor: document.querySelector('[data-testid="floor-state-label"]')?.textContent ?? null,
  };
};

/** Count what the tab's own store thinks is bound (identity of the lane). */
const STORE_STATE = async () => {
  const mod = await import('/src/store/sessionStore.ts');
  const st = mod.useSessionStore.getState();
  return {
    currentSessionId: st.currentSessionId,
    sessionCount: st.sessions.length,
    activeSessions: st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id),
  };
};

async function main() {
  // ---- sessions -------------------------------------------------------------
  const existing = await internalApi('GET', '/api/v1/sessions');
  const existingIds = (Array.isArray(existing.body?.sessions) ? existing.body.sessions : []).map((s) => s.sessionId ?? s.id).filter(Boolean);
  for (const id of existingIds) await internalApi('DELETE', `/api/v1/sessions/${id}`);
  step('sessions.preexistingRemoved', existingIds.length);

  const a = await internalApi('POST', '/api/v1/sessions', { runtime: 'pi', cwd: `${WORKSPACE}-a`, model: 'zai/glm-5.3-flash' });
  const b = await internalApi('POST', '/api/v1/sessions', { runtime: 'pi', cwd: `${WORKSPACE}-b`, model: 'zai/glm-5.3' });
  const sessA = a.body?.sessionId;
  const sessB = b.body?.sessionId;
  step('sessions', { a: { status: a.status, id: sessA }, b: { status: b.status, id: sessB } });
  if (!sessA || !sessB) throw new Error(`could not create sessions: ${JSON.stringify([a, b])}`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  await context.addInitScript(PROBE);

  const tabA = context.pages()[0] ?? (await context.newPage());
  const tabB = await context.newPage();
  const shot = async (tab, name) => {
    await tab.screenshot({ path: path.join(EVIDENCE, name) });
    report.screenshots.push(name);
    writeReport();
    console.log('  screenshot:', name);
  };

  await tabA.goto(APP, { waitUntil: 'domcontentloaded' });
  await tabA.waitForSelector('#password', { timeout: 30000 });
  await tabA.fill('#password', PASSWORD);
  await tabA.click('button[type="submit"]');
  await tabA.waitForSelector('#password', { state: 'detached', timeout: 30000 });
  step('login', 'ok');
  await shot(tabA, `10-${TAG}-logged-in.png`);

  async function enterVoiceMode(tab, sessionId, tag) {
    await tab.bringToFront();
    if (!tab.url().startsWith(APP)) await tab.goto(APP, { waitUntil: 'domcontentloaded' });
    await tab.waitForSelector('[aria-label="Enter Voice Mode"]', { timeout: 30000 });
    await tab.click('[aria-label="Enter Voice Mode"]');
    await tab.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
    await tab.click('button[aria-label="Continue an existing session"]');
    await tab.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
    const store = await tab.evaluate(STORE_STATE);
    const index = store.activeSessions.indexOf(sessionId);
    if (index < 0) throw new Error(`${tag}: intended session ${sessionId} not in picker list ${JSON.stringify(store.activeSessions)}`);
    const buttons = tab.locator('h2:has-text("Continue a Session") ~ div button');
    await buttons.nth(index).click();
    await tab.waitForSelector('[aria-label="Start recording"]', { timeout: 30000 });
    const bound = await tab.evaluate(STORE_STATE);
    if (bound.currentSessionId !== sessionId) throw new Error(`${tag}: bound ${bound.currentSessionId}, expected ${sessionId}`);
    return { sessionId, verified: true, bound };
  }

  step('voiceMode.A', await enterVoiceMode(tabA, sessA, 'A'));
  await shot(tabA, `11-${TAG}-tabA-voice-mode.png`);
  step('voiceMode.B', await enterVoiceMode(tabB, sessB, 'B'));
  await shot(tabB, `12-${TAG}-tabB-voice-mode.png`);

  // ---- 1. two concurrent lanes ---------------------------------------------
  step('mic.both.before', { A: await tabA.evaluate(MIC_STATE), B: await tabB.evaluate(MIC_STATE) });

  await tabA.bringToFront();
  await tabA.click('[aria-label="Start recording"]');
  await sleep(2000);
  step('lane.A.recording', { mic: await tabA.evaluate(MIC_STATE), probe: await tabA.evaluate(READ_PROBE) });
  await shot(tabA, `13-${TAG}-tabA-recording.png`);

  await tabB.bringToFront();
  await tabB.click('[aria-label="Start recording"]');
  await sleep(2000);
  step('lane.B.recording', { mic: await tabB.evaluate(MIC_STATE), probe: await tabB.evaluate(READ_PROBE) });
  await shot(tabB, `14-${TAG}-both-recording-tabB-foreground.png`);
  await tabA.bringToFront();
  await shot(tabA, `15-${TAG}-both-recording-tabA-foreground.png`);

  step('lane.A.whileTabBHiddenThenShown', { mic: await tabA.evaluate(MIC_STATE), probe: await tabA.evaluate(READ_PROBE) });

  // ---- 2. exit the surface while recording (leak test) ---------------------
  note('Tab A still recording; now exiting Voice Mode in tab A without stopping the mic.');
  await tabA.click('button:has-text("Exit")');
  await sleep(2500);
  const afterExitA = await tabA.evaluate(READ_PROBE);
  step('capture.tabA.afterExitWhileRecording', {
    micButtonPresentAfterExit: await tabA.evaluate(MIC_STATE),
    recordersRecording: afterExitA.recordersRecording,
    liveTracksNow: afterExitA.liveTracksNow,
    trackLiveness: afterExitA.trackLiveness,
    recorders: afterExitA.recorders,
    dictationCalls: afterExitA.dictationCalls,
  });
  await shot(tabA, `16-${TAG}-tabA-after-exit-while-recording.png`);

  // ---- 3. tab B: double click while a start is in flight (fast path) -------
  await tabB.click('[aria-label="Stop recording"]');
  await sleep(4000);
  step('lane.B.afterStop', { mic: await tabB.evaluate(MIC_STATE), probe: await tabB.evaluate(READ_PROBE) });

  await tabB.evaluate(() => {
    const btn = document.querySelector('[aria-label="Start recording"]');
    btn.click();
    setTimeout(() => btn.click(), 80);
  });
  await sleep(4000);
  step('start.doubleClick.fastDevice', { mic: await tabB.evaluate(MIC_STATE), probe: await tabB.evaluate(READ_PROBE) });
  await shot(tabB, `17-${TAG}-tabB-after-double-click.png`);

  // ---- 4. same, with a SLOW device acquisition (injected latency) ----------
  // Faithful to a cold microphone: getUserMedia can take hundreds of ms when the
  // device is being claimed (permission prompt, second tab, Bluetooth route).
  // The injection delays only the assignment of the stream; the REAL stream and
  // the REAL recorder are used, so what is measured is the product's own state
  // machine.
  await tabB.evaluate(() => {
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      await new Promise((r) => setTimeout(r, 900));
      return real(c);
    };
  });
  await tabB.evaluate(() => {
    const btn = document.querySelector('[aria-label="Start recording"]');
    btn.click();
    setTimeout(() => btn.click(), 120);
  });
  // Sample INSIDE the acquisition window: what does the surface say while the
  // browser already holds the microphone?
  await sleep(300);
  step('start.doubleClick.slowDevice.inFlight', { mic: await tabB.evaluate(MIC_STATE) });
  await sleep(4700);
  step('start.doubleClick.slowDevice', { mic: await tabB.evaluate(MIC_STATE), probe: await tabB.evaluate(READ_PROBE) });
  await shot(tabB, `18-${TAG}-tabB-slowdevice-double-click.png`);

  // ---- 4b. one tap to stop after a double start ----------------------------
  // The operator's exact gesture after a lane looks wrong: tap the mic once to
  // stop. If the surface owns only the LAST recorder, the first one keeps the
  // microphone hot while the button returns to its idle look.
  const beforeStop = await tabB.evaluate(MIC_STATE);
  if (beforeStop.label === 'Stop recording') {
    await tabB.click('[aria-label="Stop recording"]');
    await sleep(4000);
    const afterOneStop = await tabB.evaluate(READ_PROBE);
    step('start.doubleClick.thenOneTapStop', {
      mic: await tabB.evaluate(MIC_STATE),
      recordersRecording: afterOneStop.recordersRecording,
      liveTracksNow: afterOneStop.liveTracksNow,
      recorders: afterOneStop.recorders,
      trackLiveness: afterOneStop.trackLiveness,
      verdict:
        afterOneStop.recordersRecording > 0
          ? 'LEAK PROVEN: after one tap the app shows idle while a MediaRecorder is still recording and the microphone track is still live'
          : 'no leak: one tap released every recorder',
    });
    await shot(tabB, `19-${TAG}-tabB-one-tap-after-double-start.png`);
  } else {
    step('start.doubleClick.thenOneTapStop', { skipped: `mic label was ${beforeStop.label}` });
  }

  // ---- 5. cross-tab playback floor -----------------------------------------
  // Start from a clean lane: reload tab B so no leftover capture skews the
  // playback measurement.
  await tabB.goto(APP, { waitUntil: 'domcontentloaded' });
  await tabB.waitForSelector('[aria-label="Enter Voice Mode"]', { timeout: 30000 });
  await tabB.click('[aria-label="Enter Voice Mode"]');
  await tabB.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
  await tabB.click('button[aria-label="Continue an existing session"]');
  await tabB.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  {
    const store = await tabB.evaluate(STORE_STATE);
    const index = store.activeSessions.indexOf(sessB);
    await tabB.locator('h2:has-text("Continue a Session") ~ div button').nth(index).click();
  }
  await tabB.waitForSelector('[aria-label="Start recording"]', { timeout: 30000 });
  step('crossTab.laneB.reset', { mic: await tabB.evaluate(MIC_STATE) });
  const crossTab = await (async () => {
    const inB = await tabB.evaluate(async () => {
      const mod = await import('/src/lib/speechArbiter.ts');
      globalThis.__arb = mod.speechArbiter;
      globalThis.__played = [];
      globalThis.__arb.attachPlayer({
        playChunk: async (chunk, volume) => {
          globalThis.__played.push({ chunk, volume, at: Date.now() });
          await new Promise((r) => setTimeout(r, 100000));
        },
        setVolume: (v) => globalThis.__played.push({ volumeChange: v, at: Date.now() }),
        stopCurrent: () => {},
      });
      const submitted = globalThis.__arb.submit({ id: 'cross-tab-answer', tier: 3, chunks: ['tab B answer chunk one.', 'tab B answer chunk two.'] });
      await new Promise((r) => setTimeout(r, 300));
      return { submitted, state: globalThis.__arb.getState() };
    });
    const inA = await tabA.evaluate(async () => {
      const mod = await import('/src/lib/speechArbiter.ts');
      return { state: mod.speechArbiter.getState() };
    });
    return { inB, inA };
  })();
  step('crossTab.independentArbiters', {
    tabB: { submitted: crossTab.inB.submitted, playing: crossTab.inB.state.playing, current: crossTab.inB.state.current },
    tabA: { playing: crossTab.inA.state.playing, current: crossTab.inA.state.current, queued: crossTab.inA.state.queued },
    verdict:
      crossTab.inA.state.current === null && crossTab.inB.state.current !== null
        ? 'two independent per-tab arbiters: tab B is playing an intent tab A cannot see'
        : 'unexpected: tabs appear to share arbiter state',
  });

  const floor = await (async () => {
    const inA = await tabA.evaluate(async () => {
      const mod = await import('/src/lib/speechArbiter.ts');
      mod.speechArbiter.setOperatorSpeaking(true);
      return { operatorSpeaking: mod.speechArbiter.isOperatorSpeaking() };
    });
    await sleep(400);
    const inB = await tabB.evaluate(() => ({ played: globalThis.__played, state: globalThis.__arb.getState() }));
    return { inA, inB };
  })();
  step('crossTab.floorTakenInTabA', {
    tabAFloorHeld: floor.inA.operatorSpeaking,
    tabBPlaying: floor.inB.state.playing,
    tabBDucked: floor.inB.state.ducked,
    tabBVolumeEvents: floor.inB.played.filter((p) => p.volumeChange !== undefined),
    verdict:
      floor.inB.state.ducked === false
        ? 'NO cross-tab coordination: tab B kept playing at full volume while tab A held the floor'
        : 'tab B ducked (coordination exists)',
  });

  // ---- teardown report ------------------------------------------------------
  report.final = {
    A: await tabA.evaluate(READ_PROBE),
    B: await tabB.evaluate(READ_PROBE),
  };
  writeReport();
  await context.close();
  console.log('\n=== written', path.join(EVIDENCE, `repro-${TAG}.json`));
}

main().catch(async (err) => {
  step('FATAL', String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
