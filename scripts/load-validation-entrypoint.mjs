/** Load exactly one application entrypoint; compiled failures never fall back. */
export async function loadValidationEntrypoint(projectRoot, mode = 'source') {
  if (mode !== 'source' && mode !== 'compiled') {
    throw new Error('Unsupported validation entrypoint mode');
  }
  const entry = mode === 'compiled' ? 'server/dist/index.js' : 'server/src/index.ts';
  return import(new URL(entry, projectRoot).href);
}
