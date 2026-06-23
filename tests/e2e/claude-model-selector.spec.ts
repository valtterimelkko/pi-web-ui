import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

// Check if Claude is available for testing
function isClaudeAvailable(): boolean {
  try {
    execSync('which claude', { timeout: 2000, stdio: 'pipe' });
    const result = execSync('claude auth status --json', { encoding: 'utf-8', timeout: 5000 });
    const parsed = JSON.parse(result);
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

const CLAUDE_AVAILABLE = isClaudeAvailable();

async function login(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill('Ey@U1U%d5D77J99F');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
  }
  // Wait for WebSocket connection and claude_available message
  await page.waitForTimeout(2000);
}

test.describe('Claude Direct Model Selector', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!CLAUDE_AVAILABLE, 'Claude Code not installed/authenticated');
    await login(page);
  });

  test('Claude session locks the in-session model selector (Channel backend disabled)', async ({ page }) => {
    test.skip(!CLAUDE_AVAILABLE, 'Claude Code not installed/authenticated');

    // 1. Open the New Session modal
    const modalTitle = page.locator('text=Create New Session').first();
    const isModalOpen = await modalTitle.isVisible().catch(() => false);
    if (!isModalOpen) {
      const newSessionBtn = page.locator('button').filter({ hasText: /new session/i }).first();
      const createNewSessionBtn = page.locator('button:has-text("Create new session")').first();
      if (await newSessionBtn.isVisible().catch(() => false)) {
        await newSessionBtn.click();
      } else if (await createNewSessionBtn.isVisible().catch(() => false)) {
        await createNewSessionBtn.click();
      }
      await page.waitForTimeout(500);
    }

    // 2. Select Claude Direct
    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i });
    await expect(claudeBtn).toBeVisible({ timeout: 5000 });
    await expect(claudeBtn).toBeEnabled();
    await claudeBtn.click();
    await page.waitForTimeout(800);

    // 3. The Channel backend (if surfaced by configured profiles) must be disabled
    const channelBackend = page.locator('[data-testid="claude-backend-channel"]');
    if (await channelBackend.isVisible().catch(() => false)) {
      await expect(channelBackend).toBeDisabled();
      await expect(page.locator('[data-testid="claude-backend-locked-note"]')).toBeVisible();
    }

    // 4. Create the session
    const createBtn = page.locator('button').filter({ hasText: /^create$/i }).first();
    await expect(createBtn).toBeVisible({ timeout: 5000 });
    await createBtn.click();
    await page.waitForTimeout(2000);

    // 5. Verify CC badge is visible
    const ccBadge = page.locator('span[title*="Claude Direct"]').first();
    await expect(ccBadge).toBeVisible({ timeout: 5000 });

    // 6. Open Settings modal via the model pill in the composer
    const modelPill = page.locator('button[title="Change model"]').first();
    await expect(modelPill).toBeVisible({ timeout: 5000 });
    await modelPill.click();
    await page.waitForTimeout(500);

    // 7. Claude Direct badge appears in Settings
    const claudeDirectBadge = page.locator('span').filter({ hasText: 'Claude Direct' }).first();
    await expect(claudeDirectBadge).toBeVisible({ timeout: 5000 });

    // 8. The model is LOCKED for the session: the locked panel is present and
    //    there is NO interactive model selector dropdown.
    await expect(page.locator('[data-testid="claude-model-locked"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="claude-model-locked-note"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="model-selector"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="model-selector-trigger"]')).toHaveCount(0);

    // 9. The thinking-level selector is still present and interactive
    await expect(page.getByText('Thinking Level')).toBeVisible({ timeout: 5000 });

    // Close settings (Escape) before chatting
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 10. Multi-turn messaging still works — the model is fixed by session
    //     creation, not by the (now locked) in-session selector.
    const input = page.locator('textarea').first();
    await expect(input).toBeVisible({ timeout: 5000 });

    const sendPrompt = async (prompt: string, expectedFragment: string, timeoutMs = 15000) => {
      await input.fill(prompt);
      await page.waitForTimeout(200);
      const sendBtn = page.locator('button[title="Send message"]').first();
      if (await sendBtn.isEnabled().catch(() => false)) {
        await sendBtn.click();
      } else {
        await input.press('Control+Enter');
      }
      await expect(page.locator(`text=${expectedFragment}`)).toBeVisible({ timeout: timeoutMs });
    };

    await sendPrompt('reply with exactly: followup works', 'followup works');

    console.log('[TEST] Claude locked model selector + disabled Channel backend test completed successfully!');
  });
});
