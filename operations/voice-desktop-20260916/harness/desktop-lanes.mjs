/**
 * Voice Mode desktop rework — real-browser validation (2026-09-16).
 *
 * Proves, against a real client + a disposable server + a REAL pi turn:
 *
 *  1. the desktop session pane renders the SAME organised session view as the
 *     normal chat screen (identical tool-group structure), not raw stream
 *     content — the operator's first complaint;
 *  2. the desktop layout holds the lane strip AND the session pane at once, and
 *     all three lanes are reachable there — the operator's second complaint;
 *  3. any lane's worker can be switched in place (three lanes held, no exit, no
 *     rebuild) and the pane follows the addressed lane — the third complaint.
 *
 * Every assertion is read back from the live DOM / live store after the
 * interaction; the screenshots illustrate the evidence, they are not the
 * evidence.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const OPS = process.env.VOICE_OPS_DIR ?? '/root/pi-web-ui/operations/voice-desktop-20260916';
const EVIDENCE = process.env.VOICE_EVIDENCE_DIR ?? path.join(OPS, 'evidence');
const SHOTS = process.env.VOICE_SHOTS_DIR ?? path.join(OPS, 'shots');
const APP = process.env.VOICE_APP_URL ?? 'http://127.0.0.1:3522';
const SOCKET = process.env.VOICE_SOCKET ?? '/tmp/voice-desktop-srv/internal-api.sock';
const TOKEN_PATH = process.env.VOICE_TOKEN_PATH ?? '/tmp/voice-desktop-srv/internal-api-token';
const PASSWORD = process.env.VOICE_PASSWORD ?? 'voice-lab-pass';
const PROFILE = process.env.VOICE_PROFILE ?? `/tmp/voice-desktop-profile-${process.pid}`;
const WORKSPACE = process.env.VOICE_WORKSPACE ?? '/tmp/voice-desktop-workspace';
const MODEL = process.env.VOICE_MODEL ?? 'openrouter/anthropic/claude-haiku-4.5';
const SKIP_TURN = process.env.VOICE_SKIP_TURN === '1';

// Three tool calls in ONE assistant response: they land as three consecutive
// tool messages, which is exactly the run the client (and the screen-view
// projection) groups into a single ToolGroupContainer — the structure the pane
// must reproduce.
const TOOL_PROMPT =
  'Make three bash tool calls IN PARALLEL in a single response: `echo alpha`, `echo beta`, `echo gamma`. ' +
  'Do not write any text before or between them. After they return, reply with the single word DONE.';

fs.mkdirSync(EVIDENCE, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

let context = null;

const report = { startedAt: new Date().toISOString(), steps: {}, screenshots: [], assertions: [] };
const write = () => fs.writeFileSync(path.join(EVIDENCE, 'desktop-lanes.json'), JSON.stringify(report, null, 2));
const step = (k, v) => {
  report.steps[k] = v;
  write();
  console.log(`[step] ${k}: ${JSON.stringify(v).slice(0, 1400)}`);
};
const check = (name, ok, detail) => {
  report.assertions.push({ name, ok: !!ok, detail });
  write();
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function internalApi(method, urlPath, body) {
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: urlPath,
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        timeout: 300000,
      },
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

/** Read the live client store + DOM — the evidence, not the screenshots. */
const PROBE = () => {
  const q = (sel) => document.querySelector(sel);
  const byTestId = (id) => q(`[data-testid="${id}"]`);
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const groupIds = (root) =>
    Array.from((root ?? document).querySelectorAll('[data-testid^="tool-group-"]'))
      .filter(visible)
      .map((el) => el.getAttribute('data-testid'));
  const pane = byTestId('drive-session-pane');
  const column = byTestId('drive-mode-column');
  const panel = byTestId('drive-session-panel');
  const laneRows = all('[data-testid="lane-row"]');
  const store = (() => {
    try {
      // The dev client exposes the module graph; read the real store.
      const hook = globalThis.__PI_VOICE_PROBE__;
      return hook ? hook() : null;
    } catch {
      return null;
    }
  })();
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    voiceModeOpen: visible(byTestId('drive-mode-entry')) || visible(byTestId('drive-mode-column')) || visible(byTestId('drive-session-panel')),
    chatToolGroups: groupIds(byTestId('chat-interface')),
    chatToolGroupSummaries: groupIds(byTestId('chat-interface')).map(
      (id) => byTestId(id)?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 220) ?? null
    ),
    paneVisible: visible(pane),
    paneSession: pane?.getAttribute('data-drive-session') ?? null,
    paneToolGroups: pane ? groupIds(pane) : [],
    paneToolGroupSummaries: pane
      ? groupIds(pane).map((id) => pane.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 220) ?? null)
      : [],
    paneText: pane ? pane.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    panelVisible: visible(panel),
    sameColumn: !!column && !!panel && !!pane && column.contains(panel) && column.contains(pane),
    panelAfterVoiceBlock: !!column && column.lastElementChild === panel,
    layout: {
      desktopPressed: byTestId('voice-layout-desktop')?.getAttribute('aria-pressed') ?? null,
      mobilePressed: byTestId('voice-layout-mobile')?.getAttribute('aria-pressed') ?? null,
    },
    compact: byTestId('drive-mode-surface')?.getAttribute('data-compact') ?? null,
    laneRowCount: laneRows.length,
    laneCap: byTestId('lane-cap')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    laneRows: laneRows.map((row) => ({
      session: row.getAttribute('data-lane-session'),
      label: row.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
      addressed: row.getAttribute('aria-current') === 'true',
    })),
    laneSwitches: all('[data-testid="lane-switch"]').map((b) => b.getAttribute('data-lane-session')),
    surfaceSwitch: visible(byTestId('drive-switch-session')),
    sessionPaneName: pane?.querySelector('header')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null,
    store,
  };
};

