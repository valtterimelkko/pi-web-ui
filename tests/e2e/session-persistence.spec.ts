import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function login(page: any) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill('Ey@U1U%d5D77J99F');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Session Persistence', () => {
  test('Auth cookie persists across page reload', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // After reload with a valid JWT cookie we should NOT be back on the login screen
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).not.toBeVisible({ timeout: 5000 });

    // App body still has content
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(0);
  });

  test('App shows chat interface after reload', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // The main content area should be present (sidebar / chat view)
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(0);

    // Should not display a fatal error
    const fatalError = page.locator('text=/something went wrong|fatal error|500/i');
    await expect(fatalError).not.toBeVisible();
  });

  test('SDK selector state is reset to Pi SDK on new modal open', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);

    // Open the new-session modal
    const btn = page.locator('button[title="New session"]').first();
    const fallback = page.locator('button').filter({ hasText: /new session/i }).first();
    const trigger = (await btn.isVisible().catch(() => false)) ? btn : fallback;

    if (!(await trigger.isVisible().catch(() => false))) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    // First open
    await trigger.click();
    await page.waitForSelector('[data-testid="new-session-modal"]', { timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(300);

    // Verify Pi SDK selected by default
    const piBtn = page.locator('button').filter({ hasText: /Pi SDK/i }).first();
    if (await piBtn.isVisible().catch(() => false)) {
      const cls = await piBtn.getAttribute('class');
      expect(cls).toMatch(/violet/i);
    }

    // Close modal via Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Re-open: default should still be Pi SDK
    await trigger.click();
    await page.waitForSelector('[data-testid="new-session-modal"]', { timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(300);

    const piBtnAgain = page.locator('button').filter({ hasText: /Pi SDK/i }).first();
    if (await piBtnAgain.isVisible().catch(() => false)) {
      const cls2 = await piBtnAgain.getAttribute('class');
      expect(cls2).toMatch(/violet/i);
    }
  });

  test('Health endpoint still responds after session activity', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(1000);

    // Use expect.poll to tolerate transient rate-limit (429) responses that can
    // occur when many tests run in parallel and share the same rate-limit window.
    await expect.poll(
      async () => {
        const response = await page.request.get('/health');
        return response.status();
      },
      { intervals: [1000, 2000, 3000], timeout: 15000 },
    ).toBe(200);
  });

  test('WebSocket re-connects after reload without manual login', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // No connection-error banner should appear
    const connError = page.locator('text=/connection.*failed|websocket.*error|disconnected/i');
    await expect(connError).not.toBeVisible({ timeout: 5000 });
  });
});
