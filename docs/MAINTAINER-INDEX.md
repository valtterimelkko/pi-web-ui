# Maintainer Docs Index

Reading order for contributors, operators, and LLM coding agents working **on Pi Web UI itself**.

Many docs below intentionally contain concrete paths, socket locations, service names, and maintainer runbook commands because this repository doubles as a live operational manual.

If you are debugging anything runtime-related, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Given a session identifier, run `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` first; do not begin with a repository-wide grep. The locator resolves the registry/native identity and prints the relevant API, log, and session-file paths.

## Recent major doc-relevant changes
- **Internal API `1.10.0` session evidence layer** — `/sessions/:id/evidence` resolves aliases in one bounded read, combines canonical metadata/locators/diagnostics/receipt summary, and supports explicit expansions; WebSocket Pi correlation uses canonical registry ids with a safe fallback. See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), and [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- **Whole-codebase hardening** — request/body bounds, prompt-boundary coverage, WebSocket upgrade guards, path/worktree protections, private/atomic persistence, listener/timer cleanup, bounded worker output, and truthful validation/coverage gates were completed. The operator-facing consequences are summarised in [`RECENT-CHANGES.md`](./RECENT-CHANGES.md) and [`SHARP-EDGES.md`](./SHARP-EDGES.md); the evidence ledger is [`plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md`](./plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md).
- **Pi Codex compaction session-ID patch retired** — OpenAI fixed the Codex backend server-side (upstream #6477/#6555 closed without a pi code change); postinstall hook, patch scripts, extension auto-heal, and regression tests removed; both SDK installs restored to pristine. History: [`PI-CODEX-COMPACTION-SESSION-ID.md`](./PI-CODEX-COMPACTION-SESSION-ID.md)
- **Third live-validation option: browser-WebSocket path** — cookie auth + `/ws` without a browser, for extension slash commands, `notification` toasts, and browser-native messages; runbook + `scripts/ws-validate.mjs` in [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
- **Claude SDK `AskUserQuestion` support** — first-class browser dialog, cancel/timeout handling, and `extension_ui_cancel`. See [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md), [`PROTOCOL.md`](./PROTOCOL.md), and [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)
- **Antigravity inactivity stall watchdog + bounded retry** — configurable via `ANTIGRAVITY_STALL_TIMEOUT_MS` and `ANTIGRAVITY_MAX_ATTEMPTS`. See [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
- **Files tab Markdown editor** — shipped: source editor + GFM live preview for `.md`/`.mdx`/`.markdown`/`.txt`, explicit Save via `/api/files/write`, truncated files read-only. Plan (now delivered) at [`plans/FILES-TAB-MARKDOWN-EDITOR-PLAN.md`](./plans/FILES-TAB-MARKDOWN-EDITOR-PLAN.md)
- **Internal API contract history** — `1.5.0` added notifications, `1.6.x` added run receipts/idempotency, `1.7.0` added model-aware thinking levels, `1.8.0` hardened multi-client/notification ingress, `1.9.0` added runtime-health and operational diagnostics, and `1.10.0` added compact session evidence. [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) is the version authority.
- **Observability/introspection** — `GET /api/v1/diagnostics`, session-scoped diagnostics, event-type introspection, correlation filters, and a bounded operational snapshot are documented in [`OBSERVABILITY.md`](./OBSERVABILITY.md) and [`INTERNAL-API.md`](./INTERNAL-API.md)
- **Pi runtime OpenRouter model automation** — Pi can now surface a broader OpenRouter-backed model catalogue; see [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md)
- **Notification layer (Telegram on `agent_end`)** — one-way operator notifications when an agent yields control, across all 4 runtimes, with a durable outbox; see [`NOTIFICATIONS.md`](./NOTIFICATIONS.md)
- **Run receipts and execution instance identity** — durable Internal-API dispatch identity, session-scoped idempotency, restart recovery, and configured runtime-instance projection; see [`INTERNAL-API.md`](./INTERNAL-API.md) and [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md)
- **Fast delta summary:** [`RECENT-CHANGES.md`](./RECENT-CHANGES.md)

## 1. Agent quick start
- [`../AGENTS.md`](../AGENTS.md) — agent entry point; canonical source for the root guide
- [`../CLAUDE.md`](../CLAUDE.md) — Claude Code agent entry point; kept byte-identical to `AGENTS.md` via `npm run docs:sync-agent-guides`

## 2. First-stop debugging
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — fastest evidence ladder: locator → screen transcript/diagnostics → runtime-specific files/logs
- `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` — quickest session-to-registry/native-id/log/session-file locator; use the resolved internal id for session-scoped diagnostics

## 3. System structure
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — high-level architecture, runtime paths, responsibilities
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) — granular file-to-purpose index
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) — how native events from Pi, Claude, OpenCode, and Antigravity converge into one frontend stream
- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — logging (levels/namespaces/format), correlation IDs, diagnostics endpoint, error-code catalog, request logging, fatal-error handlers

## 4. WebSocket contract
- [`PROTOCOL.md`](./PROTOCOL.md) — message types, connection lifecycle, error codes

## 5. Runtime deep dives
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md) — Pi Coding Agent worker architecture
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) — which behaviours are core vs enhanced by companion Pi extensions / OpenCode plugins
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) — all three Claude backend modes (SDK, legacy direct, channel), env vars, logs, and failure modes
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) — operator reference for the provider profile system: field reference, examples (native Claude, GLM 5.2), secrets, safety invariants, validation runner
- [`CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md`](./CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md) — proposed safer design for routing richer native Claude hook events into the Web UI
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md) — OpenCode architecture, provider auth storage, credential-safe model routing, and the provider allowlist
- [`OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md) — analysis/proposal for keeping the OpenCode model list current (Kilo Gateway, OpenCode Zen) automatically
- [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md) — keeping the Pi runtime model list current with the OpenRouter gateway automatically (weekly refresh, no secrets stored)
- [`PI-CODEX-COMPACTION-SESSION-ID.md`](./PI-CODEX-COMPACTION-SESSION-ID.md) — RETIRED: the Codex compaction session-ID patch ecosystem (postinstall patch, auto-heal extension probe), why it existed, and how it was retired after OpenAI's server-side fix
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md) — Antigravity / `agy` architecture, logs, and failure modes

## 6. Internal API and orchestration
- [`INTERNAL-API.md`](./INTERNAL-API.md) — canonical local automation API reference (including transcript vs screen-view vs history read paths)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) — task-oriented guide for spawning, monitoring, and collecting child sessions across runtimes (including run receipts)
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — the three live-validation options (Internal API, Playwright E2E, browser-WebSocket path) with full runbooks; includes `scripts/ws-validate.mjs`
- [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md) — durable watch ledgers + headless `validate:long-horizon` runner for long-running validation; recorded firings survive restart, but reloaded watches must be re-registered to resume live observation

## 7. Integration & extension
- [`ADDING-A-RUNTIME.md`](./ADDING-A-RUNTIME.md) — checklist for adding a new runtime
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — known traps and brittle patterns

## 8. Operations
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — production runbook, reverse proxy, service management
- [`../SECURITY.md`](../SECURITY.md) — security model, threat mitigations, rules
- [`../API.md`](../API.md) — WebSocket / REST / local automation API surface index

## 9. Tests
- [`../tests/README.md`](../tests/README.md) — test layers, running commands

## 10. Public-facing context
When you are changing docs or product positioning, also read:
- [`../README.md`](../README.md)
- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`VISION.md`](./VISION.md)
- [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md)
