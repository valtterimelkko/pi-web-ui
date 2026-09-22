/**
 * Reproduce the operator's "Start listening" report in a REAL browser against a
 * REAL disposable live-engine server, and capture every console/page error and
 * the voice-surface state. Diagnostic only; not a permanent test.
 *
 *   node operations/voice-free-talker-20260922/repro/repro.mjs
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.REPRO_URL ?? 'http://localhost:3499';
const PASSWORD = process.env.REPRO_PASSWORD ?? 'voice-repro';
const OUT = new URL('.', import.meta.url).pathname;

const consoleMsgs = [];
const pageErrors = [];
const requestFailures = [];

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
});
const page = await context.newPage();
page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
page.on('requestfailed', (r) => requestFailures.push({ url: r.url(), err: r.failure()?.errorText }));
const voiceFrames = [];
page.on('websocket', (ws) => {
  ws.on('framereceived', (f) => {
    const p = typeof f.payload === 'string' ? f.payload : '';
    if (p.includes('voice_')) {
      try {
        const j = JSON.parse(p);
        if (String(j.type || '').startsWith('voice_')) voiceFrames.push({ dir: 'in', type: j.type, laneId: j.laneId, state: j.state, gen: j.attachmentGeneration });
      } catch { voiceFrames.push({ dir: 'in', raw: p.slice(0, 120) }); }
    }
  });
  ws.on('framesent', (f) => {
    const p = typeof f.payload === 'string' ? f.payload : '';
    if (p.includes('voice_session_start')) voiceFrames.push({ dir: 'out', type: 'voice_session_start' });
  });
});

const step = async (name, fn) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    await fn();
    console.log(`OK: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${e.message}`);
  }
};

await step('load + login', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const pw = page.locator('input[type="password"]');
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
  }
});

await step('enter Drive Mode and create a Pi session', async () => {
  await page.evaluate(() => {
    localStorage.setItem('pi-web-ui-ui-store', JSON.stringify({
      state: { theme: 'light', recentFolders: [{ path: '/tmp', label: 'tmp', count: 1, lastUsed: Date.now() }] },
      version: 0,
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('button[aria-label="Enter Voice Mode"]').first().click();
  await page.getByRole('button', { name: 'Start a new session' }).click();
  await page.locator('text=Kimi for Coding').click();
  await page.locator('button').filter({ hasText: '/tmp' }).first().click();
  await page.waitForSelector('[data-testid="drive-mode-surface"]', { timeout: 30000 });
  await page.waitForTimeout(4000);
});

await step('click Start listening on the free lane (bottom)', async () => {
  // The free lane is collapsed at the bottom by default (restored UI).
  const toggle = page.locator('[data-testid="native-voice-lane-toggle"]');
  await toggle.waitFor({ timeout: 15000 });
  await toggle.click();
  const start = page.locator('[data-testid="voice-live-start"]');
  await start.waitFor({ timeout: 15000 });
  await start.click();
  const timeline = [];
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    const snap = await page.evaluate(() => {
      const status = document.querySelector('[data-testid="voice-live-status"]');
      const ws = document.querySelector('[data-testid="voice-live-wire-state"]');
      const un = document.querySelector('[data-testid="voice-live-unavailable"]');
      const dbg = typeof window.__vlDebug === 'function' ? window.__vlDebug() : null;
      return {
        lane: status && status.getAttribute('data-lane'),
        wire: ws && ws.getAttribute('data-state'),
        dbg,
        unavailable: un ? (un.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null,
      };
    });
    timeline.push({ ms: Date.now() - t0, ...snap });
    if (snap.lane === 'live') break;
    await page.waitForTimeout(500);
  }
  globalThis.__timeline = timeline;
  await page.waitForTimeout(15000);
});

  const state = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="drive-mode-surface"]');
    const order = main ? Array.from(main.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')) : [];
    const grab = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => ({
    testid: el.getAttribute('data-testid'),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260),
    attrs: Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value]).filter(([n]) => n.startsWith('data-'))),
  }));
  return {
    url: location.href,
    elementOrder: order,
    liveLane: grab('[data-testid="native-voice-lane"]'),
    liveStatus: grab('[data-testid="voice-live-status"]'),
    liveUnavailable: grab('[data-testid="voice-live-unavailable"]'),
    liveError: grab('[data-testid="voice-live-error"]'),
    liveRefusal: grab('[data-testid="voice-live-refusal"]'),
    liveFault: grab('[data-testid="voice-live-fault"]'),
    liveTransport: grab('[data-testid="voice-live-transport-refusal"]'),
    liveCaption: grab('[data-testid="voice-live-caption"]'),
    liveWireState: grab('[data-testid="voice-live-wire-state"]'),
  };
});

await page.screenshot({ path: `${OUT}repro-current-ui.png`, fullPage: true });

const report = {
  at: new Date().toISOString(),
  base: BASE,
  laneTimeline: globalThis.__timeline ?? [],
  voiceFrames,
  state,
  consoleErrors: consoleMsgs.filter((m) => m.type === 'error'),
  consoleWarn: consoleMsgs.filter((m) => m.type === 'warning'),
  pageErrors,
  requestFailures,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}repro-report.json`, JSON.stringify(report, null, 2));
console.log('\n=== REPORT ===');
console.log(JSON.stringify({ voiceFrames: report.voiceFrames, laneTimeline: report.laneTimeline?.slice(0, 30), state: report.state, pageErrors, consoleErrors: report.consoleErrors.slice(0, 20) }, null, 2));

await browser.close();
