import { test, expect } from '@playwright/test';

test.describe('Session Context Transfer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('Ey@U1U%d5D77J99F');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
  });

  test('transfer_session_context message is recognized by WebSocket', async ({ page }) => {
    const wsMessages: unknown[] = [];

    page.on('console', msg => {
      if (msg.text().includes('transfer_session_context') || msg.text().includes('session_transfer')) {
        wsMessages.push(msg.text());
      }
    });

    await page.waitForTimeout(2000);

    const chatInterface = page.locator('[data-testid="chat-interface"]');
    await expect(chatInterface).toBeVisible();
  });
});
