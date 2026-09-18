import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for E2E testing
 * 
 * To run E2E tests:
 * npm run test:e2e
 * 
 * Or manually:
 * 1. Start the dev server: npm run dev
 * 2. In another terminal: npx playwright test
 */
export default defineConfig({
  testDir: './tests/e2e',
  // The voice-live-lab specs each need their own dev lab page and their own
  // webServer, so they ship their own configs (playwright.voice-live*.config.ts)
  // and are opt-in. Without this, a bare `npx playwright test` picks them up and
  // runs them against this suite's server/page, where they cannot pass.
  testIgnore: ['**/voice-live-*.spec.ts'],
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  // The suites share one single-operator server and its security limits/state;
  // parallel workers make otherwise valid logins and lifecycle checks interfere.
  // Keep the default deterministic while allowing an explicit isolated setup
  // to opt into parallelism.
  workers: Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? '1', 10),
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || process.env.TEST_URL || 'http://localhost:3457',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 15000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 }
      },
    },
  ],
  // Web server configuration - disabled for production testing
  // Server should be running separately (e.g., via systemd)
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:3456',
  //   reuseExistingServer: true,
  //   timeout: 120000,
  // },
  expect: {
    timeout: 10000,
    toHaveScreenshot: {
      maxDiffPixels: 100,
      threshold: 0.2,
    },
  },
});
