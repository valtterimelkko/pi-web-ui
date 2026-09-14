/**
 * Vite build for the lab's product-player page.
 *
 * Separate from the product's own `client/vite.config.ts` on purpose: the lab
 * entrypoint must not become part of the shipped bundle, and the product build
 * must not gain a lab-only input. The repository root is the Vite root so the
 * lab page can import the real client modules (`client/src/lib/speechArbiter`,
 * `client/src/hooks/useReadAloud`) rather than a copy of them.
 */

import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryRoot = resolve(__dirname, '..', '..', '..');

export default defineConfig({
  root: repositoryRoot,
  // Relative asset URLs so the bundle can be served from any lab-owned port.
  base: './',
  plugins: [react()],
  // The product client loads its own env; the lab defines only what it needs.
  envDir: false,
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(''),
  },
  build: {
    outDir: process.env.AUDIO_LAB_BUNDLE_OUT ?? resolve(repositoryRoot, 'lab-bundle'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'lab.html'),
      output: {
        entryFileNames: 'assets/lab-[name].js',
        chunkFileNames: 'assets/lab-[name].js',
        assetFileNames: 'assets/lab-[name][extname]',
      },
    },
  },
});
