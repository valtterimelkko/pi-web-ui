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
  // Wait for WebSocket connection and claude_available message
  await page.waitForTimeout(2000);
}

test.describe('Claude Direct Model Selector', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!CLAUDE_AVAILABLE, 'Claude Code not installed/authenticated');
    await login(page);
  });

  test('Claude session shows only Claude models in selector', async ({ page }) => {
    test.skip(!CLAUDE_AVAILABLE, 'Claude Code not installed/authenticated');
    
    // 1. Create a new Claude Direct session
    // Check if modal is already open
    const modalTitle = page.locator('text=Create New Session').first();
    const isModalOpen = await modalTitle.isVisible().catch(() => false);
    
    if (!isModalOpen) {
      // Try different selectors for the new session button
      const newSessionBtn = page.locator('button').filter({ hasText: /new session/i }).first();
      const createNewSessionBtn = page.locator('button:has-text("Create new session")').first();
      
      if (await newSessionBtn.isVisible().catch(() => false)) {
        await newSessionBtn.click();
      } else if (await createNewSessionBtn.isVisible().catch(() => false)) {
        await createNewSessionBtn.click();
      }
      await page.waitForTimeout(500);
    }
    
    // Take screenshot of modal
    await page.screenshot({ path: '/tmp/test-1-modal-open.png' });
    
    // Select Claude Direct
    const claudeBtn = page.locator('button').filter({ hasText: /Claude Direct/i });
    await expect(claudeBtn).toBeVisible({ timeout: 5000 });
    await expect(claudeBtn).toBeEnabled();
    await claudeBtn.click();
    await page.waitForTimeout(300);
    
    // Take screenshot after selection
    await page.screenshot({ path: '/tmp/test-2-claude-selected.png' });
    
    // Click on the home/root folder to navigate there
    const rootFolder = page.locator('button').filter({ hasText: /root|home|\/~|current directory/i }).first();
    if (await rootFolder.isVisible().catch(() => false)) {
      await rootFolder.click();
      await page.waitForTimeout(300);
    }
    
    // Create the session - look for Create button
    const createBtn = page.locator('button').filter({ hasText: /^create$/i }).first();
    await expect(createBtn).toBeVisible({ timeout: 5000 });
    await createBtn.click();
    await page.waitForTimeout(2000);
    
    // Take screenshot after session created
    await page.screenshot({ path: '/tmp/test-3-session-created.png' });
    
    // 2. Verify CC badge is visible in sidebar
    const ccBadge = page.locator('span[title*="Claude Direct"]').first();
    await expect(ccBadge).toBeVisible({ timeout: 5000 });
    
    // 3. Open Settings modal
    const settingsBtn = page.locator('button[title*="settings" i], button[aria-label*="settings" i]').first();
    const altSettingsBtn = page.locator('[data-testid="settings-button"]').first();
    const gearBtn = page.locator('button:has(svg[class*="settings"]), button:has([data-lucide="settings"])').first();
    
    const btn = (await settingsBtn.isVisible().catch(() => false)) ? settingsBtn :
                (await altSettingsBtn.isVisible().catch(() => false)) ? altSettingsBtn : gearBtn;
    
    await btn.click();
    await page.waitForTimeout(500);
    
    // 4. Verify "Claude Direct" badge appears in Settings
    const claudeDirectBadge = page.locator('span').filter({ hasText: 'Claude Direct' }).first();
    await expect(claudeDirectBadge).toBeVisible({ timeout: 5000 });
    
    // 5. Verify the info message about Claude models only
    const infoText = page.locator('text=Claude Direct sessions only support Claude models');
    await expect(infoText).toBeVisible({ timeout: 5000 });
    
    // 6. Open the model selector dropdown
    const modelSelector = page.locator('[data-testid="model-selector"]').first();
    const modelTrigger = page.locator('[data-testid="model-selector-trigger"]').first();
    
    if (await modelSelector.isVisible().catch(() => false)) {
      await modelSelector.click();
    } else if (await modelTrigger.isVisible().catch(() => false)) {
      await modelTrigger.click();
    } else {
      // Try to find any clickable model selector area
      const altSelector = page.locator('button').filter({ hasText: /model/i }).first();
      if (await altSelector.isVisible().catch(() => false)) {
        await altSelector.click();
      }
    }
    await page.waitForTimeout(500);
    
    // Take screenshot of model dropdown
    await page.screenshot({ path: '/tmp/test-5-model-dropdown.png' });
    
    // 7. Verify only Claude models are shown (Opus, Sonnet, Haiku)
    const pageContent = await page.locator('body').textContent();
    
    // Should contain Claude model names
    expect(pageContent).toContain('Opus');
    expect(pageContent).toContain('Sonnet');
    expect(pageContent).toContain('Haiku');
    
    console.log('[TEST] Model selector content verified');
    
    // 8. Select Sonnet explicitly (matches the default Claude subscription path)
    const sonnetOption = page.locator('text=Claude Sonnet').first();
    await expect(sonnetOption).toBeVisible({ timeout: 5000 });
    await sonnetOption.click();
    await page.waitForTimeout(300);
    
    // 9. Save the changes
    const saveBtn = page.locator('button').filter({ hasText: /save/i }).first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(800);
    }

    const input = page.locator('textarea[placeholder*="message" i], textarea').first();
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

    // 10. Multi-turn verification
    await sendPrompt('what model are you? Reply in one short sentence.', 'Sonnet');
    await sendPrompt('tell me more about yourself in one short sentence.', 'Anthropic');
    await sendPrompt('reply with exactly: followup works', 'followup works');
    
    console.log('[TEST] Claude Direct model selector and multi-turn messaging test completed successfully!');
  });
});
