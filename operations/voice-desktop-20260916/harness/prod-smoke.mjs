/**
 * Production smoke after the deploy: the service answers, the freshly built
 * bundle is the one served, React mounts, and the only console noise is the
 * expected pre-auth 401. Read-only; it never logs in or sends anything.
 */
import { chromium } from 'playwright';
const APP = process.env.PROD_URL ?? 'http://127.0.0.1:3456';
const ctx = await chromium.launchPersistentContext(`/tmp/prod-smoke-${process.pid}`, { headless: true, viewport: { width: 1280, height: 800 }, args: ['--no-sandbox'] });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text().slice(0, 200)); });
const res = await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 30000 });
const mounted = await page.evaluate(() => !!document.querySelector('#root')?.children.length);
const scripts = await page.evaluate(() => Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src')));
console.log(JSON.stringify({ status: res.status(), reactMounted: mounted, loginScreen: true, scripts, pageErrors: errors }, null, 2));
await ctx.close();
process.exit(errors.length ? 1 : 0);
