# Claude Direct Path — UX Issues and Architecture Notes

> Status: the documented fixes are implemented.
>
> This file is a focused analysis of the **Claude Direct** path. It is not the general architecture doc for the whole app.
>
> Start with:
> - [`../README.md`](../README.md)
> - [`./ARCHITECTURE.md`](./ARCHITECTURE.md)
> - [`./PROTOCOL.md`](./PROTOCOL.md)

## Why This Document Exists

Claude Direct is the most workaround-heavy runtime path in Pi Web UI because it is built around `claude -p` subprocesses rather than a first-class long-lived server/runtime API.

This document records:
- the UX problems that were found
- the root causes in the Claude Direct architecture
- the implemented fixes
- why true mid-turn interaction remains limited

## Problems That Were Identified

Originally, Claude Direct had these UX gaps:

1. missing or weak streaming/thinking status in the UI
2. abort behaviour that did not update all subscribers reliably
3. completion/error signalling that did not always reach every viewer of the session
4. no true mid-turn interaction equivalent to Pi SDK-style steer

The first three were fixed in the current implementation.
The fourth remains an architectural limitation of the `claude -p` style path.

## Root Cause Summary

Claude Direct differs from the Pi SDK path in several important ways:

| Aspect | Pi SDK | Claude Direct |
|---|---|---|
| Runtime model | Pi-managed session lifecycle | subprocess-per-turn |
| Primary session source | Pi session files | Pi-owned Claude JSONL + CLI session state |
| Event source | Pi SDK events | normalized NDJSON from `claude -p` |
| Mid-turn interaction | richer | fundamentally limited |

Because of that, Claude Direct needs custom handling in:
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-process-pool.ts`
- `server/src/claude/claude-event-normalizer.ts`
- `server/src/claude/claude-history-replay.ts`
- `server/src/websocket/connection.ts`

## Implemented Fixes

### 1. Claude status broadcasting
Claude sessions are now represented in the same general session-status broadcast loop the UI relies on.

### 2. Completion and error fanout
Completion/error handling now reaches all subscribers watching the Claude session, not just the initiating browser tab.

### 3. Abort state fanout
Abort now causes the appropriate session-end/state updates to be broadcast so viewers do not remain stuck in a misleading streaming state.

## Remaining Constraint: No True Mid-turn Steer

The main reason is architectural:
- `claude -p` is turn-oriented
- stdin/live session control is limited in the current integration approach
- follow-up is effectively a new prompt on the resumed session, not a real interactive mid-turn control channel

So while the UI can present Claude sessions alongside the others, Claude Direct should still be understood as the least interactive runtime path.

## Why This Matters for Future Work

If you change Claude Direct behaviour, read this file together with:
- `server/src/claude/`
- `server/src/websocket/connection.ts`
- the OpenCode Direct docs, to avoid copying Claude-specific workarounds into cleaner runtime paths

## Future Direction

A more capable Claude integration would likely require a different backend integration model than the current `claude -p` subprocess path.

That is a separate architectural decision and should be treated as a migration project, not a small bugfix.
