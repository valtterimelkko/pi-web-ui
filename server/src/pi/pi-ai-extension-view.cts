/**
 * The `@earendil-works/pi-ai` module that extensions loaded through the factory
 * cache import (SDK 1.5.0). pi-ai's main entry no longer re-exports TypeBox, so
 * the SDK maps extension imports of the pi-ai root (and `/compat`, and the
 * `@mariozechner` twins) to its own `dist/core/extensions/pi-ai-extension-view.js`:
 * pi-ai's compat entry plus TypeBox's `Type` and a TypeBox-typed `StringEnum`.
 * That file is not in the SDK `exports` map, so Pi Web UI carries this
 * equivalent (owner rule: no deep private imports); the importer suite checks
 * its export names against the SDK's view.
 *
 * It cannot import pi-ai compat itself: jiti aliases every specifier in a
 * module it loads, and `@earendil-works/pi-ai/compat` is aliased to this very
 * file. And `require()` of those ES modules is fragile (a race with a parallel
 * `import()`, and loaders such as tsx resolving pi-ai's import-only
 * dependencies with CommonJS conditions). So the importer loads compat and
 * typebox with native `import()` before any extension import
 * (`preloadPiAiExtensionView`) and hands the module namespaces over here. They
 * are the same module objects the SDK's own view re-exports.
 *
 * Plain CommonJS with only erasable types, so Node can load the `.cts` source too.
 */
type Stash = { compat: Record<string, unknown>; Type: typeof import('typebox')['Type'] };

const stash = (globalThis as Record<symbol, unknown>)[Symbol.for('pi-web-ui.pi-ai-extension-view')] as Stash | undefined;
if (!stash) {
  throw new Error('pi-ai extension view loaded before the importer preloaded pi-ai compat and typebox');
}
const { compat, Type } = stash;

/** A `{ type: "string", enum: [...] }` schema typed for TypeBox's `Static` (as the SDK's view). */
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

module.exports = { ...compat, Type, StringEnum };
