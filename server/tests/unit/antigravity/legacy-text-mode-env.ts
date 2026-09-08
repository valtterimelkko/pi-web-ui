// Must be imported BEFORE config.js in legacy-path test files: pins the
// rollback hatch so these suites exercise the text print-mode wrapper.
// (Vitest evaluates imports in order; each test file gets a fresh module graph.)
process.env.ANTIGRAVITY_STREAM_MODE = 'false';
