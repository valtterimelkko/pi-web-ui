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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Copy Message Buttons', () => {
  test.beforeEach(async ({ page, context }) => {
    // Grant clipboard permissions so we can read back what was copied
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page);
  });

  async function findSessionWithMessages(page: any) {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();

    if (count === 0) {
      return null;
    }

    // Try each session until we find one with assistant messages
    for (let i = 0; i < count; i++) {
      await sessionItems.nth(i).click();
      // Wait for assistant messages to appear (with polling)
      try {
        await page.waitForSelector('div.border-l-2.border-blue-400', { timeout: 5000 });
        const assistantMessages = page.locator('div.border-l-2.border-blue-400');
        const msgCount = await assistantMessages.count();
        if (msgCount > 0) {
          return assistantMessages;
        }
      } catch {
        // Timeout - no messages in this session
      }
    }

    return null;
  }

  test('top and bottom copy buttons exist on assistant messages', async ({ page }) => {
    const assistantMessages = await findSessionWithMessages(page);

    if (!assistantMessages) {
      test.skip(true, 'No sessions with assistant messages available');
      return;
    }

    const msgCount = await assistantMessages.count();

    // For each assistant message, verify both copy buttons are present
    for (let i = 0; i < Math.min(msgCount, 3); i++) {
      const msg = assistantMessages.nth(i);
      const copyButtons = msg.locator('button[title="Copy message"], button[title="Copied!"]');
      // Each message should have two copy buttons (top + bottom)
      await expect(copyButtons).toHaveCount(2);
    }
  });

  test('clicking copy button copies full message text to clipboard', async ({ page }) => {
    const assistantMessages = await findSessionWithMessages(page);

    if (!assistantMessages) {
      test.skip(true, 'No sessions with assistant messages available');
      return;
    }

    // Pick the first assistant message
    const firstMsg = assistantMessages.first();

    // Get the message text content (from the prose container inside)
    const prose = firstMsg.locator('div.prose');
    const messageText = await prose.textContent() || '';

    // Click the top copy button
    const topCopyBtn = firstMsg.locator('button[title="Copy message"]').first();
    await topCopyBtn.click();

    // Wait a moment for the copy to complete
    await page.waitForTimeout(500);

    // Read clipboard and verify it contains the message text
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    // The clipboard should contain the full message text (may include extra whitespace)
    expect(clipboardText.trim().length).toBeGreaterThan(0);
    expect(messageText.trim().length).toBeGreaterThan(0);

    // Verify a meaningful substring matches (ignore whitespace differences)
    const normalizedClipboard = clipboardText.replace(/\s+/g, ' ').trim();
    const normalizedMessage = messageText.replace(/\s+/g, ' ').trim();
    expect(normalizedClipboard).toContain(normalizedMessage.substring(0, Math.min(50, normalizedMessage.length)));
  });

  test('bottom copy button also copies message text', async ({ page }) => {
    const assistantMessages = await findSessionWithMessages(page);

    if (!assistantMessages) {
      test.skip(true, 'No sessions with assistant messages available');
      return;
    }

    const firstMsg = assistantMessages.first();
    const prose = firstMsg.locator('div.prose');
    const messageText = await prose.textContent() || '';

    // Clear clipboard first
    await page.evaluate(() => navigator.clipboard.writeText(''));

    // Click the bottom copy button (second button in the message)
    const bottomCopyBtn = firstMsg.locator('button[title="Copy message"]').nth(1);
    await bottomCopyBtn.click();

    await page.waitForTimeout(500);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText.trim().length).toBeGreaterThan(0);

    const normalizedClipboard = clipboardText.replace(/\s+/g, ' ').trim();
    const normalizedMessage = messageText.replace(/\s+/g, ' ').trim();
    expect(normalizedClipboard).toContain(normalizedMessage.substring(0, Math.min(50, normalizedMessage.length)));
  });

  test('copy buttons work on mobile viewport', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 375, height: 667 });

    const assistantMessages = await findSessionWithMessages(page);

    if (!assistantMessages) {
      test.skip(true, 'No sessions with assistant messages available');
      return;
    }

    // On mobile, clicking a session may open a sidebar overlay; close it with Escape
    const overlay = page.locator('div.fixed.inset-0.bg-black\\/30.z-40');
    if (await overlay.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    const firstMsg = assistantMessages.first();

    // On mobile, buttons should be visible (not hover-dependent)
    const topCopyBtn = firstMsg.locator('button[title="Copy message"]').first();
    await expect(topCopyBtn).toBeVisible();

    // Click and verify copy works (force on mobile to bypass sidebar overlay)
    await topCopyBtn.click({ force: true });
    await page.waitForTimeout(500);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText.trim().length).toBeGreaterThan(0);
  });
});
