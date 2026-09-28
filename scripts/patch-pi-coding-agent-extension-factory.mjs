#!/usr/bin/env node
/**
 * Guarded local patch for @earendil-works/pi-coding-agent 0.87.1 — additive
 * extension-factory accessor (B1.2).
 *
 * WHY THIS EXISTS
 * B1.2 attributed production event-loop lag spikes (p99 300–919 ms, 0–3 active
 * API turns) to per-session extension loading: `PiService.createSession` builds
 * a fresh `DefaultResourceLoader` and `await loader.reload()` for every session,
 * and the SDK's extension module cache is a single-slot, cwd-keyed Map cleared
 * whenever the cwd differs (`useExtensionCacheCwd()`), so nearly every session
 * open re-transpiles ~780 KB of TypeScript across 16 extension entries with
 * jiti `moduleCache: false`.
 *
 * The fix caches the extension *module factories* (the default exports) once per
 * process and lets each session initialise its own fresh runtime from them
 * (`loadExtensionFromFactory(factory, realCwd, eventBus, freshRuntime, path)`) —
 * the SDK's supported per-session shape. That needs two functions the package
 * entry does not re-export:
 *   - a way to import a module and get its factory (`loadExtensionModule`,
 *     not exported anywhere); and
 *   - `loadExtensionFromFactory` (exported by the `core/extensions` barrel but
 *     not by the package entry).
 * Both were confirmed absent at runtime before this patch
 * (`importExtensionFactory=undefined`, `loadExtensionFromFactory=undefined`).
 *
 * WHAT THE PATCH DOES (purely additive — no existing export or behaviour changes)
 *   1. dist/core/extensions/loader.js       — re-exports the existing private
 *      `loadExtensionModule` as `importExtensionFactory`, and adds
 *      `seedExtensionFactory(path, factory, cwd)` which places an already-imported
 *      factory into the SDK's own module cache for a cwd (calling the SDK's own
 *      `useExtensionCacheCwd` / `extensionCache`, so the cache semantics are
 *      unchanged).
 *   2. dist/core/extensions/index.js        — re-exports both from the loader
 *      alongside the exports already listed.
 *   3. dist/index.js                        — re-exports `importExtensionFactory`
 *      and `seedExtensionFactory` (and the barrel's existing
 *      `loadExtensionFromFactory`) from the extensions barrel.
 * No function body is modified, no export is removed, and every pre-existing
 * export keeps its identity. The seeding helper only lets a caller place a
 * factory where the SDK would have put it anyway; `initializeExtension` still
 * runs per load, so each session keeps its own Extension objects and runtime.
 *
 * MAINTAINABILITY COST (deliberate, documented)
 * This edits files inside node_modules. It is applied idempotently to every
 * physical pi-coding-agent copy under the repo's node_modules, and re-applied on
 * `npm ci` / `npm install` via the root package.json "postinstall" hook. It fails
 * loudly (exit 1) when the version or the anchor text is not exactly what it
 * knows, which means the SDK changed and the patch must be re-evaluated. The
 * runtime falls back to the unpatched path (with one warning) when the accessor
 * is absent, so a missing patch degrades to today's behaviour rather than
 * breaking sessions.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '0.87.1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_MARKER = 'seedExtensionFactory';

const LOADER_ANCHOR = '\n//# sourceMappingURL=loader.js.map';
const LOADER_ADDITION = `
// pi-web-ui local patch (scripts/patch-pi-coding-agent-extension-factory.mjs):
// additive helpers for the B1.2 extension-factory cache. Purely additive; no
// existing export, function body or cache behaviour changes.
//   importExtensionFactory: import an extension module and return its
//     default-export factory (the private loadExtensionModule).
//   seedExtensionFactory: place an already-imported factory into the SDK's own
//     module cache for a cwd. loadExtensionsCached then reuses the factory while
//     still calling initializeExtension per load, so every session keeps its own
//     Extension objects and extension runtime.
export { loadExtensionModule as importExtensionFactory };
export function seedExtensionFactory(extensionPath, factory, cwd) {
    const token = useExtensionCacheCwd(cwd);
    if (isCurrentCacheToken(token)) {
        extensionCache.set(extensionPath, factory);
        return true;
    }
    return false;
}

//# sourceMappingURL=loader.js.map`;

const BARREL_ORIGINAL =
  'export { createExtensionRuntime, discoverAndLoadExtensions, loadExtensionFromFactory, loadExtensions, } from "./loader.js";';
const BARREL_PATCHED =
  'export { createExtensionRuntime, discoverAndLoadExtensions, importExtensionFactory, loadExtensionFromFactory, loadExtensions, seedExtensionFactory, } from "./loader.js";';

const ENTRY_ORIGINAL =
  'export { createExtensionRuntime, defineTool, discoverAndLoadExtensions, ExtensionRunner, isBashToolResult, isEditToolResult, isFindToolResult, isGrepToolResult, isLsToolResult, isPowerShellToolResult, isReadToolResult, isToolCallEventType, isWriteToolResult, wrapRegisteredTool, wrapRegisteredTools, } from "./core/extensions/index.js";';
const ENTRY_PATCHED =
  'export { createExtensionRuntime, defineTool, discoverAndLoadExtensions, ExtensionRunner, importExtensionFactory, isBashToolResult, isEditToolResult, isFindToolResult, isGrepToolResult, isLsToolResult, isPowerShellToolResult, isReadToolResult, isToolCallEventType, isWriteToolResult, loadExtensionFromFactory, seedExtensionFactory, wrapRegisteredTool, wrapRegisteredTools, } from "./core/extensions/index.js";';

/** Find every physical @earendil-works/pi-coding-agent install under node_modules. */
function findCopies(dir, depth, results) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === '.bin' || entry.name.startsWith('.'))) continue;
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.name === '@earendil-works') {
        const candidate = join(dir, entry.name, 'pi-coding-agent');
        try {
          const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
          if (pkg.name === '@earendil-works/pi-coding-agent' && !statSync(candidate).isSymbolicLink()) {
            results.push(candidate);
          }
        } catch { /* not a pi-coding-agent package dir */ }
      }
      findCopies(join(dir, entry.name), depth + 1, results);
    }
  }
}

