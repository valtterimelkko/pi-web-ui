# HISTORICAL — OpenCode Direct Implementation Plan

> Status: **IMPLEMENTED** — kept for historical reference only.
>
> The OpenCode Direct path described here has already been implemented. This document is a design-history record, not the current source of truth.
>
> For current behaviour, read:
> - [`../OPENCODE-DIRECT-INTEGRATION.md`](../OPENCODE-DIRECT-INTEGRATION.md)
> - [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
> - [`../PROTOCOL.md`](../PROTOCOL.md)

## What This Document Is

This file records the phased implementation plan that guided the OpenCode Direct delivery.

It is still useful for:
- understanding how the feature was decomposed
- reviewing intended responsibilities by module
- comparing the original plan with the final implementation

It is **not** the canonical description of the current runtime path.

## Outcome Summary

The plan resulted in an implemented third runtime path with:
- a dedicated `server/src/opencode/` module family
- unified session-registry integration
- OpenCode-backed prompt dispatch and replay
- OpenCode availability reporting in the UI
- permission bridging into the existing approval UI
- E2E and server-side tests covering session creation and switching

## Original Goal

Add a third runtime path (`opencode`) to Pi Web UI, backed by a real `opencode serve` process, while keeping the browser UX aligned with the existing Pi SDK and Claude Direct paths.

## Planned Module Family

The planned and implemented module family was:
- `server/src/opencode/opencode-types.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-client.ts`
- `server/src/opencode/opencode-event-adapter.ts`
- `server/src/opencode/opencode-history-replay.ts`
- `server/src/opencode/opencode-session-subscribers.ts`
- `server/src/opencode/opencode-service.ts`

## Planned Integration Points

The main server integration points were:
- `server/src/session-registry.ts`
- `server/src/websocket/connection.ts`
- `server/src/routes/models.ts`
- `server/src/routes/health.ts`
- client runtime-picker and session display components

## Historical Phase Structure

The implementation was planned in these broad stages:

1. shared type/config foundation
2. OpenCode server-core modules
3. WebSocket and registry integration
4. client integration
5. permission bridge
6. tests and documentation updates

## What Still Matters from This Plan

If you are refactoring OpenCode Direct, the most useful parts of the old plan are the architectural intentions:
- OpenCode remains the runtime source of truth
- Pi Web UI adapts OpenCode events/history into the app's common session model
- the user-facing UX should stay consistent with the other runtimes

## Recommendation for Maintainers

Use this file for background only.

For active work, prefer the current docs and code:
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- `server/src/opencode/`
- `server/src/websocket/connection.ts`
- `client/src/store/sessionStore.ts`
