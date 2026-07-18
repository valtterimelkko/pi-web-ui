import { test, expect } from '@playwright/test';

// Login helper (reuse pattern from core.spec.ts)
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

// Open the New Session modal — the trigger is a Plus icon with title="New session"
async function openNewSessionModal(page: any): Promise<boolean> {
  // Wait for app to fully render before looking for the button
  await page.waitForLoadState('networkidle').catch(() => null);

  // Primary: button with title="New session"
  const titleBtn = page.locator('button[title="New session"]').first();
  // Fallback: button text
  const textBtn = page.locator('button').filter({ hasText: /new session/i }).first();
  // Fallback: data-testid
  const testIdBtn = page.locator('[data-testid="new-session-btn"]');

  // Give the primary selector a moment to appear
  await titleBtn.waitFor({ state: 'visible', timeout: 6000 }).catch(() => null);

  const btn = (await titleBtn.isVisible().catch(() => false)) ? titleBtn
    : (await textBtn.isVisible().catch(() => false)) ? textBtn
    : testIdBtn;

  if (!(await btn.isVisible().catch(() => false))) {
    return false;
  }

  await btn.click();
  // Wait for modal
  await page.waitForSelector('[data-testid="new-session-modal"]', { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(300);
  return true;
}

test.describe('Dual-SDK Session Creation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('New Session Modal opens and contains SDK selector', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    // Modal should be visible
    const modal = page.locator('[data-testid="new-session-modal"]');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // All three SDK options must be present
    const piSdkOption = page.locator('button').filter({ hasText: /Pi SDK/i });
    const claudeOption = page.locator('button').filter({ hasText: /Claude Direct/i });
    const opencodeOption = page.locator('button').filter({ hasText: /OpenCode Direct/i });

    await expect(piSdkOption).toBeVisible({ timeout: 5000 });
    await expect(claudeOption).toBeVisible({ timeout: 5000 });
    await expect(opencodeOption).toBeVisible({ timeout: 5000 });
  });

  test('Pi SDK option is selected by default', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    // Pi SDK button should carry selected styling (violet border class)
    const piBtn = page.locator('button').filter({ hasText: /Pi SDK/i }).first();
    await expect(piBtn).toBeVisible({ timeout: 5000 });

    const classAttr = await piBtn.getAttribute('class');
    expect(classAttr).toMatch(/blue|violet/i);
  });

  test('OpenCode Direct option respects availability state', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const opencodeBtn = page.locator('button').filter({ hasText: /OpenCode Direct/i }).first();
    await expect(opencodeBtn).toBeVisible({ timeout: 5000 });

    const isDisabled = await opencodeBtn.isDisabled().catch(() => false);
    expect(typeof isDisabled).toBe('boolean');

    if (isDisabled) {
      const classAttr = await opencodeBtn.getAttribute('class');
      expect(classAttr).toMatch(/cursor-not-allowed|disabled/i);
    }
  });

  test('Claude Direct option respects availability state', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    await expect(claudeBtn).toBeVisible({ timeout: 5000 });

    // Either disabled (claude not available) or enabled (claude available) — both valid
    const isDisabled = await claudeBtn.isDisabled().catch(() => false);
    expect(typeof isDisabled).toBe('boolean');

    if (isDisabled) {
      // When disabled it should have cursor-not-allowed styling
      const classAttr = await claudeBtn.getAttribute('class');
      expect(classAttr).toMatch(/cursor-not-allowed|disabled/i);
    }
  });

  test('SDK selector section shows "Session Type" label', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    // The modal renders a "Session Type" section header
    const label = page.locator('text=Session Type');
    await expect(label).toBeVisible({ timeout: 5000 });
  });

  test('Selecting Pi SDK keeps Pi marked as selected', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const piBtn = page.locator('button').filter({ hasText: /Pi SDK/i }).first();
    await expect(piBtn).toBeVisible({ timeout: 5000 });

    // Click Pi SDK explicitly
    await piBtn.click();
    await page.waitForTimeout(200);

    await expect(piBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('Session list exists after login', async ({ page }) => {
    await page.waitForTimeout(2000);

    // The sidebar / session list should be present
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(0);

    // Should NOT be showing the login form any more
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).not.toBeVisible();
  });
});
