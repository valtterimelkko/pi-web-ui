/**
 * Compatibility re-export — the draft/confirmation machinery moved to
 * `proposal-store.ts` when the four-object authority kernel landed (Voice
 * Mode execution plan, Phase 2 / Track A). Import `proposal-store.js`
 * directly for new code; this shim keeps the shipped cascade's existing
 * import paths and test suites working unchanged.
 */
export * from './proposal-store.js';
