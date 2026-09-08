import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers/login';

async function login(page: any) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  await loginIfNeeded(page);
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

  await expect(btn, 'New Session control must be available after authentication').toBeVisible({ timeout: 5000 });

  await btn.click();
  // Wait for modal; a missing required control is a test failure, not a capability skip.
  await expect(page.locator('[data-testid="new-session-modal"]')).toBeVisible({ timeout: 5000 });
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

  test('OpenCode Direct is disabled with an unavailable-capability reason', async ({ page }) => {
    await openNewSessionModal(page);

    const opencodeBtn = page.locator('button').filter({ hasText: /OpenCode Direct/i }).first();
    await expect(opencodeBtn).toBeVisible({ timeout: 5000 });
    await expect(opencodeBtn).toBeDisabled();
    await expect(opencodeBtn).toContainText(/not available|unavailable|not installed|auth/i);
  });

  test('Claude Direct is disabled with an unavailable-capability reason', async ({ page }) => {
    await openNewSessionModal(page);

    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    await expect(claudeBtn).toBeVisible({ timeout: 5000 });
    await expect(claudeBtn).toBeDisabled();
    await expect(claudeBtn).toContainText(/not available|unavailable|not installed|auth/i);
  });

  test('Command Code capability enables its model controls in the fixture', async ({ page }) => {
    await openNewSessionModal(page);

    // The disposable fixture advertises Command Code. This is an expected
    // capability assertion, not a type check on isDisabled().
    const commandCodeBtn = page.locator('button').filter({ hasText: /^Command Code/i }).first();
    await expect(commandCodeBtn).toBeVisible({ timeout: 5000 });
    await expect(commandCodeBtn).toBeEnabled();
    await expect(commandCodeBtn).toContainText(/model catalogue/i);
    await commandCodeBtn.click();
    await expect(commandCodeBtn).toHaveAttribute('aria-pressed', 'true');

    const selector = page.locator('[data-testid="commandcode-model-selector"]');
    await expect(selector).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="commandcode-model-select"]')).toBeEnabled();
    await expect(page.locator('[data-testid="commandcode-model-select"] option')).not.toHaveCount(0);
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
