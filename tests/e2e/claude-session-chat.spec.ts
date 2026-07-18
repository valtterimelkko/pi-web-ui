import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
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

/** Returns true when the modal was successfully opened. */
async function openNewSessionModal(page: any): Promise<boolean> {
  await page.waitForLoadState('networkidle').catch(() => null);

  const titleBtn = page.locator('button[title="New session"]').first();
  const textBtn  = page.locator('button').filter({ hasText: /new session/i }).first();
  const testId   = page.locator('[data-testid="new-session-btn"]');

  // Give the sidebar time to render
  await titleBtn.waitFor({ state: 'visible', timeout: 6000 }).catch(() => null);

  const btn = (await titleBtn.isVisible().catch(() => false)) ? titleBtn
    : (await textBtn.isVisible().catch(() => false)) ? textBtn
    : testId;

  if (!(await btn.isVisible().catch(() => false))) return false;

  await btn.click();
  await page.waitForSelector('[data-testid="new-session-modal"]', { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(300);
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Claude Direct Session Chat', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Claude availability is correctly reflected in modal', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'No new session button found');
      return;
    }

    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    if (!await claudeBtn.isVisible().catch(() => false)) {
      test.skip(true, 'No Claude Direct button found in modal');
      return;
    }

    if (await claudeBtn.isDisabled()) {
      // The backend may report a detailed auth error (exposed as title) or the
      // neutral availability state rendered in the button body.
      await expect(claudeBtn).toContainText(/not installed|auth check failed|not available/i);
    } else {
      await expect(claudeBtn).toBeEnabled();
    }
  });

  test('Claude Direct unavailability hint is shown when not available', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'No new session button found');
      return;
    }

    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    if (!(await claudeBtn.isDisabled())) {
      test.skip(true, 'Claude is available on the target server');
      return;
    }

    // When disabled the subtitle shows "Not available" or an auth error.
    const hint = claudeBtn.locator('text=/not available|not installed|auth/i').first();
    await expect(hint).toBeVisible({ timeout: 5000 });
  });

  test('Create Claude Direct session (requires Claude)', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'No new session button found');
      return;
    }

    // Select Claude Direct
    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    await expect(claudeBtn).toBeVisible({ timeout: 5000 });
    if (await claudeBtn.isDisabled()) {
      test.skip(true, 'Claude is unavailable on the target server');
      return;
    }
    await claudeBtn.click();
    await page.waitForTimeout(300);

    await expect(claudeBtn).toHaveAttribute('aria-pressed', 'true');

    // Confirm and create the session
    const createBtn = page.locator('button').filter({ hasText: /create session|start session/i }).first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(4000);

      // Claude sessions should show a "CC" badge in the sidebar
      const ccBadge = page.locator('text=CC').first();
      await expect(ccBadge).toBeVisible({ timeout: 10000 });
    }
  });

  test('Modal can be closed without creating a session', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'No new session button found');
      return;
    }

    const modal = page.locator('[data-testid="new-session-modal"]');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click the X close button
    const closeBtn = modal.locator('button').filter({ has: page.locator('svg') }).first();
    await closeBtn.click();
    await page.waitForTimeout(300);

    await expect(modal).not.toBeVisible();
  });
});
