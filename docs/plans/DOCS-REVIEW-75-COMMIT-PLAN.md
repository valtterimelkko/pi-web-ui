# Documentation review plan: last 75 commits

**Status:** complete (2026-07-18)
**Scope:** `bb78c3a3^..HEAD` (75 commits ending at `2552668`)
**Audience split:** public/adopter documentation and maintainer/agent/operator documentation

## Completion evidence

- Re-read the source contracts and edited entry points after the first pass;
  corrected a false Playwright-disposable claim, a stale `/api/stt` endpoint,
  run-receipt/session-id wording, and several archived-plan status/safety traps.
- `npm run docs:sync-agent-guides`, `npm run docs:check-agent-guides`, and a
  byte comparison confirm `AGENTS.md` and `CLAUDE.md` remain identical.
- Repository-relative Markdown links and corrected GitHub-style anchors: **0 errors** across 64 Markdown files; `git diff --check`: clean.
- Source/documentation claim assertions: **34/34**; stale-claim checks passed.
- `npm run lint`: 0 errors (1,143 existing warnings); `npm run typecheck`:
  passed; `npm run build`: passed; `npm test`: server 2,564 + client 771
  tests passed; `node --test tests/unit/debug-where.test.mjs`: 5 passed.
- Safe disposable live validation passed for Pi `smoke` and Pi
  `notify-on-agent-end` with isolated socket/token/state directories and the
  in-process notification capture channel; Antigravity was not targeted.
- `AGENTS.md`/`CLAUDE.md` were re-synchronised and byte-identity checked after
  the final edits. No production service was stopped, restarted, or targeted by
  this review.

The working-tree documentation diff is intentionally left for maintainer review;
this plan records completion evidence but does not stage or commit the changes.

## Objective

Make the repository docs an accurate, low-friction map of the current Pi Web UI, with special attention to the agent workflow of receiving a session identifier and needing evidence quickly. Reconcile the docs with the current source rather than treating older docs or commit messages as authoritative.

## Audit findings

The first-pass audit found four classes of drift:

1. **Fast diagnosis is documented but not forceful enough.** The locator command exists (`npm run debug:where -- <id>`), but the first-stop docs do not clearly say to use it before filesystem-wide grep, do not explain the canonical-vs-native ID distinction, and do not give a compact evidence ladder using `view=screen`, diagnostics, run receipts, and runtime-owned files.
2. **The Internal API is at contract `1.9.0`, while several indexes still say `1.5.0` or describe only `1.8.0`.** Health's detailed `runtimeHealth`, diagnostics selectors, `operational` snapshot, model refresh selection, run receipts, and current batch bounds need one consistent explanation.
3. **Validation and watches have contradictory promises.** Disposable validation disables Antigravity; `--runtime all` currently covers Pi/Claude/OpenCode. A watch ledger survives restart, but an active observer is reloaded as `detached` and does not resume until re-registered. Some later paragraphs say this correctly while earlier sections over-promise.
4. **Recent product and hardening work is scattered or absent from adopter-facing docs.** The docs need a short current delta for Files Markdown editing, attachments/code-copy UX, model-aware `max`, subagent summaries, session metadata v2, transfer readiness, Antigravity liveness/retry, Claude SDK questions, and the security/persistence/lifecycle hardening that affects operators.

## Source evidence to keep aligned

- Contract/version: `server/src/internal-api/types.ts`, `docs/INTERNAL-API-CONTRACT.md`
- Health/capabilities: `server/src/internal-api/routes/health.ts`, `server/src/internal-api/routes/capabilities.ts`
- Diagnostics: `server/src/internal-api/routes/diagnostics.ts`, `server/src/internal-api/diagnostics-buffer.ts`, `server/src/observability/operational-metrics.ts`
- Session identifier resolution: `scripts/debug-where.mjs`, `server/src/internal-api/routes/sessions.ts`, `server/src/session-registry.ts`
- Validation scope/guardrails: `scripts/live-validate.ts`, `scripts/validation-server.ts`, `docs/LIVE-VALIDATION.md`
- Watch lifecycle: `server/src/internal-api/watch/watch-manager.ts`, `watch-store.ts`, `docs/LONG-HORIZON-VALIDATION.md`
- Notifications: `server/src/notifications/*`, `scripts/notify.sh`, `docs/NOTIFICATIONS.md`
- Current configuration: `server/src/config.ts`, `.env.example`, `package.json`
- Recent commit coverage: `git log -75`, especially the Internal API/observability/hardening, UI, runtime, persistence, and notification commits in that range.

## Implementation steps

### 1. Strengthen the entry points and navigation

