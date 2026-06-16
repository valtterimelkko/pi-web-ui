# Pi Web UI Test Guide

This directory contains browser-level tests and benchmark scripts for Pi Web UI.

For server unit/integration tests, also see:
- `server/tests/`

## Test Layers

### 1. Browser E2E tests
Located in:
- `tests/e2e/`

These cover user-visible behaviour such as:
- auth and initial app load
- session creation
- session switching
- runtime-specific flows for the Claude runtime family, OpenCode Direct, and any surfaced Antigravity session UX
- mobile / protocol / persistence / cross-tab behaviour

Notable files include:
- `tests/e2e/dual-sdk-session-creation.spec.ts`
- `tests/e2e/claude-session-chat.spec.ts`
- `tests/e2e/opencode-session-chat.spec.ts`
- `tests/e2e/opencode-session-switch.spec.ts`

### 2. Live validation

Browserless runtime validation is exposed through the Internal API and the
repo-owned CLI runner:

```bash
npm run validate:live -- --runtime claude --scenario smoke
npm run validate:live -- --runtime antigravity --scenario smoke
```

Use it when you need to confirm live server/runtime behaviour without opening
 the web UI. Canonical guide:
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
```

### E2E tests
```bash
npm run test:e2e
```

### Live validation
```bash
npm run validate:live -- --runtime claude --scenario smoke
npm run validate:live -- --runtime antigravity --scenario smoke
```

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
- OpenCode Direct client/service/event handling
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
If you touched Pi Coding Agent / the Claude runtime family / OpenCode Direct / Antigravity routing or replay logic, prefer:
- unit tests for the affected runtime module(s)
- relevant WebSocket tests
- `npm run validate:live -- --runtime <pi|claude|opencode|antigravity|all> --scenario <id>`
- relevant E2E runtime tests

## Notes

- Some runtime-specific tests may depend on optional tools being installed locally.
- OpenCode Direct tests are especially sensitive to `opencode` availability in fully live scenarios.
- Antigravity live validation depends on `agy` being installed and authenticated for the same OS user running Pi Web UI.
- Prefer the canonical app commands from the root `package.json` unless you are targeting one workspace deliberately.
