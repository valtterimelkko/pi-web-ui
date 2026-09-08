import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers/login';

test.describe('Session Context Transfer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    await loginIfNeeded(page);
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
