import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the session-render screenshot harness (command-centre step
 * 1a "no visible change" gate). Separate from `vite.config.ts` so the harness
 * never becomes part of the shipped bundle. Root is `client/` so the product's
 * own PostCSS + Tailwind config (and its `content` globs) apply unchanged: a
 * class purged from the product is purged here too. Run with cwd = client/.
 */
const clientDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientDir,
  envDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.SESSION_RENDER_HARNESS_PORT ?? 3461),
    strictPort: true,
    fs: { allow: [dirname(clientDir)] },
  },
});