async function main() {
  // ---------------------------------------------------------------- fixtures
  const existing = await internalApi('GET', '/api/v1/sessions');
  const ids = (Array.isArray(existing.body?.sessions) ? existing.body.sessions : []).map((s) => s.sessionId).filter(Boolean);
  for (const id of ids) await internalApi('DELETE', `/api/v1/sessions/${id}`);
  step('cleaned', { removed: ids.length });

  const create = async (label) => {
    const res = await internalApi('POST', '/api/v1/sessions', { runtime: 'pi', cwd: WORKSPACE, model: MODEL });
    const sessionId = res.body?.sessionId;
    const sessionPath = res.body?.sessionPath;
    if (!sessionId) throw new Error(`session create failed (${label}): ${JSON.stringify(res)}`);
    return { label, sessionId, sessionPath };
  };

  // The worker is created LAST so it is the most recent session in the UI.
  const extra = [await create('Bravo'), await create('Charlie'), await create('Delta')];
  const worker = await create('Alpha');
  const fixtures = { worker, extra };
  step('sessions', fixtures);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOTS, name) });
    report.screenshots.push(name);
    write();
    console.log('  shot:', name);
  };

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 60000 });
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#password', { state: 'detached', timeout: 60000 });
  await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 60000 });

  // Expose a read-only probe of the live stores FIRST: the waits below depend
  // on it, so it must exist before the first one runs.
  await page.evaluate(async () => {
    const sessionMod = await import('/src/store/sessionStore.ts');
    const driveMod = await import('/src/store/driveModeStore.ts');
    globalThis.__PI_VOICE_PROBE__ = () => {
      const s = sessionMod.useSessionStore.getState();
      const d = driveMod.useDriveModeStore.getState();
      return {
        sessionIds: s.sessions.map((x) => x.id),
        currentSessionId: s.currentSessionId,
        isStreaming: s.isStreaming,
        messageCount: s.messages.length,
        sessionMessages: Object.fromEntries(Object.entries(s.sessionMessages).map(([k, v]) => [k, v.length])),
        lanes: d.lanes.map((l) => l.sessionId),
        activeSessionId: d.activeSessionId,
        phase: d.phase,
        addingLane: d.addingLane,
        replacingLaneId: d.replacingLaneId,
      };
    };
  });

  // The list arrives over the WebSocket after login; wait for it rather than
  // racing an empty store (the first runs of this harness did exactly that).
  await page.waitForFunction(
    (id) => (globalThis.__PI_VOICE_PROBE__?.().sessionIds ?? []).includes(id),
    worker.sessionId,
    { timeout: 60000 }
  );

  // Name the fixtures so the lane labels are readable. This must run AFTER the
  // sessions are in the store: the display-name setter keys off known paths.
  await page.evaluate(async ({ names }) => {
    const sessionMod = await import('/src/store/sessionStore.ts');
    for (const { path: p, name } of names) sessionMod.useSessionStore.getState().setSessionDisplayName(p, name);
  }, {
    names: [
      { path: worker.sessionPath, name: 'Worker Alpha' },
      ...extra.map((s) => ({ path: s.sessionPath, name: `Worker ${s.label}` })),
    ],
  });

  // ------------------------------------------------- select the worker session
  await page.waitForSelector('[data-testid="session-sidebar"] [role="listitem"]', { timeout: 60000 });
  const order = await page.evaluate(async () => {
    const mod = await import('/src/store/sessionStore.ts');
    const st = mod.useSessionStore.getState();
    return st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id);
  });
  const index = order.indexOf(worker.sessionId);
  if (index < 0) throw new Error(`worker not in sidebar list: ${JSON.stringify(order)}`);
  await page.locator('[data-testid="session-sidebar"] [role="listitem"]').nth(index).click();
  await page.waitForFunction(
    (id) => globalThis.__PI_VOICE_PROBE__?.().currentSessionId === id,
    worker.sessionId,
    { timeout: 30000 }
  );
  step('selectedWorker', { index, sessionId: worker.sessionId });

  // --------------------------------------------------- a REAL turn with tools
  if (!SKIP_TURN) {
    // The composer is disabled ("Select a session to start chatting...") until
    // the switch has actually landed; wait for the live placeholder.
    const composer = page.locator('textarea[placeholder*="Ask anything" i]').first();
    await composer.waitFor({ state: 'visible', timeout: 60000 });
    await composer.fill(TOOL_PROMPT);
    await composer.press('Enter');
    await page.waitForFunction(
      () => (globalThis.__PI_VOICE_PROBE__?.().messageCount ?? 0) > 1,
      undefined,
      { timeout: 60000 }
    ).catch(() => {});
    await page.waitForSelector('[data-testid^="tool-group-"]', { timeout: 300000 });
    await page.waitForFunction(
      () => globalThis.__PI_VOICE_PROBE__?.().isStreaming === false,
      undefined,
      { timeout: 300000 }
    );
    await sleep(2500);
  }

  const chatProbe = await page.evaluate(PROBE);
  step('chatView', chatProbe);
  check('regular chat view groups the tool run into a tool group', chatProbe.chatToolGroups.length >= 1, chatProbe.chatToolGroups);
  await shot('01-regular-session-view-1440.png');

  // ------------------------------------------------------------ voice mode
  await page.click('[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 60000 });
  await page.click('button[aria-label="Continue an existing session"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 30000 });
  {
    const order2 = await page.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      return st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id);
    });
    await page.locator('h2:has-text("Continue a Session") ~ div button').nth(order2.indexOf(worker.sessionId)).click();
  }
  await page.waitForSelector('[aria-label="Start recording"]', { timeout: 60000 });

  const mobileProbe = await page.evaluate(PROBE);
  step('voiceMobile', mobileProbe);
  check('mobile layout shows no session pane', mobileProbe.paneVisible === false && mobileProbe.panelVisible === false);
  await shot('02-voice-mobile-1440.png');

  // ---------------------------------------------------------- desktop layout
  await page.click('[data-testid="voice-layout-desktop"]');
  await sleep(1200);
  const desktopProbe = await page.evaluate(PROBE);
  step('voiceDesktop', desktopProbe);
  check('desktop layout renders the session pane', desktopProbe.paneVisible && desktopProbe.panelVisible);
  check('the pane is a bottom panel of the same column as the voice block', desktopProbe.sameColumn && desktopProbe.panelAfterVoiceBlock);
  check(
    'the pane shows the SAME organised tool-group structure as the regular chat view',
    desktopProbe.paneToolGroups.length === chatProbe.chatToolGroups.length && desktopProbe.chatToolGroups.length >= 1,
    { pane: desktopProbe.paneToolGroups, chat: chatProbe.chatToolGroups }
  );
  check(
    'the pane shows the same tool-group summary text as the regular chat view',
    JSON.stringify(desktopProbe.paneToolGroupSummaries) === JSON.stringify(chatProbe.chatToolGroupSummaries),
    { pane: desktopProbe.paneToolGroupSummaries, chat: chatProbe.chatToolGroupSummaries }
  );
  check('the desktop voice controls are the compact variant', desktopProbe.compact === 'true', desktopProbe.compact);
  await shot('03-voice-desktop-pane-1440.png');

  // --------------------------------------------------- three lanes, desktop
  const addLane = async (target) => {
    await page.click('button[aria-label="Add a lane"]');
    await page.waitForSelector('h2:has-text("Add a lane")', { timeout: 30000 });
    await page.waitForSelector('h2:has-text("Add a lane") ~ div button', { timeout: 30000 });
    const order3 = await page.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      return st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id);
    });
    const i = order3.indexOf(target.sessionId);
    if (i < 0) throw new Error(`lane target not in picker: ${JSON.stringify(order3)}`);
    await page.locator('h2:has-text("Add a lane") ~ div button').nth(i).click();
    await page.waitForFunction(
      (id) => (globalThis.__PI_VOICE_PROBE__?.().lanes ?? []).includes(id) || globalThis.__PI_VOICE_PROBE__?.().activeSessionId === id,
      target.sessionId,
      { timeout: 30000 }
    );
    await sleep(800);
  };

  await addLane(extra[0]);
  await addLane(extra[1]);
  await sleep(1500);
  const threeLaneProbe = await page.evaluate(PROBE);
  step('threeLanes', threeLaneProbe);
  check('desktop holds three lane rows', threeLaneProbe.laneRowCount === 3, threeLaneProbe.laneRowCount);
  check('the cap reads 3 of 3', threeLaneProbe.laneCap === '3 of 3', threeLaneProbe.laneCap);
  check('the session pane is still rendered alongside three lanes', threeLaneProbe.paneVisible && threeLaneProbe.panelVisible);
  check('every lane row offers an in-place switch', threeLaneProbe.laneSwitches.length === 3, threeLaneProbe.laneSwitches);
  await shot('04-voice-desktop-three-lanes-1440.png');

  await page.setViewportSize({ width: 1440, height: 1140 });
  await sleep(1200);
  const tallProbe = await page.evaluate(PROBE);
  step('threeLanesTall', tallProbe);
  check('three lanes + pane still held at a taller laptop window', tallProbe.laneRowCount === 3 && tallProbe.paneVisible);
  await shot('05-voice-desktop-three-lanes-1440x1140.png');

  // ------------------------------------------- switch a lane's worker in place
  const target = extra[1];   // Charlie's lane
  const replacement = extra[2]; // Delta
  const beforeSwitch = await page.evaluate(PROBE);
  await page.click(`[data-testid="lane-switch"][data-lane-session="${target.sessionId}"]`);
  await page.waitForSelector('h2:has-text("Switch session")', { timeout: 30000 });
  await page.waitForSelector('h2:has-text("Switch session") ~ div button', { timeout: 30000 });
  await shot('06-switch-session-picker.png');
  {
    const order4 = await page.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      return st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id);
    });
    await page.locator('h2:has-text("Switch session") ~ div button').nth(order4.indexOf(replacement.sessionId)).click();
  }
  await page.waitForFunction(
    (id) => (globalThis.__PI_VOICE_PROBE__?.().lanes ?? []).includes(id),
    replacement.sessionId,
    { timeout: 30000 }
  );
  await sleep(2000);
  const afterSwitch = await page.evaluate(PROBE);
  step('afterLaneSwitch', afterSwitch);
  check('switching a lane keeps the lane count at three (no rebuild, no exit)', afterSwitch.laneRowCount === 3, afterSwitch.laneRowCount);
  check(
    'the switched lane holds the new session and the others are untouched',
    afterSwitch.laneRows.some((r) => r.session === replacement.sessionId) &&
      afterSwitch.laneRows.some((r) => r.session === worker.sessionId) &&
      afterSwitch.laneRows.some((r) => r.session === extra[0].sessionId) &&
      !afterSwitch.laneRows.some((r) => r.session === target.sessionId),
    afterSwitch.laneRows
  );
  check('the switched lane is now the addressed one', afterSwitch.store?.activeSessionId === replacement.sessionId, afterSwitch.store);
  check('the pane follows the addressed lane', afterSwitch.paneSession === afterSwitch.store?.activeSessionId, { pane: afterSwitch.paneSession, addressed: afterSwitch.store?.activeSessionId });
  check('the pane names the addressed lane\'s worker', (afterSwitch.sessionPaneName ?? '').includes('Worker Delta'), afterSwitch.sessionPaneName);
  check(
    'the pane stops showing the previous worker\'s work',
    afterSwitch.paneToolGroups.length === 0,
    afterSwitch.paneToolGroups
  );
  check(
    'voice mode never left the surface',
    ['dictate', 'agent-working', 'read-aloud-ready', 'audio-playing'].includes(afterSwitch.store?.phase) &&
      afterSwitch.store?.lanes?.length === 3,
    { phase: afterSwitch.store?.phase, lanes: afterSwitch.store?.lanes?.length }
  );
  check('the lane set before the switch held three lanes', beforeSwitch.laneRows.length === 3);
  await shot('07-after-lane-switch-1440.png');

  // Address the tool-run worker again: the pane must come back with its work.
  await page.click(`[data-testid="lane-row"][data-lane-session="${worker.sessionId}"]`);
  await page.waitForFunction(
    (id) => globalThis.__PI_VOICE_PROBE__?.().activeSessionId === id,
    worker.sessionId,
    { timeout: 30000 }
  );
  await sleep(1500);
  const backToWorker = await page.evaluate(PROBE);
  step('paneFollowsBack', backToWorker);
  check(
    're-addressing the tool-run worker brings its tool group back into the pane',
    backToWorker.paneSession === worker.sessionId && backToWorker.paneToolGroups.length === 1,
    { paneSession: backToWorker.paneSession, groups: backToWorker.paneToolGroups }
  );
  await shot('08-pane-follows-readdressed-worker.png');

  // ------------------------------------------ the addressed surface can switch
  const surfaceSwitch = await (async () => {
    const visibleSwitch = page.locator('[data-testid="drive-switch-session"]:visible').first();
    const present = (await visibleSwitch.count()) > 0;
    if (!present) return { present };
    await visibleSwitch.click();
    await page.waitForSelector('h2:has-text("Switch session")', { timeout: 30000 });
    await page.click('button:has-text("Back")');
    await sleep(600);
    return { present, pickerClosed: (await page.locator('h2:has-text("Switch session")').count()) === 0 };
  })();
  step('addressedSurfaceSwitch', surfaceSwitch);
  check('the addressed lane offers a switch control that opens and closes in place', surfaceSwitch.present && surfaceSwitch.pickerClosed, surfaceSwitch);

  // ------------------------------------------------------------ mobile again
  await page.click('[data-testid="voice-layout-mobile"]');
  await sleep(800);
  await page.setViewportSize({ width: 430, height: 900 });
  await sleep(1200);
  const mobileAfter = await page.evaluate(PROBE);
  step('mobileAfter', mobileAfter);
  check('mobile layout keeps the lanes and shows no pane', mobileAfter.laneRowCount === 3 && mobileAfter.paneVisible === false);
  await shot('09-mobile-three-lanes-430.png');

  report.finishedAt = new Date().toISOString();
  report.summary = {
    total: report.assertions.length,
    passed: report.assertions.filter((a) => a.ok).length,
    failed: report.assertions.filter((a) => !a.ok).map((a) => a.name),
  };
  write();
  await context.close();

  for (const s of [worker, ...extra]) await internalApi('DELETE', `/api/v1/sessions/${s.sessionId}`);

  console.log(`\n=== desktop-lanes.json written — ${report.summary.passed}/${report.summary.total} assertions passed`);
  if (report.summary.failed.length) {
    console.error(`FAILED: ${report.summary.failed.join(' | ')}`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  // Close the browser even on a fatal: an open Playwright context keeps the
  // Node process alive forever, which is how this harness first left zombies.
  if (context) await context.close().catch(() => {});
  step('FATAL', String(err && err.stack ? err.stack : err));
  report.summary = {
    total: report.assertions.length,
    passed: report.assertions.filter((a) => a.ok).length,
    failed: report.assertions.filter((a) => !a.ok).map((a) => a.name),
    fatal: String(err && err.message ? err.message : err),
  };
  write();
  process.exit(1);
});
