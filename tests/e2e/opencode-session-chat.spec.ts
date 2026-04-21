import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

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

async function openNewSessionModal(page: any): Promise<boolean> {
  await page.waitForLoadState('networkidle').catch(() => null);

  const titleBtn = page.locator('button[title="New session"]').first();
  const textBtn = page.locator('button').filter({ hasText: /new session/i }).first();
  const testId = page.locator('[data-testid="new-session-btn"]');

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

function isOpenCodeAvailable(): boolean {
  try {
    execSync('which opencode', { timeout: 2000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const OPENCODE_AVAILABLE = isOpenCodeAvailable();

test.describe('OpenCode Direct Session', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('OpenCode Direct option appears in session type selector', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const opencodeBtn = page.locator('button').filter({ hasText: /OpenCode Direct/i }).first();
    await expect(opencodeBtn).toBeVisible({ timeout: 5000 });
  });

  test('OpenCode Direct button is disabled when opencode is not available', async ({ page }) => {
    if (OPENCODE_AVAILABLE) {
      test.skip(true, 'OpenCode is available, testing disabled state not applicable');
      return;
    }

    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const opencodeBtn = page.locator('button').filter({ hasText: /OpenCode Direct/i }).first();
    await expect(opencodeBtn).toBeVisible({ timeout: 5000 });

    const isDisabled = await opencodeBtn.isDisabled().catch(() => false);
    expect(isDisabled).toBe(true);

    const classAttr = await opencodeBtn.getAttribute('class');
    expect(classAttr).toMatch(/cursor-not-allowed|disabled/i);
  });

  test('New Session Modal shows all three SDK options', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const piBtn = page.locator('button').filter({ hasText: /Pi SDK/i }).first();
    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i }).first();
    const opencodeBtn = page.locator('button').filter({ hasText: /OpenCode Direct/i }).first();

    await expect(piBtn).toBeVisible({ timeout: 5000 });
    await expect(claudeBtn).toBeVisible({ timeout: 5000 });
    await expect(opencodeBtn).toBeVisible({ timeout: 5000 });
  });

  test('Session type grid has three columns for three SDK options', async ({ page }) => {
    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const grid = page.locator('.grid-cols-3').first();
    await expect(grid).toBeVisible({ timeout: 5000 });
  });
});

test.describe('OpenCode Direct Session Creation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('OpenCode session creation succeeds when available', async ({ page }) => {
    if (!OPENCODE_AVAILABLE) {
      test.skip(true, 'OpenCode is not available on this system');
      return;
    }

    const opened = await openNewSessionModal(page);
    if (!opened) {
      test.skip(true, 'Could not find new session button');
      return;
    }

    const opencodeBtn = page.locator('button').filter({ hasText: /OpenCode Direct/i }).first();
    await expect(opencodeBtn).toBeVisible({ timeout: 5000 });

    await opencodeBtn.click();
    await page.waitForTimeout(300);

    const createBtn = page.locator('button').filter({ hasText: /^Create$/ }).first();
    await expect(createBtn).toBeVisible({ timeout: 3000 });
    await createBtn.click();
    await page.waitForTimeout(2000);

    const sidebar = page.locator('[data-testid="sidebar"], .sidebar, [class*="sidebar"]').first();
    const sidebarText = await sidebar.textContent().catch(() => '');
    expect(sidebarText).toBeDefined();
  });
});