/** Insert `addition` once, anchored on exact text. Returns undefined when the anchor is missing. */
function insertOnce(source, anchor, addition) {
  const anchorCount = source.split(anchor).length - 1;
  if (anchorCount !== 1) return undefined;
  return source.replace(anchor, addition);
}

const failures = [];
const patched = [];
const already = [];

const copies = [];
findCopies(join(repoRoot, 'node_modules'), 0, copies);

if (copies.length === 0) {
  failures.push('no @earendil-works/pi-coding-agent install found under node_modules — nothing to patch (install first)');
}

for (const copy of copies) {
  let version;
  try {
    version = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version;
  } catch (error) {
    failures.push(`${copy}: cannot read package.json (${error.message})`);
    continue;
  }
  if (version !== EXPECTED_VERSION) {
    failures.push(
      `${copy}: pi-coding-agent version is ${version}, expected ${EXPECTED_VERSION}. ` +
      'The dependency was updated — re-evaluate this patch (if upstream now exports a factory ' +
      'accessor, delete scripts/patch-pi-coding-agent-extension-factory.mjs, the postinstall hook ' +
      'and the guard test; otherwise update the anchors for the new version).',
    );
    continue;
  }

  const loaderPath = join(copy, 'dist', 'core', 'extensions', 'loader.js');
  const barrelPath = join(copy, 'dist', 'core', 'extensions', 'index.js');
  const entryPath = join(copy, 'dist', 'index.js');

  let loaderSource;
  let barrelSource;
  let entrySource;
  try {
    loaderSource = readFileSync(loaderPath, 'utf8');
    barrelSource = readFileSync(barrelPath, 'utf8');
    entrySource = readFileSync(entryPath, 'utf8');
  } catch (error) {
    failures.push(`${copy}: cannot read the target dist files (${error.message})`);
    continue;
  }

  const loaderDone = loaderSource.includes('export { loadExtensionModule as importExtensionFactory };')
    && loaderSource.includes(`export function ${PATCH_MARKER}(`);
  const barrelDone = barrelSource.includes(BARREL_PATCHED);
  const entryDone = entrySource.includes(ENTRY_PATCHED);
  if (loaderDone && barrelDone && entryDone) {
    already.push(copy);
    continue;
  }

  const nextLoader = loaderDone ? loaderSource : insertOnce(loaderSource, LOADER_ANCHOR, LOADER_ADDITION);
  const nextBarrel = barrelDone ? barrelSource : insertOnce(barrelSource, BARREL_ORIGINAL, BARREL_PATCHED);
  const nextEntry = entryDone ? entrySource : insertOnce(entrySource, ENTRY_ORIGINAL, ENTRY_PATCHED);

  if (nextLoader === undefined || nextBarrel === undefined || nextEntry === undefined) {
    failures.push(
      `${copy}: dist files do not match the expected ${EXPECTED_VERSION} content ` +
      `(loader anchor ${loaderSource.split(LOADER_ANCHOR).length - 1}x, barrel export ${barrelSource.includes(BARREL_ORIGINAL) ? 'found' : 'missing'}, ` +
      `entry export ${entrySource.includes(ENTRY_ORIGINAL) ? 'found' : 'missing'}). ` +
      'Refusing to patch unknown content — re-evaluate scripts/patch-pi-coding-agent-extension-factory.mjs.',
    );
    continue;
  }

  writeFileSync(loaderPath, nextLoader);
  writeFileSync(barrelPath, nextBarrel);
  writeFileSync(entryPath, nextEntry);
  patched.push(copy);
}

for (const copy of already) console.log(`[patch-pi-coding-agent-extension-factory] already patched: ${copy}`);
for (const copy of patched) console.log(`[patch-pi-coding-agent-extension-factory] patched:        ${copy}`);
for (const failure of failures) console.error(`[patch-pi-coding-agent-extension-factory] FAIL: ${failure}`);

if (failures.length > 0) {
  console.error('[patch-pi-coding-agent-extension-factory] refusing to continue with unpatched/unknown pi-coding-agent content.');
  process.exit(1);
}
console.log('[patch-pi-coding-agent-extension-factory] all pi-coding-agent copies carry the additive extension-factory accessor.');
