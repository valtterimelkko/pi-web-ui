# Pi Web UI Test Guide

This directory contains browser-level tests, benchmark scripts, and a few helper scripts for Pi Web UI.

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
- runtime-specific flows for Claude Direct and OpenCode Direct
- mobile / protocol / persistence / cross-tab behaviour

Notable files include:
- `tests/e2e/dual-sdk-session-creation.spec.ts`
- `tests/e2e/claude-session-chat.spec.ts`
- `tests/e2e/opencode-session-chat.spec.ts`
- `tests/e2e/opencode-session-switch.spec.ts`

### 2. Benchmarks
Located in:
- `tests/benchmarks/`

These focus on UI performance and memory-related scenarios.

### 3. Helper scripts
This folder also contains a small number of shell/Python helpers used for specific verification workflows.
Treat them as supplemental, not the main automated test surface.

## Running Tests

### All tests
```bash
npm test
```

### E2E tests
```bash
npm run test:e2e
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
- Claude Direct replay and process handling
- OpenCode Direct client/service/event handling
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
If you touched Pi SDK / Claude Direct / OpenCode Direct routing or replay logic, prefer:
- unit tests for the affected runtime module(s)
- relevant WebSocket tests
- relevant E2E runtime tests

## Notes

- Some runtime-specific tests may depend on optional tools being installed locally.
- OpenCode Direct tests are especially sensitive to `opencode` availability in fully live scenarios.
- Prefer the canonical app commands from the root `package.json` unless you are targeting one workspace deliberately.
