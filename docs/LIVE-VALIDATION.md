# Live Validation

> Live validation for Pi Web UI: the three supported methods, when to use each, and the full runbooks.

## The three live-validation options

The Internal API runner and browser-WebSocket driver use a **disposable
validation server** by default. Playwright E2E has a separately managed target
(`TEST_URL`, default `http://localhost:3457`); its `webServer` lifecycle is
intentionally disabled, so do not assume it is isolated or production-safe
without starting and documenting an appropriate server yourself. For the
Internal API/long-horizon runners, production requires explicit user permission
plus `--allow-production`; the manually targeted Playwright/WS paths need the
same explicit safety decision even where the test tool has no such flag. Choose
by what you need to observe:

| # | Method | What it exercises | Use it for | Runbook |
|---|--------|-------------------|------------|---------|
| 1 | **Internal API** (Unix socket + bearer token) | Backend runtime behaviour, normalized events, transcripts | Runtime dispatch, event normalization, replay, session lifecycle, orchestration surfaces | This document (below) |
| 2 | **Browser E2E via Playwright** | The full UI in a real browser | User-visible flows: login, session UI, chat rendering, model selector, cross-tab state | `tests/e2e/` + [`../tests/README.md`](../tests/README.md) |
| 3 | **Browser WebSocket path** (cookie auth + `/ws`, no browser) | The exact protocol the browser speaks, without a browser | Extension slash commands + `notification` toasts, browser-native messages like `compact`, any `shared/src/protocol-types.ts` message; also the fallback when Playwright auth is a blocker | [Browser-WebSocket validation](#option-3-browser-websocket-validation-cookie-auth-no-browser) below |

Two facts that decide between 1 and 3:

- Extension `ctx.ui.notify(...)` output goes **only** to the browser WebSocket (`{type:'notification'}`); it never appears on the Internal API `/events` stream or in `/history`. To see it, use option 3 (or 2).
- Typing `/compact` in the browser does **not** send a prompt — the frontend intercepts it and sends a dedicated `{type:'compact'}` WebSocket message. Sending the literal text `/compact` through the Internal API prompt endpoint reaches the LLM as plain text. Extension commands (e.g. `/autocompact75`) work on **both** paths because `AgentSession.prompt()` executes them server-side.

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
out a long horizon (minutes to hours) and preserve watch-ledger evidence when
the validator disconnects or the server restarts — driven by the durable watch
endpoints and the headless `validate:long-horizon` runner — read
[`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md). A server restart
reloads an existing watch as `detached`; preserve its ledger, then create a new
watch/runner (or explicitly reconcile it in a custom client) before expecting
new firings. The current runner does not auto-recover live observation.

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

Every no-argument launch creates a short private directory under the platform
temporary root (normally `/tmp/pi-web-ui-validation/run-*`), reserves distinct
available web/Claude/OpenCode ports, and removes that auto-created directory on
normal process exit. The startup banner prints the exact socket, token path,
ports, and a ready-to-copy validator command; use those printed paths rather
than assuming a stable default directory.

Concurrent no-argument launches are isolated automatically. When you provide
`--dir` explicitly, that directory is process-locked for the server lifetime;
a second owner fails safely. Explicit companion ports are validated as distinct
and available. Example with a caller-owned directory:

```bash
# Terminal A / background task
VALIDATION_DIR="$(mktemp -d /tmp/pi-validation-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  >"$VALIDATION_DIR/server.log" 2>&1 &

# Terminal B: export/replace VALIDATION_DIR with the same directory
PI_WEB_UI_WAIT_SOCKET="$VALIDATION_DIR/internal-api.sock" npm run internal-api:wait
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime pi --scenario smoke
```

The launcher canonicalises existing path ancestors and refuses a validation
directory that aliases the production state root. Explicit production socket,
token, or state paths still require `--allow-production`.

If the running service gets provider credentials from a systemd `EnvironmentFile`
(such as `.env.production`), a terminal-launched validation server does not inherit
that file automatically. Load it explicitly without copying or printing secret values:

```bash
npm run validate:server -- --env-file .env.production \
  --env-key GLM_CODING_PLAN_TOKEN --dir "$VALIDATION_DIR" --port 0
```

Disposable servers force their Pi session directory/watcher/cache, OpenCode
workspace, registry, sockets, tokens, and runtime metadata under the validation
directory. They also clear any ambient `INTERNAL_API_KEY`, so the printed isolated
token file is always authoritative. By design, the wrapper does **not** override
`PI_AGENT_DIR`: Pi auth/models/resources remain available from the normal agent
directory, and the derived `web-ui-prefs.json` path is therefore not isolated by
default. Validation mode disables boot-time session cleanup and real-session
registry rebuild, but browser tests that mutate preferences (archive/pin/rename)
must either launch with `PI_AGENT_DIR="$VALIDATION_DIR/pi-agent"` and a deliberately
provisioned disposable runtime setup, or avoid those mutations. Do not assume a
runtime-disposable server is a full preference/credential isolation boundary.
Antigravity is disabled in disposable mode because the `agy` CLI has no supported
conversation-data directory override and would otherwise write to the user's real
`~/.gemini` conversation store; validate Antigravity only through a separately
authorised workflow that explicitly accepts that limitation.

`--env-key` is a repeatable allowlist: only those named values are imported from
that file, so this option does not pull in its unrelated production secrets or
configuration.
Launching-shell values take precedence over imported values, and the validation wrapper
applies its isolation paths/ports afterwards. The equivalent script settings are
`PI_WEB_UI_VALIDATION_ENV_FILE=/absolute/path/to/env` and
`PI_WEB_UI_VALIDATION_ENV_KEYS=GLM_CODING_PLAN_TOKEN` (comma-separated for several
keys). This reuses only the requested credential for real provider calls; it does
**not** target, restart, or reconfigure the production Pi Web UI server.

List available scenarios without connecting to a server:

```bash
npm run validate:live -- --list
```

Run the current disposable-safe runtime set (Pi, Claude, and OpenCode) against all registered scenarios:

```bash
npm run validate:live -- --socket <sock> --token-path <token> --runtime all --scenario all
```

For the provider-free Command Code fixture, use a fresh disposable directory
and the explicit fixture flag. It is not included in `--runtime all`:

```bash
VALIDATION_DIR="$(mktemp -d /tmp/pi-web-ui-commandcode-validation-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  --command-code-fixture \
  >"$VALIDATION_DIR/server.log" 2>&1 &
VALIDATION_PID=$!
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime commandcode --scenario all
kill "$VALIDATION_PID" 2>/dev/null || true
wait "$VALIDATION_PID" 2>/dev/null || true
rm -rf "$VALIDATION_DIR"
```

The fixture is provider-free: every advertised model answers deterministically
without contacting a provider. `--command-code-browser-fixture` is a legacy
alias that additionally enables the cookie-authenticated UI path for browser
driving with the fixture CLI. To validate against the real installed CLI
(bills the plan; explicitly authorised runs only), start the disposable server
with `--command-code-real` instead and run the Command Code scenarios or drive
the real UI with `webapp-testing`.

`--runtime all` is intentionally not a synonym for all runtime families:
`live-validate.ts` currently expands it to `pi`, `claude`, and `opencode`.
Command Code is excluded and must use the explicit fixture workflow below.
Antigravity is disabled by the disposable server because `agy` has no supported
conversation-data directory override. Run an Antigravity scenario only with an
explicitly authorised, separately isolated-enough workflow and record that it
can touch the user's real `~/.gemini` state.

JSON output for agents/tools:

```bash
npm run validate:live -- --socket <sock> --token-path <token> --runtime claude --scenario all --json
```

Only when the user explicitly asks to validate against the running production Web UI:

```bash
npm run validate:live -- --allow-production --runtime claude --scenario smoke
```

## Retained experimental MCP adapter validation

The Internal API MCP adapter is retained but inactive; no MCP/tunnel service is
installed or enabled. Its 2026-08-12 experiment passed the two local layers
below plus an external disposable ChatGPT tunnel proof, then the processes,
plugin, local credentials, profiles, and disposable state were removed.
Re-running these commands is a new opt-in experiment, not routine validation.
The adapter is a separate stdio process and does not change the validation
server or Internal API contract:

```bash
# compiled process + official MCP SDK + fake owner-only Unix socket
npm run validate:mcp:wire
```

For the real-runtime proof, boot a disposable validation server and pass both
exact printed paths. The MCP validator requires them, refuses the canonical
production paths with no `--allow-production` escape hatch, refuses
Antigravity in disposable mode, and performs every discovery/create/dispatch/
receipt/transcript action through the MCP client. It directly deletes only the
created disposable session during cleanup; there is intentionally no delete
MCP tool:

```bash
VALIDATION_DIR="$(mktemp -d /tmp/pi-web-ui-mcp-validation-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  >"$VALIDATION_DIR/server.log" 2>&1 &
VALIDATION_PID=$!
npm run validate:mcp:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime pi
kill "$VALIDATION_PID" 2>/dev/null || true
wait "$VALIDATION_PID" 2>/dev/null || true
rm -rf "$VALIDATION_DIR"
```

The report must say that the disposable server leaves production service,
socket, registry and session state untouched while real provider credentials
and model resources may still be reused. It must not print a prompt,
transcript, token or credential. Full MCP architecture, environment variables,
Secure MCP Tunnel egress-only design, experiment shutdown evidence, and fresh
production/reactivation opt-in rules are in [`MCP-SERVER.md`](./MCP-SERVER.md).

## How it works

The runner talks to the Internal API socket you pass with `--socket` and authenticates with the token passed via `--token-path`.

If neither flag is provided, the runner refuses to proceed unless `--allow-production` is supplied. This prevents accidental validation against:

- socket: `~/.pi-web-ui/internal-api.sock`
- token: `~/.pi-web-ui/internal-api-token`

The runner queries runtime capabilities, creates an ephemeral session on the targeted server, streams normalized events with `verbosity=full`, runs assertions, and cleans the session up afterwards. Internal API calls use absolute wall-clock deadlines (not socket-inactivity timeouts), so heartbeat/SSE chunks cannot keep a stuck validation alive forever.

Each result includes bounded evidence: start/completion/duration, attempt
history, runtime/model/backend/execution identity where available, `runId`,
low-cardinality event counts, scrubbed failure metadata, and any cleanup
warnings. A failed assertion may be retried once, but cleanup warnings from all
attempts are retained. Long-horizon polling failures become explicit `failed`
verdicts and still run watch/session finalization.

For detached or delayed-output checks, do not treat a terminal receipt or a
single idle observation as final-artifact proof. Read the matching receipt and
bounded session evidence, then compare `transcript?scope=visible_full` with
`transcript?view=screen` after a configured stable-read/quiescence window.
Contract `1.19.0+` receipts expose payload-free `outputEvidence`: `text` means
normalized assistant text was observed; `no-text` and `unknown` require a
non-conclusive/indeterminate report unless lower-layer evidence explains the
absence. Preserve only a bounded redacted anomaly bundle before disposable
cleanup; never retain raw credentials or an entire session directory by default.

## Current scenarios

- `commandcode-fixture-smoke` — explicit provider-free Command Code fixture: exact model/effort, normalized stream, replay, and terminal usage evidence
- `smoke` — create a session and verify a minimal turn completes
- `run-receipt-idempotency` — verify `runId`, terminal receipt lookup, execution-instance attribution, and same-key deduplication
- `phase7-pi-shadow` — disposable Pi-only proof that an Internal API receipt persists the server-owned `phase7-pi-shadow/v1` classification, session affinity, and honest shared-service resource identity without changing routing
- `model-smoke` — create a session with an explicit `--model` and verify the selected model is reflected; requires `--model <provider/id>`
- `tool-visibility` — verify tool execution is surfaced in the full stream
- `session-info` — verify enriched internal-API session info is available
- `session-evidence` — verify compact evidence resolves by internal id and registry-path alias without prompt bodies, while separating retention/residency and exposing bounded run-liveness evidence
- `thinking-level` — verify capability-gated model/thinking-level control and the OpenCode config bridge
- `follow-up` — verify idle follow-up runs a real turn and reports `dispatchMode:"prompt"`
- `follow-up-strict` — verify strict idle follow-up returns `SESSION_NOT_STREAMING`
- `prompt-mode-busy` — verify running Claude rejects follow-up with `SESSION_BUSY` and creates no receipt
- `approval-wrong-id` — verify an unknown approval id returns 404 without closing the pending question
- `approval-by-toolcall-id` — verify `toolCallId` resolves the question and the assistant resumes
- `stalled-run-reaped` — verify an admitted silent Pi turn terminalises `TURN_STALLED`, records `liveness.watchdog.reason=idle` plus unknown watchdog-based cessation, and releases capacity; launch both server and validator with `INTERNAL_API_TURN_IDLE_TIMEOUT_MS=2000`
- `notify-on-agent-end` — opt in, run a real turn, and verify the disposable capture channel records the delivery without contacting Telegram
- `channel-heartbeat` — verify Claude channel-backed sessions emit `stream_activity`
- `claude-ask-user-question` — verify the Claude SDK browser question flow, structured answers, and resumed turn
- `claude-ask-user-question-cancel` — verify cancellation closes the question and the turn completes without an answer
- `claude-ask-user-question-timeout` — verify timeout/late-answer handling; boot the validation server with `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS=1..30000`
- `claude-ask-user-question-delayed-answer` — verify the disconnect grace does not close a question before a delayed answer arrives

## Validation evidence matrix

| Evidence / scenario | Disposable-safe scope | What it proves |
|---|---|---|
| `commandcode-fixture-smoke` | Explicit Command Code fixture only; not part of `--runtime all` | exact discovered model/effort, normalized streaming, replay, and terminal usage evidence |
| `smoke` | Pi, Claude, OpenCode; Antigravity only when explicitly authorised | session creation and a minimal completed turn |
| `run-receipt-idempotency` | Pi, Claude, OpenCode | durable `runId`, terminal receipt, execution identity, and same-key deduplication |
| `phase7-pi-shadow` | Pi disposable server only | shadow policy/profile/reason codes, session affinity, prompt-free receipt metadata, and explicit non-contained shared-service identity |
| `model-smoke` | capability/runtime dependent; explicit model required | create-time model selection and reported model identity |
| `tool-visibility` | capability-dependent; normally Pi/Claude/OpenCode | normalized tool events in the full stream |
| `session-info` | Pi, Claude, OpenCode; Antigravity when explicitly authorised | enriched runtime/session metadata |
| `session-evidence` | Pi, Claude, OpenCode disposable server; Antigravity only when explicitly authorised | alias resolution, bounded default evidence, separate retention/residency, run-liveness projection, and read-only evidence access |
| `thinking-level` | OpenCode config bridge; capability-gated | model-aware thinking-level control and provider config mapping |
| `follow-up` | capability-dependent; Antigravity can run in an authorised workflow | idle promotion, real response, and reported dispatch mode |
| `follow-up-strict` | Pi/Claude/OpenCode disposable server | strict active-turn requirement rejects idle delivery |
| `prompt-mode-busy` | Claude SDK backend only | busy rejection precedes receipt reservation |
| `approval-wrong-id` | Claude SDK backend only | false-success prevention and pending-state preservation |
| `approval-by-toolcall-id` | Claude SDK backend only | identifier alias resolution and resumed turn |
| `stalled-run-reaped` | Pi; short watchdog env required | idle watchdog evidence, non-overclaimed cessation, terminal state, and admission release |
| `notify-on-agent-end` | Pi, Claude, OpenCode disposable capture channel | origin-independent notification observation without Telegram |
| `channel-heartbeat` | Claude channel backend only | `stream_activity` liveness events |
| `claude-ask-user-question` | Claude SDK backend only | structured multi-question answer flow and resumed turn |
| `claude-ask-user-question-cancel` | Claude SDK backend only | cancellation/closed event and graceful continuation |
| `claude-ask-user-question-timeout` | Claude SDK backend only; short timeout must be configured | timeout closure, terminal turn, and late-answer rejection |
| `claude-ask-user-question-delayed-answer` | Claude SDK backend only | disconnect grace prevents premature dialog closure |

A skipped result is capability evidence, not a failure. A failed disposable
result should be investigated before any production validation is considered.

### Steering validation (`scripts/live-validate-steer.mjs`)

Mid-run steering is also a browser-WebSocket behaviour, so it has a dedicated
Option-3 driver (the Internal API `steer` mode covers Pi and Claude-SDK since
contract 1.29.0 but not Command Code):
[`../scripts/live-validate-steer.mjs`](../scripts/live-validate-steer.mjs).
Boot a disposable server (`--command-code-fixture --command-code-browser-fixture`
for the Command Code fixture path; a Claude SDK profile with
`--env-file`/`--env-key` for the real SDK backend, selecting it with
`--model profile:<id>`), then:

```bash
node scripts/live-validate-steer.mjs --url http://localhost:<port> \
  --runtime commandcode --cwd <validation-dir>/wswork
node scripts/live-validate-steer.mjs --url http://localhost:<port> \
  --runtime claude --cwd <validation-dir>/claudework --model profile:<id>
```

It proves, per runtime: a steer sent mid-run reaches the transcript as a user
message and redirects the agent (Command Code via interrupt + next-prompt
hand-off, with the aborted run's completion suppressed), and a follow-up sent
mid-run runs as its own turn strictly after the current run finishes. The
Command Code fixture recognises the `COMMAND-CODE-SLOW-RUN` marker to produce a
slow, interruptible turn.

## Claude profile validation runner

For validating Claude **provider profiles** (SDK backend, direct CLI backend, GLM/Z.ai provider routing, skills, concurrency), use the dedicated profile runner rather than `validate:live`:

```bash
# 1. Boot a throwaway validation server with profiles enabled
VAL_DIR=$(mktemp -d)
CLAUDE_PROFILES_ENABLED=true \
CLAUDE_SDK_ENABLED=true \
CLAUDE_PROFILES_PATH="$VAL_DIR/claude-profiles.json" \
npm run validate:server -- --env-file .env.production \
  --env-key GLM_CODING_PLAN_TOKEN --dir "$VAL_DIR" --port 0

# 2. Run profile scenarios
npm run validate:claude-profiles -- \
  --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --glm-profile "glm53-claude-sdk" \
  --native-profile "claude-sonnet-sdk" \
  --direct-profile "glm53-claude-cli-direct"
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
  --profiles claude-sonnet-sdk,glm53-claude-sdk
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

Safety properties:
- the log is opened eagerly with owner-only `0600` permissions and each JSONL record is flushed before the request is forwarded; evidence-write failure stops validation rather than silently proxying without evidence
- logged paths omit query strings; authorization/cookie headers are never allowlisted
- prompt/message/input/content fields remain omitted even with explicit extraction
- `--unsafe-log-redacted-body` is the only way to capture a bounded recursively redacted body, and it still omits content fields

Two practical cautions:
- use the proxy for **wire inspection**, not for throughput/latency measurement
- for native Claude subscription sessions, prefer proving model identity from the runtime transcript plus the absence of `ANTHROPIC_API_KEY` in the validation-server environment rather than MITM-ing subscription auth traffic

## Option 3: Browser-WebSocket validation (cookie auth, no browser)

Drive a session over the **same authenticated WebSocket path the browser uses** — cookie login via `POST /api/auth/login`, then `ws://…/ws` — without launching a browser. Live-validated 2026-07-10 (extension command notifications and Pi compaction across three Codex models).

Use this when:

- you need to observe things only the browser path carries: extension command `notification` toasts, `extension_status`, browser-native `compact`, or any other message in `shared/src/protocol-types.ts`;
- you are validating **extension slash commands** end-to-end in the Web UI;
- Playwright-based validation is blocked (auth/bcrypt friction, no display) and you still need browser-path evidence.

The repo ships a ready-made driver: [`../scripts/ws-validate.mjs`](../scripts/ws-validate.mjs). Follow the steps exactly; each pitfall listed below has actually happened.

### Step 1 — boot a disposable validation server with a known password

The browser path needs password login. The validation server inherits `.env`, which usually sets `NODE_ENV=production` — and in production the server **only accepts a bcrypt hash** in `AUTH_PASSWORD` (a plain-text value makes login fail with "Server configuration error").

```bash
cd /root/pi-web-ui
# bcrypt resolves from the workspace root — generate a production-valid hash.
HASH=$(node -e "console.log(require('bcrypt').hashSync('validation-pass', 10))")
[ -n "$HASH" ] || echo "hash generation failed — fix before booting"
AUTH_PASSWORD="$HASH" npm run validate:server -- --dir /tmp/pi-vc --port 3093 \
  --claude-ws-port 43210 --claude-hook-port 43211 --opencode-port 44197
```

Pitfalls:

- **Short `--dir` only.** The Internal API Unix socket lives inside it; paths beyond ~100 chars make clients fail with "Unix socket path too long".
- **Port conflicts.** If startup logs `EADDRINUSE`, another validation server holds the port. Find it with `ss -tlnp | grep <port>`; kill only processes whose command line shows `validation-server.ts` (someone else's may be legitimate — pick a different port instead).
- **Orphaned children.** Stopping the `npm run` wrapper can leave the underlying `node …validation-server.ts` alive and holding the port. Verify with `ss -tln | grep <port>` after teardown and kill the pid it reports.

### Step 2 — create a session (Internal API is easiest)

```bash
TOKEN=$(cat /tmp/pi-vc/internal-api-token)
curl -s --unix-socket /tmp/pi-vc/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST http://localhost/api/v1/sessions \
  -d '{"runtime":"pi","model":"openai-codex/gpt-5.6-terra","cwd":"/tmp/some-cwd"}'
# → note "sessionPath" in the response; the WS protocol addresses sessions by path
```

### Step 3 — drive the session over the WebSocket

```bash
# Extension slash command; succeeds on the first `notification` toast received
# after the command is sent (no LLM turn). Other extensions can also emit
# session-start notifications, so pin the assertion with --expect:
node scripts/ws-validate.mjs --session "<sessionPath>" --step command \
  --text "/autocompact75" --expect "SDK integrity"

# Ordinary LLM prompt; succeeds on agent_end:
node scripts/ws-validate.mjs --session "<sessionPath>" --step prompt --text "Reply with one word."

# Browser-native compaction (what the UI sends when you type /compact):
node scripts/ws-validate.mjs --session "<sessionPath>" --step compact

# auto-compact-75 resume chain: prompt a seeded-over-75% session with a
# tool-forcing task and require compaction to fire mid-run AND the agent to
# continue by itself afterwards (assistant message after compaction_end, then
# agent_end). Fails if the run completes without compaction. Seed the session
# past 75% of the model context window first (a cheap way: a flat-rate model
# with filler messages; calibrate real token counts with a small session and
# one tiny prompt before generating the big seed — the Web UI system prompt +
# tools add a large fixed overhead, ~29k tokens as of 2026-07).
node scripts/ws-validate.mjs --session "<sessionPath>" --step resume \
  --text 'Use the bash tool to run exactly: echo "CHECK-$((21*2))". Then report its exact output.' \
  --timeout 540000
```

For repeated recovery-path checks, avoid paying the 300k-token setup cost on
every iteration. In the same authenticated WebSocket connection, send
`{type:"prompt", message:"/autocompact75 validate-next 5"}` and then send the
tool-use prompt after the command has returned. Internal-API-created sessions
have no toast UI, so a custom sequence driver should not wait for a
`notification` acknowledgement; the subsequent `compaction_start` is the
proof that the one-shot arm was consumed.

The command is rejected unless `PI_WEB_UI_VALIDATION_MODE=true`, is consumed by
the next eligible compaction, and never changes the production 75% threshold.
The session must still contain enough compactable history (more than Pi's
`keepRecentTokens`) for a real summary. Use this fast path while iterating, then
retain one calibrated real-75% run as final evidence.

Each run prints a JSON verdict (`OK …` / `FAILED …` / `TIMEOUT`) plus the captured events — paste that JSON into the validation report as evidence.

Flags when the defaults don't match: `--base http://localhost:<port>`, `--password <plain password>`, `--origin <allowed origin>` (must appear in the server startup log line `Allowed origins: …`; the default is the production origin from `.env`), `--timeout <ms>`.

### What the script actually does (for writing your own variants)

1. `POST /api/auth/login` with `{password}` and an allowed `Origin` header → take `accessToken` from `Set-Cookie`.
2. Open `ws://<host>/ws` with that `Cookie` **and the same `Origin`** header (origin is enforced at upgrade).
3. Wait for `{type:'authenticated'}`.
4. Send `{type:'switch_session', sessionPath}` — prompts are routed by the client's *current* session, so this must come first.
5. Send `{type:'prompt', sessionId: sessionPath, message}` (or `{type:'compact', …}`), then read `notification` / `session_event` / `compaction_result` messages.

### Teardown

Kill the validation server (and verify the port is really free — see orphan pitfall), then `rm -rf` the `--dir`. Disposable validation redirects Pi session storage and the session watcher to `<dir>/pi-sessions`; Pi's `PI_AGENT_DIR` remains the real agent directory for auth/models/resources, so do not copy or alter that directory and record any provider-side effects separately.

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

## Phase 6 worker-cgroup conformance

The frozen `worker-cgroup-conformance/v1` boundary test is a specialised, provider-free disposable validation:

```bash
npm run validate:phase6-worker-cgroup
```

It creates a fresh mode-0700 evidence directory, one nonce-owned transient controller/slice and only nonce-matched worker units. It runs the plain baseline, exact-cgroup candidate, adversarial lifecycle/resource matrix and restart recovery, then verifies collection and removes temporary receipt/session directories after writing bounded archives. It never targets the production socket/service or tmux scopes. Missing systemd/cgroup-v2 capability is a failure, not a simulated pass.

See [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md) and the frozen Phase 6 contract in [`plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`](./plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md). The frozen contract remains valid; the plan's **Phases 8–9 are paused as of 2026-08-20**, so no concurrency ramp or soak against this fixture is current work.

## Related docs

- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`../tests/README.md`](../tests/README.md)
