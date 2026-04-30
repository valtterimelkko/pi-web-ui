import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(page: any) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill('admin');
    await page.locator('button[type="submit"]').click();
    // Wait for JWT cookie to be set and chat interface to mount
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 15000 });
    await page.waitForTimeout(1000);
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

async function findSessionWithMessages(page: any) {
  await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 15000 });
  const sessionItems = page.locator('[role="listitem"]');
  const count = await sessionItems.count();

  if (count === 0) return null;

  for (let i = 0; i < count; i++) {
    await sessionItems.nth(i).click();
    await page.waitForTimeout(2000);
    try {
      await page.waitForSelector('div.border-l-2.border-blue-400', { timeout: 5000 });
      const assistantMessages = page.locator('div.border-l-2.border-blue-400');
      const msgCount = await assistantMessages.count();
      if (msgCount > 0) return assistantMessages;
    } catch {
      // no messages in this session
    }
  }
  return null;
}

/**
 * Fallback: create a new Pi SDK session and send a prompt.
 * Handles parallel test workers by waiting for modal to close and session to fully init.
 */
async function createSessionAndSendPrompt(page: any) {
  const opened = await openNewSessionModal(page);
  if (!opened) return null;

  const createBtn = page.locator('button').filter({ hasText: /^Create$/ }).first();
  if (!(await createBtn.isVisible().catch(() => false))) return null;
  await createBtn.click();

  // Wait for the modal to close (session was created and selected)
  await page.waitForSelector('[data-testid="new-session-modal"]', { state: 'detached', timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(500);

  // Wait for the textarea to be visible and enabled (session initialization may take time)
  const input = page.locator('textarea').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea');
    return ta && !ta.disabled;
  }, { timeout: 30000 });

  await input.fill('Say hello in one short sentence.');
  await input.press('Enter');

  // Wait for assistant response to appear
  await page.waitForSelector('div.border-l-2.border-blue-400', { timeout: 120000 });

  return page.locator('div.border-l-2.border-blue-400');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe.serial('Read Aloud Buttons', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('top and bottom read-aloud buttons exist on assistant messages', async ({ page }) => {
    let assistantMessages = await findSessionWithMessages(page);
    if (!assistantMessages) assistantMessages = await createSessionAndSendPrompt(page);
    if (!assistantMessages) {
      test.skip(true, 'Could not find or create a session with messages');
      return;
    }

    const msgCount = await assistantMessages.count();
    if (msgCount === 0) {
      test.skip(true, 'No assistant messages found');
      return;
    }

    for (let i = 0; i < Math.min(msgCount, 3); i++) {
      const msg = assistantMessages.nth(i);
      // Buttons may be hidden behind opacity-0 on desktop; use count check
      const readAloudButtons = msg.locator('button[title="Read aloud"], button[title="Stop"], button[title="Loading…"]');
      await expect(readAloudButtons).toHaveCount(2);
    }
  });

  test('clicking read-aloud button triggers audio generation', async ({ page, context }) => {
    let assistantMessages = await findSessionWithMessages(page);
    if (!assistantMessages) assistantMessages = await createSessionAndSendPrompt(page);
    if (!assistantMessages) {
      test.skip(true, 'Could not find or create a session with messages');
      return;
    }

    const msgCount = await assistantMessages.count();
    if (msgCount === 0) {
      test.skip(true, 'No assistant messages found');
      return;
    }

    const firstMsg = assistantMessages.first();

    // Scroll into view and hover to reveal buttons (virtualized list + opacity-0 on desktop)
    await firstMsg.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await firstMsg.hover();
    await page.waitForTimeout(300);

    const topBtn = firstMsg.locator('button[title="Read aloud"]').first();
    await expect(topBtn).toBeVisible({ timeout: 3000 });

    // Intercept the TTS API call to verify it fires
    const ttsPromise = page.waitForRequest((req: any) => req.url().includes('/api/tts') && req.method() === 'POST', { timeout: 15000 });

    await topBtn.click();

    // Wait for the TTS request to be made
    const ttsReq = await ttsPromise;
    expect(ttsReq).toBeTruthy();

    // The button should switch to loading or playing state within a few seconds
    const activeBtn = firstMsg.locator('button[title="Stop"], button[title="Loading…"]').first();
    await expect(activeBtn).toBeVisible({ timeout: 10000 });
  });
});
