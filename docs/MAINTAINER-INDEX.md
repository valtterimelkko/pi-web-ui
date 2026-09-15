# Maintainer Docs Index

Reading order for contributors, operators, and LLM coding agents working **on Pi Web UI itself**.

Many docs below intentionally contain concrete paths, socket locations, service names, and maintainer runbook commands because this repository doubles as a live operational manual.

If you are debugging anything runtime-related, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Given a session identifier, run `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` first; do not begin with a repository-wide grep. The locator resolves the registry/native identity and prints the relevant API, log, and session-file paths.

## Recent major doc-relevant changes

Capped at ~10 items; older entries drop off (the rolling prose delta lives in [`RECENT-CHANGES.md`](./RECENT-CHANGES.md)).

- **Contract version history** — [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) is the version authority; its changelog is the canonical per-version record. Per docs governance this index keeps no secondary version summary — for a rolling prose delta use [`RECENT-CHANGES.md`](./RECENT-CHANGES.md).
- **Voice Mode (`2026-09-12…14`)** — the Drive Mode two-lane programme shipped end to end: server-side talker harness with a mechanical confirm-gated relay, transport binding over the browser WebSocket, client speech arbiter (anti-duet ladder), receipt ack, stop-talker, verbatim/summary/headlines reading levels, mobile socket durability, and voice observability. Canonical feature doc: [`VOICE-MODE.md`](./VOICE-MODE.md); observability records in [`OBSERVABILITY.md`](./OBSERVABILITY.md) §Voice Mode.
- **Lint ratchet headroom restored (`2026-09-14`)** — test/script files exempted from `no-explicit-any` / `no-non-null-assertion`; actual warnings fell 1,700 → 306 and the whole-tree ceiling was re-baselined to 326 so the gate stays alive. Policy: [`../tests/README.md`](../tests/README.md) §Lint ratchet policy.
- **Secrets migrated out of the repository (`2026-09-13`)** — every live secret now lives in `/root/.pi-web-ui/secrets.env` (mode 600, loaded by a systemd drop-in after `.env.production`); the dev env moved to `/root/.pi-web-ui/env.dev`; `.env` is gone and no longer load-bearing; `.env.production` holds zero secret values. Layout + rotation caveat: [`../DEPLOYMENT.md`](../DEPLOYMENT.md) §Secrets layout and [`../SECURITY.md`](../SECURITY.md) §Secrets hygiene.
- **Whole-codebase hardening** — request/body bounds, prompt-boundary coverage, WebSocket upgrade guards, path/worktree protections, private/atomic persistence, listener/timer cleanup, bounded worker output, and truthful validation/coverage gates were completed. The operator-facing consequences are summarised in [`RECENT-CHANGES.md`](./RECENT-CHANGES.md) and [`SHARP-EDGES.md`](./SHARP-EDGES.md); the evidence ledger is [`plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md`](./plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md).
- **Third live-validation option: browser-WebSocket path** — cookie auth + `/ws` without a browser, for extension slash commands, `notification` toasts, and browser-native messages; runbook + `scripts/ws-validate.mjs` in [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
- **Mid-run steering on Claude + Command Code** — steer/follow-up now work on the Claude SDK and Command Code paths over the existing WebSocket shapes; per-runtime semantics (Claude: next tool boundary; CMD: interrupt + redirect), verified wire research in [`STEERING-RUNTIME-RESEARCH.md`](./STEERING-RUNTIME-RESEARCH.md), validation runbook in [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) §Steering
- **Claude SDK `AskUserQuestion` support** — first-class browser dialog, cancel/timeout handling, and `extension_ui_cancel`. See [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md), [`PROTOCOL.md`](./PROTOCOL.md), and [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)
- **Antigravity stream-json integration** — persistent per-session agy process (streaming, tool events, real usage, native follow-up queueing, sibling-slug thinking levels); stall watchdog configurable via `ANTIGRAVITY_STALL_TIMEOUT_MS` and `ANTIGRAVITY_MAX_ATTEMPTS`. See [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
- **Observability/introspection** — `GET /api/v1/diagnostics`, session-scoped diagnostics, event-type introspection, correlation filters, and a bounded operational snapshot are documented in [`OBSERVABILITY.md`](./OBSERVABILITY.md) and [`INTERNAL-API.md`](./INTERNAL-API.md)
- **Pi runtime OpenRouter model automation** — Pi can now surface a broader OpenRouter-backed model catalogue; see [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md)
- **Run receipts and execution instance identity** — durable Internal-API dispatch identity, session-scoped idempotency, restart recovery, and configured runtime-instance projection; see [`INTERNAL-API.md`](./INTERNAL-API.md) and [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md)
- **Audio regression lab (`2026-09-14`)** — a reusable lab that measures the audio a real Chrome actually renders for the speech features: private Xvfb display, the REAL product player and arbiter, a private PulseAudio null sink and an independent `parec` monitor, with a deterministic adversarial oracle, immutable hash-verified run records and offline re-verification. Canonical doc: [`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md). Referenced from [`VOICE-MODE.md`](./VOICE-MODE.md) and [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md).
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
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) — how native events from Pi, Claude, OpenCode, Antigravity, and Command Code converge into one frontend stream
- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — logging (levels/namespaces/format), correlation IDs, diagnostics endpoint, error-code catalog, request logging, fatal-error handlers
- [`SESSION-METADATA.md`](./SESSION-METADATA.md) — the unified v2 model for per-session archived/pinned/display-name metadata and its sync channel
- [`VOICE-MODE.md`](./VOICE-MODE.md) — **Voice Mode**, the shipped two-lane voice harness: talker + confirm-gated relay, speech policy, reading levels, mobile socket durability, observability
- [`DRIVE-MODE.md`](./DRIVE-MODE.md) — Drive Mode, the distraction-reduced frontend overlay; for the voice/talker surface it hosts, read [`VOICE-MODE.md`](./VOICE-MODE.md)

## 4. WebSocket contract
- [`PROTOCOL.md`](./PROTOCOL.md) — message types, connection lifecycle, error codes

## 5. Runtime deep dives
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md) — Pi Coding Agent worker architecture
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) — which behaviours are core vs enhanced by companion Pi extensions / OpenCode plugins
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) — all three Claude backend modes (SDK, legacy direct, channel), env vars, logs, and failure modes
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) — operator reference for the provider profile system: field reference, examples (native Claude, GLM 5.3), secrets, safety invariants, validation runner
- [`CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md`](./CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md) — proposed safer design for routing richer native Claude hook events into the Web UI
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md) — OpenCode architecture, provider auth storage, credential-safe model routing, and the provider allowlist
- [`OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md) — analysis/proposal for keeping the OpenCode model list current (Kilo Gateway, OpenCode Zen) automatically
- [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md) — keeping the Pi runtime model list current with the OpenRouter gateway automatically (weekly refresh, no secrets stored)
- [`archive/PI-CODEX-COMPACTION-SESSION-ID.md`](./archive/PI-CODEX-COMPACTION-SESSION-ID.md) — RETIRED (tombstone): the Codex compaction session-ID patch ecosystem, retired after OpenAI's server-side fix; history in the archive
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md) — Antigravity / `agy` architecture, logs, and failure modes
- [`COMMAND-CODE-INTEGRATION.md`](./COMMAND-CODE-INTEGRATION.md) — Command Code (`cmd`) as the fifth runtime family: single env gate, model+effort catalogue and weekly refresh, session/event storage, and fixture-based validation
- [`STEERING-RUNTIME-RESEARCH.md`](./STEERING-RUNTIME-RESEARCH.md) — verified wire-level steering research: Claude Agent SDK streaming-input `priority` semantics (now/next/later/omitted-drop) and Command Code print-mode stdin limits, with probe evidence and source links
- [`archive/KIMI-CODE-RUNTIME-INTEGRATION-DESIGN.md`](./archive/KIMI-CODE-RUNTIME-INTEGRATION-DESIGN.md) — RETIRED (tombstone): proposed Kimi Code sixth-runtime design; the Kimi runtime was retired 2026-09-09 before implementation
- [`HEADROOM-TYPE-CONTEXT-LAYER.md`](./HEADROOM-TYPE-CONTEXT-LAYER.md) — design note on borrowing Headroom-style context compression: per-runtime feasibility, Phase 1 pre-conditions, and risks; researched, not yet implemented

## 6. Internal API and orchestration
- [`INTERNAL-API.md`](./INTERNAL-API.md) — canonical local automation API reference (including transcript vs screen-view vs history read paths)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) — task-oriented guide for spawning, monitoring, and collecting child sessions across runtimes (including run receipts)
- [`ORCHESTRATED-RUN-LIVENESS-AND-RECOVERY.md`](./ORCHESTRATED-RUN-LIVENESS-AND-RECOVERY.md) — shipped `1.14.0` liveness/recovery contract, remaining intent, provenance, and responsibility boundaries
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — the three live-validation options (Internal API, Playwright E2E, browser-WebSocket path) with full runbooks; includes `scripts/ws-validate.mjs`
- [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md) — durable watch ledgers + headless `validate:long-horizon` runner for long-running validation; recorded firings survive restart and reloaded `active` watches are rehydrated to keep observing (only unresolvable conditions demote to `detached`)
- [`MCP-SERVER.md`](./MCP-SERVER.md) — retained inactive seven-tool MCP experiment: validation evidence, completed shutdown, and fresh-authorisation reactivation boundary

## 7. Integration & extension
- [`ADDING-A-RUNTIME.md`](./ADDING-A-RUNTIME.md) — checklist for adding a new runtime
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — known traps and brittle patterns

## 8. Operations
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — production runbook, reverse proxy, service management
- [`../SECURITY.md`](../SECURITY.md) — security model, threat mitigations, rules
- [`../API.md`](../API.md) — WebSocket / REST / local automation API surface index

## 9. Tests
- [`../tests/README.md`](../tests/README.md) — test layers, running commands, and the lint ratchet policy (ceiling semantics, exemptions, re-baseline rules)

## 10. Public-facing context
When you are changing docs or product positioning, also read:
- [`../README.md`](../README.md)
- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`VISION.md`](./VISION.md)
- [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md)
