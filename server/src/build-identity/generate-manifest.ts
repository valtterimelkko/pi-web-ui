import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBuildManifest } from './manifest.js';

/**
 * Write the manifest beside the compiled server identity module. This function
 * is called by the server postbuild hook, so a failed TypeScript compilation
 * cannot relabel an older server/dist tree. Client builds call the pure
 * generateBuildManifest helper from Vite instead and never write this file.
 */
export function writeEmbeddedBuildManifest(
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
): void {
  const manifest = generateBuildManifest({ rootDir });
  const outputPath = resolve(rootDir, 'server/dist/build-identity/embedded-manifest.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Running this module is the explicit server postbuild action. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeEmbeddedBuildManifest();
}
