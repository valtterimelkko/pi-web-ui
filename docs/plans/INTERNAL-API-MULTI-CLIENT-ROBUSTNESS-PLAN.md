# Internal API Multi-Client Robustness Plan

**Status:** Implemented and validated; production deployment pending authorization
**Risk:** High (local control-plane startup, durable notification state, deployment tooling)
**Approach:** Test-first, incremental, single-process/single-operator architecture

## Goal

Make concurrent disposable validation and trusted same-host Internal API use robust while production is rebuilt or restarted. Preserve the Unix-socket/token security boundary, make self-notification durable and idempotent at ingress, and avoid active-active runtime ownership.

## Locked boundaries

- Never live-validate against production without explicit `--allow-production` permission.
- Do not restart, reconfigure, or otherwise modify the running production service during this work.
- Do not build full Internal API HA, blue/green runtime ownership, a sidecar, Redis, multi-tenant RBAC, inbound Telegram, or additional channels.
- Telegram delivery is **at least once**. Ingress idempotency prevents duplicate queue entries; it cannot eliminate the narrow crash-after-Telegram-accepts window.
- Keep `AGENTS.md` and `CLAUDE.md` byte-identical if either changes.

## Phase 1 — Concurrent disposable validation

1. Add failing tests for unique default validation directories and dynamically selected ports.
2. Extract testable launch-setting helpers.
3. Make no-argument `validate:server` use a short unique directory and distinct available ports.
4. Lock explicitly supplied validation directories so a second process fails safely.
5. Harden validation target safety so explicit production socket/token paths still require `--allow-production`.

## Phase 2 — Internal API socket ownership and startup

1. Add failing tests for live socket refusal, stale socket cleanup, non-socket/symlink refusal, inode replacement, and ownership-aware shutdown.
2. Replace unconditional unlink with fail-closed probing and inode-checked cleanup.
3. Clean up initialized managers when binding fails.
4. Make failure to start an enabled Internal API fatal to server startup instead of leaving a superficially healthy web server.

## Phase 3 — Notification ingress contract

1. Add failing tests for caller idempotency, payload conflicts, concurrent duplicate submissions, durable enqueue-before-acceptance, and pollable delivery status.
2. Accept an `Idempotency-Key` header, derive/persist it atomically with the queued notification, and return the existing notification for identical retries.
3. Return `202 Accepted` only after durable enqueue; drain Telegram asynchronously with handled errors.
4. Add `GET /api/v1/notifications/:notificationId` and truthful `pending|sent|failed` status.
5. Explicitly document at-least-once external delivery.

## Phase 4 — Restart-aware terminal self-notification

1. Add failing integration tests for recovery waits, response-loss retries, concurrent clients, and durable fallback.
2. Replace the fragile one-shot curl implementation behind `scripts/notify.sh` with a Node-stdlib client that:
   - waits for the expected production Internal API health before its first POST;
   - reuses one caller UUID across retries;
   - spools only retryable transport/5xx failures;
   - never spools auth/validation 4xx failures;
   - writes one atomic `0600` file per notification under a `0700` ingress directory.
3. Add a bounded, schema-validating, symlink-safe, quota/expiry-aware server ingress drainer that atomically claims files and runs both at startup and periodically.
4. Preserve the current shell CLI and message formatting contract.

## Phase 5 — Channel and deployment hardening

1. Add failing tests for Telegram timeout and thrown-error token redaction.
2. Add a configurable bounded Telegram transport timeout covering fetch and body read.
3. Add a generic argument-vector `flock` wrapper that holds a protected production-control lock for the entire caller command and preserves its exit code.
4. Add an Internal API readiness wait helper; neither helper performs a deployment or production action itself.
5. Add integration tests for lock contention and readiness timeout/success using disposable sockets only.

## Phase 6 — Contract and documentation

1. Bump the additive Internal API contract to `1.8.0`.
2. Update `docs/INTERNAL-API-CONTRACT.md`, `docs/INTERNAL-API.md`, `docs/INTERNAL-API-ORCHESTRATION.md`, `docs/LIVE-VALIDATION.md`, `docs/NOTIFICATIONS.md`, `docs/TROUBLESHOOTING.md`, `DEPLOYMENT.md`, `.env.example`, and relevant agent-facing guidance.
3. Document the trusted multi-client (not multi-tenant) boundary and at-least-once delivery semantics.

## Verification and review loop

After each phase:

1. Run the new test and confirm it failed for the intended missing behaviour.
2. Implement the minimum production change.
3. Run focused tests, then affected workspace tests.
4. Request a critical review; fix all material findings test-first.

Final verification:

- [x] two concurrent disposable validation servers used distinct directories, ports, sockets, and `0600` socket modes;
- [x] explicit `202` emit/idempotency/status and offline spool ingestion passed on a disposable server;
- [x] live Pi `notify-on-agent-end` scenario passed on a disposable server with the capture channel;
- [x] malformed path, oversized notification body, and post-rejection health were checked on a disposable server;
- [x] `npm run docs:check-agent-guides`;
- [x] `npm run lint` (zero errors; existing warning baseline remains);
- [x] `npm run typecheck`;
- [x] `npm run build`;
- [x] `npm test`;
- [x] repeated independent critical/architecture/QA reviews; material findings fixed test-first and re-reviewed;
- [x] final git status/diff/secret/session-artifact audit;
- [ ] production deploy only after new explicit operator permission.

Commit/push completion is recorded by repository history rather than a mutable
plan checkbox.
