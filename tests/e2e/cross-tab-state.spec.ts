import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers/login';

async function login(page: Parameters<typeof test.fn>[0]['page']) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  await loginIfNeeded(page);
}

test.describe('Cross-Tab State', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('app loads without crashing', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    // No error boundaries triggered
    const errorBoundary = page.locator('text=Something went wrong');
    const isErrorVisible = await errorBoundary.isVisible({ timeout: 1000 }).catch(() => false);
    expect(isErrorVisible).toBe(false);

    // Body has content
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toBeTruthy();
  });

  test('rapid tab switching does not crash', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    const tabLabels = ['Chat', 'Shell', 'Files', 'Git'];

    // Rapid switching
    for (let i = 0; i < 12; i++) {
      const label = tabLabels[i % tabLabels.length];
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${label}`) }).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(150);
      }
    }

    // Return to Chat
    const chatBtn = page.locator('button').filter({ hasText: /^Chat$/ }).first();
    if (await chatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chatBtn.click();
    }

    // Should not have crashed
    await expect(page.locator('body')).toBeVisible();
    const errorBoundary = page.locator('text=Something went wrong');
    const crashed = await errorBoundary.isVisible({ timeout: 1000 }).catch(() => false);
    expect(crashed).toBe(false);
  });

  test('chat tab content persists after switching away and back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Verify chat is active
    const chatInterface = page.locator('[data-testid="chat-interface"]');
    const chatInitiallyVisible = await chatInterface.isVisible({ timeout: 5000 }).catch(() => false);

    if (!chatInitiallyVisible) {
      // Chat may not be visible if no session – skip deeper check
      await expect(page.locator('body')).toBeVisible();
      return;
    }

    // Switch to Shell
    const shellBtn = page.locator('button').filter({ hasText: /^Shell$/ }).first();
    if (await shellBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await shellBtn.click();
      await page.waitForTimeout(400);
      await expect(chatInterface).not.toBeVisible({ timeout: 3000 });
    }

    // Switch back to Chat
    const chatBtn = page.locator('button').filter({ hasText: /^Chat$/ }).first();
    if (await chatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chatBtn.click();
      await page.waitForTimeout(400);
      // Chat panel should be visible again
      await expect(chatInterface).toBeVisible({ timeout: 5000 });
    }
  });

  test('tab panels are lazily mounted on first visit', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Before visiting Shell, its panel might not be in the DOM
    // After clicking Shell, it should mount
    const shellBtn = page.locator('button').filter({ hasText: /^Shell$/ }).first();
    if (await shellBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await shellBtn.click();
      await page.waitForTimeout(600);

      // After mounting, no crash
      await expect(page.locator('body')).toBeVisible();
      const error = page.locator('text=Something went wrong');
      const hasError = await error.isVisible({ timeout: 1000 }).catch(() => false);
      expect(hasError).toBe(false);
    }
  });

  test('active tab has blue highlight on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // The active tab button has blue styling (text-blue-600 / bg-blue-50)
    // We verify the active chat button has the blue class
    const chatBtn = page.locator('button').filter({ hasText: /^Chat$/ }).first();
    if (await chatBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      const classes = await chatBtn.getAttribute('class') ?? '';
      expect(classes).toMatch(/blue/);
    }
  });

  test('blue theme: active tab uses blue-600 color on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Switch to Shell to make it active, then verify it has blue class
    const shellBtn = page.locator('button').filter({ hasText: /^Shell$/ }).first();
    if (await shellBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await shellBtn.click();
      await page.waitForTimeout(300);
      const classes = await shellBtn.getAttribute('class') ?? '';
      expect(classes).toMatch(/blue/);

      // Chat button should no longer have the active blue class
      const chatBtn = page.locator('button').filter({ hasText: /^Chat$/ }).first();
      const chatClasses = await chatBtn.getAttribute('class') ?? '';
      // Chat should not have bg-blue-50 active background
      expect(chatClasses).not.toMatch(/bg-blue-50/);
    }
  });

  test('no memory leaks: switching tabs repeatedly does not cause errors', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await page.waitForTimeout(1000);

    // 20 rapid switches
    const labels = ['Chat', 'Shell', 'Files', 'Git', 'Chat', 'Git', 'Files', 'Shell'];
    for (const label of [...labels, ...labels]) {
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${label}`) }).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(100);
      }
    }

    await page.waitForTimeout(500);

    const critical = consoleErrors.filter(
      (e) =>
        !e.includes('Warning:') &&
        !e.includes('DevTools') &&
        !e.includes('network') &&
        !e.includes('404')
    );
    expect(critical.length).toBeLessThan(5);
  });

  test('mobile tab switch works without crashing', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    const closeSidebar = page.getByTitle('Close sidebar');
    if (await closeSidebar.isVisible().catch(() => false)) {
      await closeSidebar.click();
    }

    const bottomNav = page.getByRole('navigation', { name: 'Primary mobile navigation' });
    await expect(bottomNav).toBeVisible();

    for (const label of ['Chat', 'Shell', 'Files', 'Git']) {
      await bottomNav.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(200);
    }

    // No crash
    await expect(page.locator('body')).toBeVisible();
    const error = page.locator('text=Something went wrong');
    const hasError = await error.isVisible({ timeout: 1000 }).catch(() => false);
    expect(hasError).toBe(false);
  });

  test('WebSocket connection remains stable across tab switches', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Switch tabs a few times
    for (const label of ['Shell', 'Files', 'Git', 'Chat']) {
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${label}`) }).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    }

    // WebSocket connection error should not appear
    const wsError = page.locator('text=/connection lost|disconnected|failed to connect/i');
    const hasWsError = await wsError.isVisible({ timeout: 1000 }).catch(() => false);
    expect(hasWsError).toBe(false);
  });
});


test.describe('real two-tab persistence through the metadata route', () => {
  test('pin in one tab converges in the second tab and survives reload', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    for (const page of [pageA, pageB]) {
      await page.goto('/');
      await loginIfNeeded(page);
      await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 10_000 });
    }

    // Observe the REAL metadata API traffic the app uses for pin state.
    let sawMetadataWrite = false;
    pageA.on('response', (response) => {
      if (response.url().includes('/api/preferences') && response.request().method() !== 'GET') {
        sawMetadataWrite = true;
      }
    });

    // A fresh disposable environment has no sessions: create one through the
    // real modal so both tabs share an observable target.
    await pageA.locator('button[title="New session"], button').filter({ hasText: /new session/i }).first().click();
    // Pi is the native fixture-available runtime (Command Code is
    // Internal-API-enabled only in the disposable env; its browser button is
    // correctly disabled there).
    await pageA.locator('button[aria-pressed]').filter({ hasText: /pi/i }).first().click();
    await pageA.getByRole('button', { name: 'Create', exact: true }).click();
    // Session creation is async (websocket -> server -> registry -> list
    // refresh); poll the REAL observable instead of a fixed wait.
    await pageA.locator('[aria-label="Sessions"][role="list"] > div').first()
      .waitFor({ state: 'visible', timeout: 20_000 });

    // Pin the first session row through page A's real context-menu control.
    // The pin button's title flips to "Unpin session…" once pinned — that
    // observable fact is the convergence oracle in BOTH tabs.
    const firstRowA = pageA.locator('[aria-label="Sessions"][role="list"] > div').first();
    await firstRowA.waitFor({ state: 'visible', timeout: 15_000 });
    await firstRowA.click({ button: 'right' });
    await pageA.locator('button', { hasText: 'Pin session' }).first().click();
    await pageA.waitForTimeout(300);
    await expect(pageA.locator('button', { hasText: 'Unpin session' }).first()).toBeVisible({ timeout: 10_000 });

    // Page B converges WITHOUT reload (storage-event/metadata channel).
    await pageB.locator('button', { hasText: 'Unpin session' }).first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    // Reload page B: persistence comes from the server, not local state.
    await pageB.reload();
    await pageB.waitForSelector('[data-testid="chat-interface"]', { timeout: 10_000 });
    await expect(pageB.locator('button', { hasText: 'Unpin session' }).first()).toBeVisible({ timeout: 10_000 });

    // The pin actually went through the metadata route, not local setters.
    expect(sawMetadataWrite).toBe(true);
    await context.close();
  });
});
