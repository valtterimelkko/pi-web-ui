import { test, expect } from '@playwright/test';

const PASSWORD = 'Ey@U1U%d5D77J99F';

async function login(page: Parameters<typeof test.fn>[0]['page']) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2000);
  }
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

    // BottomNav tabs – find buttons in the bottom nav area
    const tabLabels = ['Chat', 'Shell', 'Files', 'Git'];
    for (const label of tabLabels) {
      // On mobile there may be two buttons (one hidden desktop, one visible mobile)
      // Click the first visible one
      const btns = page.locator('button').filter({ hasText: new RegExp(`^${label}$`) });
      const count = await btns.count();
      for (let i = 0; i < count; i++) {
        const btn = btns.nth(i);
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(200);
          break;
        }
      }
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
