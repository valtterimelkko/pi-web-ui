# Command Code Fifth Browser Runtime — Execution Plan

> **Historical status:** superseded for current product work by [`COMMAND-CODE-FULL-CATALOGUE-MINIMAL-SOLUTION-PLAN.md`](./COMMAND-CODE-FULL-CATALOGUE-MINIMAL-SOLUTION-PLAN.md), which records the operator-authorised GOAT-entitlement, full Internal API cohort, and provider-capable browser egress decisions. Preserve this document only as implementation history; do not use its pair-only or mandatory no-network boundaries as current authority.
>
> Status: implementation complete; security hardening and release review in progress
>
> Goal: promote the existing feature-gated Command Code Internal API adapter into a secure fifth Pi Web UI runtime with truthful model/effort capability discovery, browser lifecycle/replay/streaming, shared session discoverability, notifications, and documented validation.

## Guardrails

- Preserve existing uncommitted MCP work; do not broaden the MCP seven-tool contract to Command Code in this execution.
- Keep Command Code disabled by default and separately feature-gated for browser use.
- Keep Agent OS shadow-role attestations and their narrow policy unchanged.
- Browser requests never select executable paths, argv, environment, auth paths, native ids, permission profiles, or raw `--yolo` flags.
- Use a server-owned browser permission profile, a non-empty exact model allowlist, canonical non-symlink workspace roots, pinned directory handles, and a Bubblewrap network namespace with `--unshare-net`. If the CLI cannot provide a sufficiently bounded writable browser profile, fail closed rather than weakening the boundary.
- Native effort remains distinct from generic `thinkingLevel`; expose only freshly discovered per-model effort values.
- Automatic effort means omit `--effort`; never invent a default from the first supported value.
- Keep Command Code out of disposable `--runtime all` and Drive Mode until explicitly proven safe.
- Use the private normalized journal as the replay source; never expose credentials, native transcript paths, stderr, or role attestations to the browser.

## Phase 0 — Baseline and plan

- Audit current dirty work, existing Command Code tests, browser runtime unions, service composition, registry, transfer, notifications, docs, and self-notification path.
- Preserve or separately checkpoint pre-existing MCP changes.
- Run focused baseline tests and record failures before changes.

## Phase 1 — Runtime contract and dynamic model/effort catalogue (TDD)

Tests first:

- current CLI version compatibility and discovery freshness;
- exact model parsing from current `cmd --list-models`;
- adjustable and non-adjustable effort discovery;
- no invented default effort;
- stale/ambiguous/model/effort drift fails closed;
- browser route returns only discovered, policy-approved models.

Implementation:

- replace the two-model compile-time catalogue with exact discovered model IDs plus a server-owned, non-empty browser policy allowlist;
- support the installed/current Command Code protocol version through a documented compatibility policy;
- retain a narrow Agent OS shadow allowlist separately;
- expose browser model metadata (`effortLevels`, `supportsEffort`, `defaultEffort` only when native evidence exists, freshness/status);
- add browser feature configuration and server-owned browser permission profile.

## Phase 2 — Shared service, registry, and locator parity (TDD)

- Add `commandcode` to shared/browser runtime types and registry metadata.
- Make one Command Code service instance available to both WebSocket and Internal API paths.
- Keep browser-contained records behind browser-only service lookups; Internal API routes are shadow-only.
- Add safe public registry projection and idempotent private-store reconciliation.
- Add native-ID lookup and Command Code locators to `debug:where`/evidence.
- Preserve private journals and native-home cleanup boundaries.

## Phase 3 — Live streaming, observers, and replay (TDD)

- Add incremental normalized event callback to the process runner/parser.
- Journal before fan-out; add Command Code subscribers and API observers.
- Guarantee one `agent_start` and one terminal `agent_end` for success, failure, malformed output, timeout, abort, shutdown, and restart.
- Add multi-viewer ordering, reconnect replay, and observer lifecycle tests.

## Phase 4 — WebSocket lifecycle (TDD)

- Add create/list/switch/restore/subscribe/unsubscribe/status/info/prompt/follow-up/abort/pin routing.
- Add separate native-effort control; do not route it through `set_thinking_level`.
- Keep model switching disabled until native next-turn switching is separately proven.
- Preserve auth, CSRF, origin, rate limit, path, and prompt-injection protections.

## Phase 5 — Frontend (TDD + localhost browser validation)

- Add runtime state, availability, model metadata, session creation, switching, replay, streaming, status, badges, settings and effort selector.
- Render `Automatic` plus only selected-model advertised effort values; render no effort selector for non-adjustable models.
- Keep raw permission controls out of the UI.
- Add browser tests and `webapp-testing` localhost checks.

## Phase 6 — Transfer and notifications (TDD)

- Add normalized-journal visible transcript source/target adapters only with approved browser policy.
- Pin the discovered executable, Bubblewrap launcher, and browser auth source by file descriptor/inode before launch; reject identity drift.
- Add Command Code to notification observer/type/identity paths and test restart/duplicate/opt-out behaviour.
- Keep Drive Mode and MCP Command Code excluded unless all safety/contract gates pass.

## Phase 7 — Documentation and validation

Update architecture, codebase map, event pipeline, protocol, runtime overview/README, troubleshooting, deployment/env, observability, Internal API and live-validation docs.

Run:

```bash
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm run build
npm test
```

Run focused and disposable validation for model discovery, create, prompt, live stream, follow-up/resume, abort, timeout, restart/replay, delete, registry/native-ID lookup, transfer, notifications, and negative controls. Do not target production or add Command Code to disposable `all`.

Browser validation is an authenticated WebSocket-only path; shadow fixture validation is Internal API-only. The browser fixture proves private-home write plus read-only workspace and uses a disposable auth source.

## Phase 8 — Review, commit, push

- Review all diffs and pre-existing MCP changes separately.
- Run `git diff --check`, secret/session-artifact scans, status/stat checks.
- Commit logically separated changes where possible.
- Push only after all gates pass; record commit hashes and validation evidence.
- Send one final Telegram `done` notification with concise test/build/live results.

## Stop conditions

Stop and notify the operator if browser writable permission cannot be bounded, native resume/terminality is ambiguous, model/effort discovery is drifted or unauthenticated, service ownership cannot be unified safely, or required push permissions/branch policy is unavailable.
