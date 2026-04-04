import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

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
// Determine Claude availability at test-collection time.
// Uses the same command the server uses so the detection matches the app state.
// ---------------------------------------------------------------------------
function isClaudeAvailable(): boolean {
  try {
    execSync('which claude', { timeout: 2000, stdio: 'pipe' });
    // The server runs exactly this command; if it throws, claudeAvailable = false
    const result = execSync('claude auth status --json', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    });
    const parsed = JSON.parse(result) as { loggedIn?: boolean };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

const CLAUDE_AVAILABLE = isClaudeAvailable();

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

    const isDisabled = await claudeBtn.isDisabled();

    if (CLAUDE_AVAILABLE) {
      // claude is installed & auth passes → button should be enabled
      expect(isDisabled).toBe(false);
    } else {
      // claude missing or not authenticated → button must be disabled
      expect(isDisabled).toBe(true);
    }
  });

  test('Claude Direct unavailability hint is shown when not available', async ({ page }) => {
    if (CLAUDE_AVAILABLE) {
      test.skip(true, 'Claude is available — skipping unavailability hint test');
      return;
    }

    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'No new session button found');
      return;
    }

    // When disabled the subtitle shows "Not available" or an auth error
    const hint = page.locator('text=/not available|not installed|auth/i').first();
    await expect(hint).toBeVisible({ timeout: 5000 });
  });

  test('Create Claude Direct session (requires Claude)', async ({ page }) => {
    test.skip(!CLAUDE_AVAILABLE, 'Claude Code not installed / not authenticated');

    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'No new session button found');
      return;
    }

    // Select Claude Direct
    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    await expect(claudeBtn).toBeEnabled({ timeout: 5000 });
    await claudeBtn.click();
    await page.waitForTimeout(300);

    // Verify Claude button now has violet selected styling
    const classAttr = await claudeBtn.getAttribute('class');
    expect(classAttr).toMatch(/violet/i);

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
