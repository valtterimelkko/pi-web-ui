/**
 * Child V — Voice Mode layout modes, in a real browser.
 *
 * Drives the REAL client against the disposable server and takes the paired
 * screenshots the operator needs: desktop mode and mobile mode, each at a
 * desktop width and a mobile width, plus the voice flow inside the desktop
 * split.
 *
 * Every claim in the report is read back from the DOM after the interaction —
 * the screenshots illustrate the evidence, they are not the evidence.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const EVIDENCE = process.env.VOICE_EVIDENCE_DIR ?? '/root/pi-web-ui/operations/change-requests-20260915/child-voice/evidence';
const SHOTS = process.env.VOICE_SHOTS_DIR ?? '/root/pi-web-ui/operations/change-requests-20260915/child-voice/shots';
const APP = process.env.VOICE_APP_URL ?? 'http://127.0.0.1:3499';
const SOCKET = process.env.VOICE_SOCKET ?? '/tmp/child-voice-srv/internal-api.sock';
const TOKEN_PATH = process.env.VOICE_TOKEN_PATH ?? '/tmp/child-voice-srv/internal-api-token';
const PASSWORD = process.env.VOICE_PASSWORD ?? 'voice-lab-pass';
const PROFILE = process.env.VOICE_PROFILE_LAYOUT ?? '/tmp/child-voice-profile-layout';
const WORKSPACE = '/tmp/child-voice-workspace-layout';

fs.mkdirSync(EVIDENCE, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

const report = { steps: {}, screenshots: [] };
const write = () => fs.writeFileSync(path.join(EVIDENCE, 'layout.json'), JSON.stringify(report, null, 2));
const step = (k, v) => {
  report.steps[k] = v;
  write();
  console.log(`[step] ${k}:`, JSON.stringify(v).slice(0, 900));
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

/** Everything the assertions need, read from the live DOM. */
const PROBE = () => {
  const q = (sel) => document.querySelector(sel);
  const byTestId = (id) => q(`[data-testid="${id}"]`);
  const mic = q('[aria-label="Start recording"], [aria-label="Stop recording"], [aria-label="Starting microphone"]');
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  return {
    split: visible(byTestId('drive-mode-split')),
    sessionPane: visible(byTestId('drive-session-pane')),
    dictate: visible(byTestId('drive-mode-dictate')) || visible(q('[data-testid="floor-banner"]')),
    floorBanner: text(byTestId('floor-state-label')),
    micLabel: mic ? mic.getAttribute('aria-label') : null,
    layoutToggle: {
      present: visible(byTestId('voice-layout-toggle')),
      mobilePressed: byTestId('voice-layout-mobile')?.getAttribute('aria-pressed') ?? null,
      desktopPressed: byTestId('voice-layout-desktop')?.getAttribute('aria-pressed') ?? null,
      degraded: visible(byTestId('voice-layout-degraded')),
    },
    sessionPaneMessages: byTestId('drive-session-pane')?.querySelectorAll('h1,h2,h3,p,div').length ?? 0,
    confirmationCard: visible(byTestId('confirmation-card')),
    readAloudButton: (() => {
      const b = Array.from(document.querySelectorAll('button')).find((el) => /Read Aloud|Stop Reading/.test(el.textContent || ''));
      return b ? { present: true, label: b.textContent.replace(/\s+/g, ' ').trim(), disabled: b.hasAttribute('disabled') } : { present: false };
    })(),
    stopTalker: visible(byTestId('stop-talker')),
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
};

async function main() {
  const existing = await internalApi('GET', '/api/v1/sessions');
  const ids = (Array.isArray(existing.body?.sessions) ? existing.body.sessions : []).map((s) => s.sessionId).filter(Boolean);
  for (const id of ids) await internalApi('DELETE', `/api/v1/sessions/${id}`);
  const created = await internalApi('POST', '/api/v1/sessions', {
    runtime: 'pi',
    cwd: WORKSPACE,
    model: 'zai/glm-5.3-flash',
  });
  const sessionId = created.body?.sessionId;
  step('session', { status: created.status, id: sessionId });
  if (!sessionId) throw new Error(`session create failed: ${JSON.stringify(created)}`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
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
  await page.waitForSelector('#password', { timeout: 30000 });
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#password', { state: 'detached', timeout: 30000 });

  // Enter Voice Mode on a real worker session.
  await page.waitForSelector('[aria-label="Enter Voice Mode"]', { timeout: 30000 });
  await page.click('[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
  await page.click('button[aria-label="Continue an existing session"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  {
    const order = await page.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      return st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id);
    });
    const index = order.indexOf(sessionId);
    if (index < 0) throw new Error(`session not in picker: ${JSON.stringify(order)}`);
    await page.locator('h2:has-text("Continue a Session") ~ div button').nth(index).click();
  }
  await page.waitForSelector('[aria-label="Start recording"]', { timeout: 30000 });
  step('entered', await page.evaluate(PROBE));
  await shot('20-layout-mobile-mode-narrow-after-entry.png');

  // ---- mobile mode, desktop width -----------------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(500);
  step('mobileMode.desktopWidth', await page.evaluate(PROBE));
  await shot('21-mobile-mode-1440.png');

  // ---- switch to desktop mode at the same width ----------------------------
  await page.click('[data-testid="voice-layout-desktop"]');
  await sleep(500);
  step('desktopMode.desktopWidth', await page.evaluate(PROBE));
  await shot('22-desktop-mode-1440-split.png');

  // ---- the voice flow inside the split -------------------------------------
  await page.click('[aria-label="Start recording"]');
  await sleep(1500);
  step('desktopSplit.micRecording', await page.evaluate(PROBE));
  await shot('23-desktop-mode-1440-recording.png');
  await page.click('[aria-label="Stop recording"]');
  await sleep(3500);
  step('desktopSplit.afterStop', await page.evaluate(PROBE));

  // The pane follows the same store the chat screen uses: push a message
  // through the real store and assert it lands in the pane.
  const paneAfterMessage = await (async () => {
    await page.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      mod.useSessionStore.setState({
        messages: [
          ...st.messages,
          { id: 'layout-probe-1', role: 'assistant', content: 'PANE-STORE-PROBE: this line came from the session store.', timestamp: Date.now() },
        ],
      });
    });
    await sleep(600);
    return page.evaluate(() => ({
      paneContains: (document.querySelector('[data-testid="drive-session-pane"]')?.textContent || '').includes('PANE-STORE-PROBE'),
      readAloud: (() => {
        const b = Array.from(document.querySelectorAll('button')).find((el) => /Read Aloud/.test(el.textContent || ''));
        return b ? { present: true, disabled: b.hasAttribute('disabled') } : { present: false };
      })(),
    }));
  })();
  step('desktopSplit.paneFollowsSameStore', paneAfterMessage);
  await shot('24-desktop-mode-1440-session-pane-store.png');

  // The confirmation card is driven by the surface's real talker-turn bus; emit
  // the same result shape the server produces so the card is exercised INSIDE
  // the split. (Boundary: this is a synthetic bus event, not a live talker turn.)
  const card = await (async () => {
    await page.evaluate(async () => {
      const bus = await import('/src/lib/talkerBus.ts');
      const st = await import('/src/store/sessionStore.ts');
      bus.emitTalkerTurnResult({
        type: 'talker_turn_result',
        workerSessionId: st.useSessionStore.getState().currentSessionId,
        runtime: 'pi',
        reply: 'Shall I send that?',
        phase: 'proposed',
        released: null,
        cancelled: false,
        receiptAck: 'got it',
      });
    });
    await sleep(700);
    return page.evaluate(() => {
      const cardEl = document.querySelector('[data-testid="confirmation-card"]');
      const buttons = cardEl ? Array.from(cardEl.querySelectorAll('button')).map((b) => b.textContent.trim()) : [];
      return { present: !!cardEl, buttons, text: cardEl ? cardEl.textContent.replace(/\s+/g, ' ').slice(0, 200) : null };
    });
  })();
  step('desktopSplit.confirmationCard', card);
  await shot('25-desktop-mode-1440-confirmation-card.png');

  // ---- desktop mode, narrow window (must degrade, not squash) --------------
  await page.setViewportSize({ width: 430, height: 900 });
  await sleep(600);
  step('desktopMode.narrowWidth', await page.evaluate(PROBE));
  await shot('26-desktop-mode-430-degraded.png');

  // ---- back to mobile mode, narrow ---------------------------------------
  await page.click('[data-testid="voice-layout-mobile"]');
  await sleep(600);
  step('mobileMode.narrowWidth', await page.evaluate(PROBE));
  await shot('27-mobile-mode-430.png');

  // ---- the choice persists across a reload -------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('[data-testid="voice-layout-desktop"]');
  await sleep(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[aria-label="Enter Voice Mode"]', { timeout: 30000 });
  await page.click('[aria-label="Enter Voice Mode"]');
  await page.waitForSelector('button[aria-label="Continue an existing session"]:not([disabled])', { timeout: 30000 });
  await page.click('button[aria-label="Continue an existing session"]');
  await page.waitForSelector('h2:has-text("Continue a Session")', { timeout: 15000 });
  {
    const order = await page.evaluate(async () => {
      const mod = await import('/src/store/sessionStore.ts');
      const st = mod.useSessionStore.getState();
      return st.sessions.filter((s) => s.path && !st.archivedSessionPaths.includes(s.path)).map((s) => s.id);
    });
    await page.locator('h2:has-text("Continue a Session") ~ div button').nth(order.indexOf(sessionId)).click();
  }
  await page.waitForSelector('[aria-label="Start recording"]', { timeout: 30000 });
  await sleep(400);
  step('desktopMode.afterReload', await page.evaluate(PROBE));
  await shot('28-desktop-mode-after-reload.png');

  write();
  await context.close();
  console.log('\n=== layout.json written');
}

main().catch((err) => {
  step('FATAL', String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
