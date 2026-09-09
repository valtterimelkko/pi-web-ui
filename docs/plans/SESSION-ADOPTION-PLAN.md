# Session Adoption & Native Adoption — Contract 1.40.0

Status: **EXECUTED 2026-09-09** (phases 0–5 complete; production restart remains
owner-gated as always). Strict TDD: RED suite
`server/tests/unit/internal-api/session-routes-adopt.test.ts` observed failing
12/12 before any implementation change (16/16 after hardening tests were added;
green after implementation). Live validation: 18/18 checks passed on a
disposable server against real pi sessions + real claude artefact resolution
(`scripts/live-validate-adopt.mjs`). agent-os mirror resynced + pushed
(7f37513, suite 1986/1986).

## Intent

Orchestration agents routinely end up with sessions that were created outside
the parent→child flow: a pre-prompted child created by `POST /sessions` without
`parentSessionId`/`X-Parent-Session`, or a session started directly in a CLI
(Claude Code, Command Code, OpenCode, Antigravity) that never entered the
registry with a parent at all. Today there is no way to link such a session to
a parent after the fact, and no way to pull a native CLI session into the
registry as a linked child. Both operations are display-only linkage (contract
1.34.0 semantics): they never move transcripts, never restart anything, and
never change runtime ownership.

Contract 1.40.0 adds two additive endpoints plus a control verb:

1. `POST /api/v1/sessions/:id/adopt` — link an existing **registered** session
   (`:id` = child) to a parent. Parent from body `parentSessionId` or
   `X-Parent-Session` header (header wins, same precedence as create). Optional
   `alias` becomes the child-card label; optional `role` is an advisory echo.
   Broadcasts `child_dispatched` to the parent's broker key + browser surface,
   exactly like create-time linkage. Errors: `404 SESSION_NOT_FOUND` (child or
   parent unknown), `400 INVALID_REQUEST` (missing parent, self-adoption,
   would create a parent cycle).
2. `POST /api/v1/sessions/adopt-native` — resolve an **unmanaged** native CLI
   session artefact on disk (same layouts the bounded native scan reads) and
   register it as a linked child. Body: `runtime`
   (`claude|commandcode|opencode|antigravity`), `nativeId`, optional `cwd`,
   optional `parentSessionId`/`alias`/`role`. If the native id is already known
   in the registry the existing entry is adopted (no duplicate). Otherwise a
   new entry is created with `origin: 'native-discovered'`, the native id field
   set (`claudeSessionId` / `commandCodeNativeSessionId` / `opencodeSessionId`
   / `antigravityConversationId`), best-effort `firstMessage` preview and
   bounded message count. Errors: `404 NATIVE_SESSION_NOT_FOUND` (new code,
   artefact not on disk), `404 SESSION_NOT_FOUND` (parent unknown),
   `400 INVALID_REQUEST` (bad runtime / unsafe nativeId / missing parent).
3. `POST /api/v1/sessions/:id/control` gains `action: 'adopt'` with the same
   semantics and a `{ success, action: 'adopt', childSessionId,
   parentSessionId, runtime }` response — adoption through the existing
   control surface (P1 control lane).

Non-goals: no transfer of transcript ownership, no runtime attachment of the
native session (a native child still cannot be prompted through pi-web-ui
until a runtime supports it), no unadopt operation (delete the linkage by
clearing `parentSessionId` is out of scope for 1.40.0).

## Quality gates

- RED first: `session-routes-adopt.test.ts` 12/12 failing (observed).
- GREEN: suite passes; no existing suite regresses (`npm test` workspaces).
- `npm run lint`, `npm run typecheck`, `npm run build` clean.
- Disposable-server live validation exercising both endpoints over the real
  Internal API socket (wire-level proof incl. `child_dispatched` on the
  broker), per docs/LIVE-VALIDATION.md.
- agent-os mirror resync (constant, observability pin, contract mirror doc).

## Implementation map

| Concern | File |
|---|---|
| Contract version 1.39.0 → 1.40.0 | `server/src/internal-api/types.ts` |
| Response/request types, control union | `server/src/internal-api/types.ts` |
| `NATIVE_SESSION_NOT_FOUND` (404) | `server/src/internal-api/error-codes.ts` |
| Body schemas (`adopt`, `adopt-native`, control verb) | `server/src/internal-api/session-validation.ts` |
| Broker key helper export | `server/src/internal-api/child-linkage.ts` |
| Native artefact resolution + previews | `server/src/internal-api/native-sessions.ts` |
| Registry upsert carries agy id + parentSessionId on create (gap fix) | `server/src/session-registry.ts` |
| Handlers + control branch + exports | `server/src/internal-api/routes/sessions.ts` |
| Routing (`adopt-native` reserved word, `:id/adopt`) | `server/src/internal-api/server.ts` |
| Contract changelog + reference | `docs/INTERNAL-API-CONTRACT.md`, `docs/INTERNAL-API.md` |
| Mirror | `/root/agent-os` (client constant, observability pin, contract mirror doc) |

Path-safety: `nativeId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (no
separators, no `..`), antigravity/commandcode ids additionally UUID-checked to
mirror discovery semantics; the resolved path must stay inside the runtime
root (containment check before any read).
