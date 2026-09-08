# Pi Web UI Test Guide

This directory contains browser-level tests and benchmark scripts for Pi Web UI.

For server unit/integration tests, also see:
- `server/tests/`

## Test Layers

### 1. Browser E2E tests
Located in:
- `tests/e2e/`

Playwright does not manage a server in this repository: `webServer` is disabled
and the target is `TEST_URL` (default `http://localhost:3457`). Start an
appropriate isolated server yourself and record the target; do not point it at
production merely because the default port is convenient.

These cover user-visible behaviour such as:
- auth and initial app load
- session creation
- session switching
- runtime-specific flows for the Claude runtime family, OpenCode, and any surfaced Antigravity session UX
- mobile / protocol / persistence / cross-tab behaviour

Notable files include:
- `tests/e2e/dual-sdk-session-creation.spec.ts`
- `tests/e2e/claude-session-chat.spec.ts`
- `tests/e2e/opencode-session-chat.spec.ts`
- `tests/e2e/opencode-session-switch.spec.ts`

### 2. Live validation

Browserless runtime validation is exposed through the Internal API and the
repo-owned CLI runner. Start a disposable validation server separately and pass
its printed socket/token paths; the runner refuses production defaults unless
`--allow-production` is explicit:

```bash
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime claude --scenario smoke
```

Use it when you need to confirm live server/runtime behaviour without opening
the web UI. Canonical guide (covers all **three** live-validation options —
Internal API, Playwright E2E, and the browser-WebSocket path via
`scripts/ws-validate.mjs`):
- `docs/LIVE-VALIDATION.md`

Typical uses:
- runtime routing changes
- event normalization or replay fixes
- Claude channel regressions
- OpenCode permission / streaming regressions
- Antigravity prompt / replay / model-listing regressions
- internal API contract changes

### 3. Benchmarks
Located in:
- `tests/benchmarks/`

These focus on UI performance and memory-related scenarios.

## Running Tests

### All tests
```bash
npm test
npm run test:coverage
```

These root commands run all four required workspaces sequentially with at most
two workers: shared, server, client and the retained MCP package. The fixed
recipe in `scripts/test-workspaces.mjs` gives children a private HOME/TMPDIR,
both Pi agent-directory overrides and an allowlisted environment. Vitest env
file loading is disabled; server tests mock only `dotenv.config` (explicit
`dotenv.parse` fixtures stay real). Production env loading is unchanged. This
is test isolation, not a filesystem/network sandbox: external services must
still be mocked at the proper boundary.

After each successful workspace, `scripts/check-test-discovery.mjs` joins its
filesystem-derived source/tests inventory to the freshly generated Vitest JSON
report. Missing, empty, all-skipped, failed, duplicate or unexpected required
file results cannot produce a clean root verdict. No optional unit files are
currently declared. E2E and synthetic benchmarks remain separate gates; they
are not silently included in a unit-test pass. Ignored `test-results.json` and
`test-inventory.json` files are workspace-local and overwritten on later runs;
preserve them privately when collecting revision-specific proof.

For a focused development run use the workspace's existing command with a test
path. Such a subset is not a substitute for the root inventory gate. Shared
coverage includes all production source and uses the measured ratchet in
`shared/vitest.config.ts`; other workspace thresholds are unchanged.

### Warning ratchet and checked-in CI

```bash
npm run lint:ratchet -- --base HEAD
```

Use the branch base revision in CI/review, or HEAD for local uncommitted changes.
The gate lints TS/JS source, compares changed implementation warning signatures
against that revision, and preserves warning multiplicity across line shifts and
detected renames. Existing warnings are not permission to add more. The broader
whole-tree ceiling is 1,696: the reconciled 1,690 legacy warnings plus six existing
warnings in the previously unchecked Node CLI-helper tests. Lower this ceiling
when debt is removed; do not raise it to absorb new implementation warnings.

`.github/workflows/application.yml` runs locked installation, docs, lint/ratchet,
typecheck, build, all workspace tests and coverage without provider credentials.
The deterministic compiled/browser smoke joins this workflow in sequence Step 3.
Checked-in workflow coverage is not evidence that a hosted GitHub run passed.

Root CLI-helper tests retain their native Node runner. The server's
`root-cli-tools.test.ts` discovers every `tests/unit/**/*.{test,spec}.mjs`
file, runs it with `node --test`, and requires non-skipped passing assertions
and no failures/cancellations. Missing inventory and all-skipped files fail the
root gate. For focused work, `node --test tests/unit/debug-where.test.mjs` is
still available; its native assertion count is reported separately from the
Vitest wrapper count.

### E2E tests
```bash
npm run test:e2e
```

### Live validation
```bash
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime claude --scenario smoke
```

For Antigravity, use an explicitly authorised target: disposable validation
servers disable it because `agy` has no supported conversation-data directory
override. `--runtime all` in disposable mode currently means Pi, Claude, and
OpenCode only.

### Benchmarks
```bash
npm run benchmark
```

### Quick benchmark pass
```bash
npm run benchmark:quick
```

## Server-side Tests

Server unit/integration coverage lives under:
- `server/tests/unit/`
- `server/tests/integration/`

That includes coverage for:
- Pi worker/session logic
- Claude runtime replay and process handling
- OpenCode client/service/event handling
- Antigravity replay/store/subscriber handling (`server/tests/unit/antigravity/*`)
- WebSocket routing
- route handlers and security helpers

## When to Run What

### Small backend fix
Run:
```bash
npm run lint
npm run typecheck
npm run build
npm test
```

### UI change
Run the checks above, plus:
```bash
npm run test:e2e
```

### Runtime-path change
If you touched Pi Coding Agent / the Claude runtime family / OpenCode / Antigravity / Command Code routing or replay logic, prefer:
- unit tests for the affected runtime module(s)
- relevant WebSocket tests
- `npm run validate:live -- --socket <validation-sock> --token-path <validation-token> --runtime <pi|claude|opencode|antigravity|all> --scenario <id>` (use `--allow-production` only when explicitly authorised; disposable `all` expands to Pi/Claude/OpenCode). Command Code is excluded from `all`; validate it by starting the validation server with `--command-code-fixture` (deterministic, no provider) or `--command-code-real` — see docs/COMMAND-CODE-INTEGRATION.md
- relevant E2E runtime tests

## Notes

- Some runtime-specific tests may depend on optional tools being installed locally.
- OpenCode tests are especially sensitive to `opencode` availability in fully live scenarios.
- Antigravity live validation depends on `agy` being installed and authenticated for the same OS user running Pi Web UI.
- Prefer the canonical app commands from the root `package.json` unless you are targeting one workspace deliberately.
