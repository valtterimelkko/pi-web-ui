# Live Validation

> Browserless runtime validation for Pi Web UI using the Internal API.

## Why this exists

Live validation is **one consumer** of the Internal API, not the reason the API
exists.

The Internal API is a broader local-only surface for:
- local automation
- agent-to-agent orchestration
- browserless runtime validation

This document is only about the third use case.

Unit tests and E2E tests are necessary, but they do not answer one important
question quickly enough for agent-led work:

> "Can this runtime actually do the thing on the live server right now?"

Live validation is the low-barrier answer.

It uses the **Internal API** over the local Unix socket instead of browser auth,
WebSocket cookie login, or manual UI clicking. That makes it suitable for
future agents, automation, and local debugging while preserving the main app's
security model.

This document covers **single-turn** validation. For validation that must wait
out a long horizon (minutes to hours) and survive the validator disconnecting or
the server restarting — driven by the durable watch endpoints and the headless
`validate:long-horizon` runner — read [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md).

If you are building agentic orchestration rather than test scenarios, read:
- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)

## Safety contract: never validate on production by default

Live validation must not touch the user's running production Web UI, active browser sessions, or real session registry unless the user explicitly asks for that exact thing.

Default rule for agents and scripts:

- **DO** boot a disposable validation server with `npm run validate:server`.
- **DO** pass that server's `--socket` and `--token-path` to the validator.
- **DO NOT** call the default `~/.pi-web-ui/internal-api.sock` from validation code.
- **DO NOT** stop, restart, redeploy, or reconfigure the production `pi-web-ui.service` as part of validation unless the user explicitly requested production service control.
- If production validation is genuinely intended, the CLI requires `--allow-production` as an explicit acknowledgement.

This guardrail exists because validation agents can run with broad tool permissions. A validator must be able to prove runtime behaviour without disturbing the UI the user is actively using.

## Canonical entrypoint

Start an isolated validation server in one terminal/background task:

```bash
npm run validate:server
```

It prints a socket, token path, and isolated runtime companion ports. Point `validate:live` at those paths:

```bash
npm run validate:live -- \
  --socket ~/.pi-web-ui/validation/internal-api.sock \
  --token-path ~/.pi-web-ui/validation/internal-api-token \
  --runtime claude --scenario smoke
```

For a concurrent or throwaway run, prefer a unique directory. If you run multiple validation servers concurrently, also pass unique `--claude-ws-port`, `--claude-hook-port`, and `--opencode-port` values:

```bash
VALIDATION_DIR=~/.pi-web-ui/validation/$(date +%s)
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime antigravity --scenario smoke
```

List available scenarios without connecting to a server:

```bash
npm run validate:live -- --list
```

Run against every available runtime on the disposable server:

```bash
npm run validate:live -- --socket <sock> --token-path <token> --runtime all --scenario all
```

JSON output for agents/tools:

```bash
npm run validate:live -- --socket <sock> --token-path <token> --runtime claude --scenario all --json
```

Only when the user explicitly asks to validate against the running production Web UI:

```bash
npm run validate:live -- --allow-production --runtime claude --scenario smoke
```

## How it works

The runner talks to the Internal API socket you pass with `--socket` and authenticates with the token passed via `--token-path`.

If neither flag is provided, the runner refuses to proceed unless `--allow-production` is supplied. This prevents accidental validation against:

- socket: `~/.pi-web-ui/internal-api.sock`
- token: `~/.pi-web-ui/internal-api-token`

The runner queries runtime capabilities, creates an ephemeral session on the targeted server, streams normalized events with `verbosity=full`, runs assertions, and cleans the session up afterwards.

## Current scenarios

- `smoke` — create a session and verify a minimal turn completes
- `tool-visibility` — verify tool execution is surfaced in the full stream
- `session-info` — verify enriched internal-API session info is available
- `follow-up` — verify the runtime accepts a follow-up turn when supported
- `channel-heartbeat` — verify Claude channel-backed sessions emit `stream_activity`

## Claude profile validation runner

For validating Claude **provider profiles** (SDK backend, direct CLI backend, GLM/Z.ai provider routing, skills, concurrency), use the dedicated profile runner rather than `validate:live`:

```bash
# 1. Boot a throwaway validation server with profiles enabled
VAL_DIR=$(mktemp -d)
CLAUDE_PROFILES_ENABLED=true \
CLAUDE_SDK_ENABLED=true \
CLAUDE_PROFILES_PATH="$VAL_DIR/claude-profiles.json" \
GLM_CODING_PLAN_TOKEN="<your-token>" \
npm run validate:server -- --dir "$VAL_DIR" --port 0

# 2. Run profile scenarios
npm run validate:claude-profiles -- \
  --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --glm-profile "glm52-claude-sdk" \
  --native-profile "claude-sonnet-sdk" \
  --direct-profile "glm52-claude-cli-direct"
```

