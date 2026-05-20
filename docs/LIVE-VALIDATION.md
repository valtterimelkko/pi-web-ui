# Live Validation

> Browserless runtime validation for Pi Web UI using the Internal API.

## Why this exists

Unit tests and E2E tests are necessary, but they do not answer one important
question quickly enough for agent-led work:

> "Can this runtime actually do the thing on the live server right now?"

Live validation is the low-barrier answer.

It uses the **Internal API** over the local Unix socket instead of browser auth,
WebSocket cookie login, or manual UI clicking. That makes it suitable for
future agents, automation, and local debugging while preserving the main app's
security model.

## Canonical entrypoint

```bash
npm run validate:live -- --runtime claude --scenario smoke
```

List available scenarios:

```bash
npm run validate:live -- --list
```

Run against every available runtime:

```bash
npm run validate:live -- --runtime all --scenario all
```

JSON output for agents/tools:

```bash
npm run validate:live -- --runtime claude --scenario all --json
```

## How it works

The runner talks to:

- socket: `~/.pi-web-ui/internal-api.sock`
- token: `~/.pi-web-ui/internal-api-token`

The runner automatically reads the token file, queries runtime capabilities,
creates an ephemeral session, streams normalized events with `verbosity=full`,
runs assertions, and cleans the session up afterwards.

## Current scenarios

- `smoke` — create a session and verify a minimal turn completes
- `tool-visibility` — verify tool execution is surfaced in the full stream
- `session-info` — verify enriched internal-API session info is available
- `follow-up` — verify the runtime accepts a follow-up turn when supported
- `channel-heartbeat` — verify Claude channel-backed sessions emit `stream_activity`

## Capability-driven behaviour

The runner reads `GET /api/v1/capabilities` first.

That means it can:

- skip unsupported scenarios cleanly
- adapt to Claude `direct` vs `channel` backend mode
- avoid false failures on runtimes that do not support a feature

Examples:

- `channel-heartbeat` is skipped when Claude is in direct mode
- `follow-up` is skipped only if the runtime reports it unsupported
- replay/history assertions should only run when `supportsReplayHistory=true`

## When to use it

Use live validation when you change:

- runtime dispatch logic
- event normalization or replay
- Claude channel-backed behaviour
- OpenCode Direct streaming/permissions
- Internal API behaviour used by local tools or agents

Prefer it when you want a **real-runtime confirmation** without opening the web UI.

## When not to use it

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

Keep scenarios:

- capability-aware
- deterministic where possible
- small and readable
- cleanup-safe (delete their sessions)

## Related docs

- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`../tests/README.md`](../tests/README.md)
