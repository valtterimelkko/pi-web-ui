/**
 * Extension overlays for the heap soak harness (B0 defect 6).
 *
 * A soak often needs to exercise an extension fix from its source tree BEFORE
 * it is deployed to `~/.pi/agent/extensions`. The isolated agent dir is built
 * by copying the production `extensions/` directory; an overlay copies the
 * given extension directories on top of that copy, so the fix is under test
 * while the production extensions stay untouched.
 *
 * Two accepted forms, matching the CLI's `--extensions-overlay <dir>`:
 *   - a single extension directory (contains `index.ts`/`index.js`/…), or
 *   - a directory whose immediate subdirectories are extension directories.
 *
 * Pure-ish (filesystem only), so the copy behaviour is unit-tested.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface AppliedExtensionOverlay {
  /** Extension directory name as it lands under `<agentDir>/extensions/<name>`. */
  name: string;
  /** Source directory copied from. */
  source: string;
  /** Destination directory under the isolated agent dir. */
  dest: string;
}

export interface ExtensionsOverlayResult {
  applied: AppliedExtensionOverlay[];
}

/** Entry files whose presence marks a directory as a single Pi extension. */
export const EXTENSION_ENTRY_FILES = ['index.ts', 'index.js', 'index.mjs', 'index.cjs', 'index.tsx'] as const;

export function looksLikeSingleExtensionDir(dir: string): boolean {
  return EXTENSION_ENTRY_FILES.some((file) => existsSync(path.join(dir, file)));
}

/**
 * Copy each overlay source into `<agentDir>/extensions/`, overwriting the
 * production-copied extension of the same name. Throws on a missing/non-directory
 * source or a source that resolves to zero extension directories, so a mistyped
 * overlay fails the run loudly instead of silently soaking the production copy.
 */
export function applyExtensionsOverlays(agentDir: string, overlayDirs: readonly string[]): ExtensionsOverlayResult {
  const extensionsRoot = path.join(agentDir, 'extensions');
  mkdirSync(extensionsRoot, { recursive: true });
  const applied: AppliedExtensionOverlay[] = [];

  for (const rawSource of overlayDirs) {
    const source = path.resolve(rawSource);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`--extensions-overlay path is not a directory: ${rawSource}`);
    }

    const extensionDirs: { name: string; src: string }[] = looksLikeSingleExtensionDir(source)
      ? [{ name: path.basename(source), src: source }]
      : readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, src: path.join(source, entry.name) }));

    if (extensionDirs.length === 0) {
      throw new Error(`--extensions-overlay ${rawSource} contains no extension directories (and no index.* to treat as one)`);
    }

    for (const extensionDir of extensionDirs) {
      const dest = path.join(extensionsRoot, extensionDir.name);
      cpSync(extensionDir.src, dest, { recursive: true, dereference: true, force: true });
      applied.push({ name: extensionDir.name, source: extensionDir.src, dest });
    }
  }

  return { applied };
}