Flags:
- `--glm-profile <id>` — profile id to use for GLM/provider-token scenarios
- `--native-profile <id>` — profile id to use for native subscription SDK scenarios
- `--direct-profile <id>` — profile id to use for direct CLI scenarios
- `--only <scenario1,scenario2>` — run a subset of scenarios by name
- `--list` — print available scenario names and exit
- `--allow-production` — allow the runner to target a production server socket

What it validates:
- `sdk-model-identity` — SDK native Claude returns expected model identity
- `glm-model-identity` — SDK GLM profile returns expected model identity, `apiKeySource=none`
- `cli-direct-model-identity` — direct CLI GLM profile returns expected model identity
- `tool-visibility` — tool execution events are surfaced (`tool_execution_start` / `tool_execution_end`)
- `skills` — skills are loaded and usable by the GLM profile
- `follow-up` — profile binding persists across a follow-up turn

For concurrency testing (simultaneous sessions, zero cross-contamination):

```bash
npx tsx scripts/concurrency-test.ts \
  --socket <sock> --token-path <token> \
  --profiles claude-sonnet-sdk,glm52-claude-sdk
```

See [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) for profile setup and the full field reference.

## Wire-level validation with the logging proxy

When you need proof of what a runtime actually sent to the upstream provider — the routed endpoint, concrete model id, reasoning-effort field, or 1M-context beta/header behaviour — do not rely only on the transcript. Use the logging proxy:

```bash
npm run validate:proxy -- \
  --upstream https://api.z.ai/api/anthropic \
  --port 8799 \
  --log /tmp/validation-requests.jsonl \
  --extract model,output_config.effort,thinking.type \
  --header-allowlist anthropic-beta
```

Then point the disposable validation server's runtime configuration at that proxy:
- **Claude** — set the chosen profile's `baseUrl` to `http://127.0.0.1:8799`
- **OpenCode** — point the provider `baseURL` at the proxy before booting the validation server
- **Pi SDK** — point the provider `baseUrl` at the proxy before booting the validation server

What this is for:
- proving GLM vs native Claude routing
- proving the actual model id used on the wire
- proving reasoning effort changed when you changed Thinking Level
- proving 1M-context beta/header behaviour for provider-backed Claude profiles

Two practical cautions:
- use the proxy for **wire inspection**, not for throughput/latency measurement
- for native Claude subscription sessions, prefer proving model identity from the runtime transcript plus the absence of `ANTHROPIC_API_KEY` in the validation-server environment rather than MITM-ing subscription auth traffic

## Capability-driven behaviour

The runner reads `GET /api/v1/capabilities` first.

That means it can:

- skip unsupported scenarios cleanly
- adapt to Claude `direct` vs `channel` backend mode
- avoid false failures on runtimes that do not support a feature

Examples:

- `channel-heartbeat` is skipped when Claude is in direct mode
- `follow-up` is skipped only if the runtime reports it unsupported
- Antigravity runs `smoke`, `follow-up`, and `session-info`, but should skip tool-visibility/heartbeat-style scenarios because it does not report those capabilities
- replay/history assertions should only run when `supportsReplayHistory=true`

## When to use it

Use live validation on a disposable validation server when you change:

- runtime dispatch logic
- event normalization or replay
- Claude channel-backed behaviour
- OpenCode streaming/permissions
- Antigravity prompt/replay/model-listing behaviour
- Internal API behaviour used by local tools or agents

Prefer it when you want a **real-runtime confirmation** without opening or disturbing the production web UI.

Use it alongside orchestrator development when you need confidence that the
runtime itself still behaves correctly, but do not confuse live validation with
an orchestration guide or a general-purpose control plane.

## When not to use it

Do **not** use live validation against the production server just because it is convenient. Use `--allow-production` only after an explicit user instruction such as "test this against my running Web UI".

Do **not** stop, restart, or redeploy `pi-web-ui.service` for validation unless the user has explicitly asked for production service control.

Do **not** treat live validation as a replacement for:

- server unit/integration tests
- frontend E2E tests
- protocol regression tests

Use it alongside those layers.

## Adding a new scenario

Add code under:

- `server/src/live-validation/scenarios.ts`

Use the Internal API client from:

- `server/src/live-validation/internal-api-client.ts`

Respect the validation target guard from:

- `server/src/live-validation/validation-safety.ts`

Keep scenarios:

- capability-aware
- deterministic where possible
- small and readable
- cleanup-safe (delete their sessions)

## Related docs

- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`../tests/README.md`](../tests/README.md)
