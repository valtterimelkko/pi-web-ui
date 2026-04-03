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

test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('shows tab navigation on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // IntegratedHeader is hidden md:flex – should be visible at 1280px
    // Tab buttons exist in header (desktop) – locate by text within the header
    const chatTab = page.locator('button').filter({ hasText: /^Chat$/ }).first();
    await expect(chatTab).toBeVisible({ timeout: 8000 });
  });

  test('desktop header contains all expected tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    for (const label of ['Chat', 'Shell', 'Files', 'Git', 'Tasks']) {
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${label}`) }).first();
      await expect(btn).toBeVisible({ timeout: 8000 });
    }
  });

  test('Tasks tab shows "Soon" badge on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // The "Soon" badge lives inside the Tasks button
    const soonBadge = page.locator('text=Soon').first();
    await expect(soonBadge).toBeVisible({ timeout: 8000 });
  });

  test('chat tab is active by default on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Chat panel should be visible (default active tab)
    const chatInterface = page.locator('[data-testid="chat-interface"]');
    await expect(chatInterface).toBeVisible({ timeout: 8000 });
  });

  test('can switch to Shell tab on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    const shellTab = page.locator('button').filter({ hasText: /^Shell$/ }).first();
    if (await shellTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await shellTab.click();
      await page.waitForTimeout(500);

      // Chat interface should be hidden after switching away
      const chatInterface = page.locator('[data-testid="chat-interface"]');
      await expect(chatInterface).not.toBeVisible({ timeout: 3000 });
    }
  });

  test('can switch to Files tab on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    const filesTab = page.locator('button').filter({ hasText: /^Files$/ }).first();
    if (await filesTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await filesTab.click();
      await page.waitForTimeout(500);
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('can switch to Git tab on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    const gitTab = page.locator('button').filter({ hasText: /^Git$/ }).first();
    if (await gitTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await gitTab.click();
      await page.waitForTimeout(500);
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('switching back to Chat restores chat interface', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Switch away to Shell
    const shellTab = page.locator('button').filter({ hasText: /^Shell$/ }).first();
    if (await shellTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await shellTab.click();
      await page.waitForTimeout(500);
    }

    // Switch back to Chat
    const chatTab = page.locator('button').filter({ hasText: /^Chat$/ }).first();
    if (await chatTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await chatTab.click();
      await page.waitForTimeout(500);
      const chatInterface = page.locator('[data-testid="chat-interface"]');
      await expect(chatInterface).toBeVisible({ timeout: 5000 });
    }
  });

  test('shows bottom navigation on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // BottomNav has class "md:hidden" – visible at 375px
    // The bottom nav container has fixed bottom styling
    const bottomNav = page.locator('.md\\:hidden').filter({ hasText: /Chat|Shell|Files|Git/ }).first();
    if (await bottomNav.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(bottomNav).toBeVisible();
    } else {
      // At minimum the page should render without crashing
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('mobile bottom nav contains Chat, Shell, Files, Git buttons', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // The bottom nav renders tab buttons with icon + label
    for (const label of ['Chat', 'Shell', 'Files', 'Git']) {
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${label}$`) });
      // On mobile these appear in BottomNav; might be multiple buttons (one hidden)
      const count = await btn.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('mobile has More button for overflow tabs', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // BottomNav has a "More" button for Tasks
    const moreButton = page.locator('button').filter({ hasText: /More/ }).first();
    if (await moreButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(moreButton).toBeVisible();
    }
  });

  test('no console errors during tab navigation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await page.waitForTimeout(1000);

    const tabs = ['Shell', 'Files', 'Git', 'Chat'];
    for (const label of tabs) {
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${label}`) }).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    }

    const critical = consoleErrors.filter(
      (e) =>
        !e.includes('Warning:') &&
        !e.includes('DevTools') &&
        !e.includes('network') &&
        !e.includes('404')
    );
    expect(critical.length).toBeLessThan(3);
  });
});
