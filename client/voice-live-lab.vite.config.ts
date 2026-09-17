import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the Voice Mode ducking lab page (Track C).
 *
 * Separate from `client/vite.config.ts` on purpose: the lab entrypoint must not
 * become part of the shipped bundle, and the product build must not gain a
 * lab-only input. The repository root is the Vite root so the page can import
 * the REAL product modules (`client/src/lib/voiceLive/*`, the speech arbiter,
 * the React components) rather than copies of them.
 *
 * It is used as a dev server (no build): Vite transforms the TypeScript/TSX on
 * the fly, so the spec always exercises the current source.
 */

const clientDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(clientDir, '..');

export default defineConfig({
  root: repositoryRoot,
  base: './',
  envDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VOICE_LIVE_LAB_PORT ?? 3459),
    strictPort: true,
    fs: { allow: [repositoryRoot] },
  },
});
