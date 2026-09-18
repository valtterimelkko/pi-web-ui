import { chromium } from '/root/pi-web-ui/node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';

const BASE = process.env.PROBE_BASE ?? 'http://localhost:3499';
const PASSWORD = process.env.PROBE_PASSWORD ?? 'voice-dogfood';
const out = { steps: [], errors: [] };
const step = (name, detail) => { out.steps.push({ name, detail, at: new Date().toISOString() }); console.log(`[step] ${name}: ${detail}`); };

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => out.errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') out.errors.push(`console: ${m.text().slice(0, 200)}`); });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const pw = page.locator('input[type="password"]');
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
    step('login', 'submitted');
  } else {
    step('login', 'no password prompt (already authed)');
  }

  const enter = page.locator('button[aria-label="Enter Voice Mode"], button[aria-label="Enter Drive Mode"]').first();
  await enter.click({ timeout: 20000 });
  await page.waitForTimeout(1200);
  step('voice-mode', 'overlay open');

  const cont = page.locator('button', { hasText: 'Continue Session' }).first();
  await cont.waitFor({ state: 'visible', timeout: 30000 });
  await cont.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const items = await page.locator('button').evaluateAll(els => els.map(e => (e.textContent||'').trim()).filter(t => t && t.length < 60));
  step('session-list', JSON.stringify(items.slice(0, 12)));
  const card = page.locator('button', { hasText: '(no messages)' }).first();
  await card.waitFor({ state: 'visible', timeout: 20000 });
  await card.click({ timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.waitForTimeout(2000);

  const surface = page.locator('[data-testid="drive-mode-surface"]');
  step('dictate-surface', (await surface.count()) ? 'visible' : 'MISSING');

  const toggle = page.locator('[data-testid="native-voice-lane-toggle"]');
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(600);
    step('lane-expanded', 'ok');
  } else {
    step('lane-toggle', 'MISSING');
  }

  const start = page.locator('[data-testid="voice-live-start"]');
  if (await start.count()) {
    await start.click();
    step('lane-start', 'clicked');
    await page.waitForTimeout(9000);
  } else {
    step('lane-start', 'MISSING (control not rendered)');
  }

  const stateText = async (sel) => (await page.locator(sel).count()) ? (await page.locator(sel).first().innerText()).trim().slice(0, 160) : null;
  out.observed = {
    wireState: await stateText('[data-testid="voice-live-wire-state"]'),
    status: await stateText('[data-testid="voice-live-status"]'),
    unavailable: await stateText('[data-testid="voice-live-unavailable"]'),
    unavailableDetail: await stateText('[data-testid="voice-live-unavailable-detail"]'),
    listening: await stateText('[data-testid="voice-live-listening-state"]'),
  };
  step('observed', JSON.stringify(out.observed));

  await page.screenshot({ path: '/tmp/dogfood-composed-loop.png', fullPage: false });
  step('screenshot', '/tmp/dogfood-composed-loop.png');
} catch (e) {
  out.errors.push(`probe: ${String(e).slice(0, 300)}`);
  await page.screenshot({ path: '/tmp/dogfood-composed-loop-fail.png' }).catch(() => {});
} finally {
  writeFileSync('/tmp/dogfood-probe-result.json', JSON.stringify(out, null, 2));
  await browser.close();
}
console.log('RESULT', JSON.stringify(out.observed ?? {}, null, 1));
console.log('ERRORS', out.errors.length);
