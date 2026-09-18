import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Track L's voice-surface evidence (Wave 3).
 *
 * Deliberately separate from the repository's main `playwright.config.ts`: that
 * suite boots a whole disposable application server in global setup, which a
 * page-level presentation/read-back measurement neither needs nor should depend
 * on. Like Track C's ducking config, this one serves the lab page with Vite —
 * the lab imports the REAL product modules from source — and runs in Chromium.
 *
 *   npx playwright test --config playwright.voice-live-presentation.config.ts
 *
 * (Kept separate from `playwright.voice-live.config.ts`, which pins Track C's
 * ducking spec, so neither track's evidence can filter the other's out.)
 */
const PORT = Number(process.env.VOICE_LIVE_LAB_PORT ?? 3459);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /voice-live-presentation\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    launchOptions: {
      args: [
        // The lane's capture path must not depend on a prior gesture, and
        // headless Chromium needs an explicit input device for getUserMedia.
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx vite --config client/voice-live-lab.vite.config.ts --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/client/voice-live-lab.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
