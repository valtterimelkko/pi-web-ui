import { defineConfig } from '@playwright/test';

/**
 * Session-render "no visible change" gate (command-centre step 1a).
 * Serves `client/session-render-harness.html` with Vite from client/ (so the
 * product Tailwind config applies) and compares screenshots of the real
 * session components over invented fixtures against committed baselines.
 * Baselines are Linux Chromium renders; regenerate only on purpose:
 *
 *   npx playwright test --config playwright.session-render.config.ts [--update-snapshots]
 */
const PORT = Number(process.env.SESSION_RENDER_HARNESS_PORT ?? 3461);

export default defineConfig({
  testDir: './tests/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'off',
    launchOptions: {
      // Cloud containers ship one pinned Chromium; honour it when present.
      ...(process.env.SESSION_RENDER_CHROMIUM ? { executablePath: process.env.SESSION_RENDER_CHROMIUM } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx vite --config session-render-harness.vite.config.ts --port ${PORT} --strictPort`,
    cwd: './client',
    url: `http://127.0.0.1:${PORT}/session-render-harness.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
