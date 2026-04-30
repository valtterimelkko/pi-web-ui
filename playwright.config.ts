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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:3457',
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