Update `AGENTS.md`/`CLAUDE.md`, `docs/MAINTAINER-INDEX.md`, `docs/README.md`, `README.md`, and `docs/RECENT-CHANGES.md` so that:

- public adopters and maintainers have distinct reading paths;
- the current contract is `1.9.0` and `INTERNAL-API-CONTRACT.md` is the version authority;
- the first debugging instruction is `debug:where`, not global grep;
- the recent delta records both product-facing and operator-facing changes.

If `AGENTS.md` changes, regenerate and check the byte-identical `CLAUDE.md` mirror.

### 2. Add a session-ID evidence ladder

Update `docs/TROUBLESHOOTING.md`, `docs/OBSERVABILITY.md`, and `docs/SHARP-EDGES.md` with a small, copyable runbook:

1. run `npm run debug:where -- <id-or-path>`;
2. use the resolved canonical internal id for scoped diagnostics and API calls;
3. use `GET /api/v1/sessions/<id>/transcript?view=screen` for the cheapest UI-faithful readback (it accepts supported identifier forms);
4. use session-scoped diagnostics with `runId`/`requestId`/`component`/`runtime`/`since` when available;
5. only then inspect the runtime-specific file/journal printed by the locator;
6. use global grep only as a last resort.

Document production vs disposable socket/token paths and the difference between internal, registry-path, Claude-native, OpenCode-native, and Antigravity conversation IDs.

### 3. Reconcile the Internal API family

Update `docs/INTERNAL-API.md`, `docs/INTERNAL-API-CONTRACT.md`, `docs/INTERNAL-API-ORCHESTRATION.md`, `API.md`, and `docs/OBSERVABILITY.md` to cover:

- `1.9.0` health/runtime-health and diagnostics/operational additions;
- actual capability values and the fact that capabilities are runtime/backend-dependent;
- Pi/OpenCode model refresh selection and response semantics;
- durable run receipts, `runId`/`requestId`, streaming disconnect cancellation, and detached dispatch;
- batch limits (50 entries/concurrency 4) and when detached individual prompts are safer;
- diagnostics filter grammar and process-local/reset-on-restart bounds;
- watch re-registration after restart and non-TTL watch pin behaviour;
- stable error-code/version ownership and links without duplicating conflicting versions.

Avoid changing the API implementation unless a documentation check demonstrates a separate correctness bug; this task's primary deliverable is documentation.

### 4. Reconcile validation, long-horizon, and notification docs

Update `docs/LIVE-VALIDATION.md`, `docs/LONG-HORIZON-VALIDATION.md`, and `docs/NOTIFICATIONS.md` to distinguish:

- disposable-safe runtimes/scenarios from production-only/explicitly authorised paths;
- a durable ledger from a live observer that resumes automatically;
- durable notification acceptance from Telegram delivery (`pending`, `sent`, `failed`, disabled/unconfigured);
- helper exit success from actual external receipt;
- fixed retry cadence/backoff wording based on source;
- the exact terminal self-notification policy (meaningful milestones/blockers/questions and one final done).

### 5. Cover product and runtime deltas

Update the relevant canonical docs, keeping detail proportional:

- `docs/GETTING-STARTED.md`, `README.md`, `docs/RECENT-CHANGES.md`: current adopter-visible features and prerequisites;
- `docs/CODEBASE-MAP.md`, `docs/SESSION-METADATA.md`, `docs/DRIVE-MODE.md`: current file/store paths and metadata/UX boundaries;
- `docs/PROTOCOL.md`, `docs/EVENT-PIPELINE.md`: `max` thinking and recent event/UI behaviour;
- `docs/CLAUDE-PROVIDER-PROFILES.md`, `docs/CLAUDE-BACKENDS.md`: current model-aware effort vocabulary and validation caveats;
- `docs/ANTIGRAVITY-INTEGRATION.md`: disposable validation limitation and watchdog/heartbeat semantics;
- `docs/SECURITY.md`/`DEPLOYMENT.md`: recent auth, path, worktree, payload, persistence, and lifecycle hardening where it changes operator action.

### 6. Critical review and verification

Run these checks after edits:

- `npm run docs:sync-agent-guides`
- `npm run docs:check-agent-guides`
- repository-wide searches for stale contract/version and validation claims;
- Markdown link/anchor sanity checks using repository paths and targeted grep/scripts;
- `npm run lint`, `npm run typecheck`, `npm run build`, and relevant docs-adjacent tests (full `npm test` if time permits);
- inspect `git diff --stat`, `git diff --check`, and `git status --short`.

Re-read the edited entry points as an agent would, then make one further correction pass before declaring the docs complete.
