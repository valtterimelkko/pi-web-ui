# Claude Channel Native Hook Routing Design

Status: **future proposal / not implemented**  
Risk level: **medium**  
Owner area: Claude channel runtime (`server/src/claude/*`, `pi-claude-channel/server.ts`)

## Summary

Native Claude Code hooks are firing and contain richer tool detail, but Pi Web UI currently drops many of them because the hook `session_id` is Claude Code's real native session id, while Pi Web UI routes Claude channel traffic by its own synthetic channel id.

This document proposes a safer way to use those native hooks without cross-session contamination. The core principle is: **do not trust the native Claude hook session id as a durable Web UI session id**. Treat native hook events as belonging to the currently verified Claude channel turn only, quarantine ambiguous events, and drop anything that cannot be attributed with high confidence.

## Current behaviour

Relevant files:

- `server/src/claude/claude-channel-service.ts`
- `server/src/claude/claude-channel-event-adapter.ts`
- `server/src/claude/claude-channel-hooks-config.ts`
- `pi-claude-channel/server.ts`
- `server/src/claude/claude-session-store.ts`
- `server/src/claude/claude-history-replay.ts`

Current flow:

1. `ClaudeChannelService.createSession()` creates:
   - an internal Pi Web UI session id: `sessionId`
   - a synthetic Claude channel id: `claudeSessionId`
2. `sendPrompt()` sends a WebSocket request to the local channel plugin with `sessionId: entry.claudeSessionId`.
3. `pi-claude-channel/server.ts` pushes a channel notification to Claude with metadata such as `chat_id` and `session_id`, both set to the synthetic channel id.
4. MCP `reply`, `status`, `send_event`, and permission events use that synthetic `chat_id`, so Pi Web UI can map them through `claudeToInternal`.
5. Native Claude hooks (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionStart`) arrive at the plugin HTTP hook server with Claude Code's **native** `session_id`.
6. The plugin currently broadcasts some of those native hook payloads using `sessionId: nativeSessionId`.
7. `ClaudeChannelService.wireUpEventHandler()` drops unknown ids with this guard:

   ```ts
   if (!mappedInternalSid && !pending && !late) {
     continue;
   }
   ```

That guard is good: it prevents orphan session files and accidental cross-session event pollution. The downside is that native hook data is often not visible in the Web UI.

## Why native hooks are useful

Native hooks can provide details that are better than asking the model to call `send_event` manually:

- actual tool name from Claude Code
- actual `tool_input`
- actual `tool_output` or `tool_error`
- native `tool_call_id` when available
- `Stop` usage / stop reason
- session start metadata
- evidence that Claude Code is still active even if the model did not call `send_event`

Using these hooks could improve:

- tool cards not showing as generic or permanently running
- replay fidelity
- debugging of long turns
- user confidence that Claude is working

## Primary risk

Pi Web UI's channel-backed Claude runtime uses a shared interactive Claude Code process. A native hook `session_id` may represent the Claude Code process/session rather than a particular Pi Web UI session. If we permanently map `nativeSessionId -> internalSessionId`, later hooks from another Web UI session could be routed to the wrong chat.

Concrete failure modes:

- tool output from session A appears in session B
- a `Stop` hook marks the wrong session idle
- private prompt/tool data leaks across sessions
- replay JSONL for one session is polluted with another session's tool history
- timeout/late-listener behaviour revives a stopped session incorrectly

Therefore the safer design must prefer false negatives (drop useful native hooks) over false positives (misroute hooks).

## Design goals

1. Use native hook detail only when attribution is high confidence.
2. Never create or persist orphan session files for unknown native hook ids.
3. Avoid persistent `nativeSessionId -> internalSessionId` routing as the primary mechanism.
4. Route hooks per active turn, not per native session id.
5. Support shadow-mode rollout before user-visible/persistent behaviour.
6. Make every drop reason observable in debug logs/counters.
7. Keep existing synthetic channel-id path working unchanged.

## Non-goals

- Do not change PTY idle heuristics as part of this work.
- Do not scrape Claude's terminal UI as authoritative state.
- Do not restart Claude Code automatically to solve hook ambiguity.
- Do not route unknown native hooks just because a native session id was seen before.
- Do not persist raw hook bodies wholesale.

## Proposed architecture

Add a small routing layer before normal channel event normalisation:

```text
pi-claude-channel native hook HTTP endpoint
  -> emits structured native_hook event to Web UI service
    -> ClaudeNativeHookRouter verifies active-turn attribution
      -> ClaudeChannelEventAdapter converts to Pi events
        -> dedupe/merge with MCP send_event tool events
          -> UI + optional JSONL persistence
```

New server module:

- `server/src/claude/claude-native-hook-router.ts`

Main integration point:

- `ClaudeChannelService.wireUpEventHandler()` should call the router before `eventAdapter.normalize()` for native hook events.

Plugin integration point:

- `pi-claude-channel/server.ts` should emit structured native hook events instead of pretending native hook `session_id` is a Web UI session id.

## Feature flags

Start disabled by default:

```env
CLAUDE_CHANNEL_NATIVE_HOOK_ROUTING=false
CLAUDE_CHANNEL_NATIVE_HOOK_SHADOW=true
CLAUDE_CHANNEL_NATIVE_HOOK_PERSIST=false
CLAUDE_CHANNEL_GLOBAL_TURN_LOCK=true
```

Suggested semantics:

- `CLAUDE_CHANNEL_NATIVE_HOOK_ROUTING=false`: ignore native hook routing entirely.
- `CLAUDE_CHANNEL_NATIVE_HOOK_SHADOW=true`: compute route/drop decisions and log counters, but do not emit UI events.
- `CLAUDE_CHANNEL_NATIVE_HOOK_PERSIST=false`: allow UI-only routed events first; persist only after confidence is proven.
- `CLAUDE_CHANNEL_GLOBAL_TURN_LOCK=true`: only one Claude channel turn may be active across the shared process.

## Prerequisite: single active turn guard

The safest version should first make the shared Claude channel process a single-active-turn resource.

Current code blocks overlapping prompts per session, but not necessarily across all Claude channel sessions. Since native hooks come from one shared Claude process, the router is much safer if only one Web UI turn can be active.

Implementation sketch in `ClaudeChannelService`:

```ts
private activeChannelTurn: ActiveClaudeTurn | null = null;

private assertNoOtherActiveTurn(sessionId: string): void {
  if (!this.activeChannelTurn) return;
  if (this.activeChannelTurn.internalSessionId === sessionId) return;

  const err = new Error('Claude channel is already processing another session') as PromptCompletionError;
  err.code = 'CLAUDE_CHANNEL_BUSY';
  throw err;
}
```

In `sendPrompt()`:

1. call `assertNoOtherActiveTurn(sessionId)` before appending the user entry
2. create an `ActiveClaudeTurn`
3. clear it on verified `agent_end`, timeout, abort, or service stop

If the product prefers queueing over rejection later, add a queue after hook routing is stable. For the first version, rejection is safer and easier to reason about.

## Active turn state

Add an explicit turn correlation object. It should be in memory only.

```ts
interface ActiveClaudeTurn {
  internalSessionId: string;
  syntheticClaudeSessionId: string;
  promptId: string;
  promptHash: string;
  promptPreviewHash?: string;
  cwd: string;
  model?: string;
  sentAt: number;
  promptAckAt?: number;
  verifiedByUserPromptHookAt?: number;
  nativeSessionId?: string;
  state: 'sent' | 'acked' | 'verified' | 'late' | 'completed' | 'aborted' | 'timed_out';
  expiresAt: number;
}
```

Do **not** use `nativeSessionId` alone for future routing. It is evidence for the current turn, not a durable identity mapping.

## Plugin event shape

Change `pi-claude-channel/server.ts` native hook handlers to emit a neutral event type:

```ts
broadcast('__global__', {
  type: 'native_hook',
  hookType: 'post-tool-use',
  nativeSessionId: session_id,
  timestamp,
  cwd,
  transcriptPath: transcript_path,
  toolName: tool_name,
  toolInput: tool_input,
  toolOutput: tool_output,
  toolCallId: tool_call_id,
  toolError: tool_error,
});
```

Notes:

- The exact broadcast target can remain the plugin's global WebSocket clients; the important part is that `sessionId` is not set to the native id as if it were a Web UI id.
- Include `hookType` so the server can apply hook-specific rules.
- Include `nativeSessionId` as data only.
- Include `cwd` and `transcriptPath` if Claude supplies them.
- Do not log full prompt text or full tool output by default.

For `UserPromptSubmit`, prefer a hashed prompt value if possible:

```ts
{
  type: 'native_hook',
  hookType: 'user-prompt-submit',
  nativeSessionId: session_id,
  timestamp,
  cwd,
  promptHash: sha256(normalizePrompt(prompt_text)),
  promptTextIncludesSyntheticId: prompt_text.includes(chat_id) // if safely derivable
}
```

If the plugin cannot hash safely, send `promptText` only to localhost and let the server hash it immediately, then discard the raw value.

## Routing algorithm

Create `ClaudeNativeHookRouter.route(event, activeTurn)`.

Return type:

```ts
interface NativeHookRouteDecision {
  action: 'route' | 'buffer' | 'drop';
  internalSessionId?: string;
  reason: string;
  confidence: 'verified' | 'single-active-turn' | 'buffered' | 'none';
  normalizedEvent?: ChannelEvent;
}
```

### Common checks for every native hook

Drop if any of these are true:

1. native hook routing flag disabled
2. no `activeChannelTurn`
3. active turn is `completed` or `aborted` and outside late-listener window
4. event timestamp is older than active turn `sentAt - 5s`
5. event timestamp is after `activeTurn.expiresAt`
6. hook `cwd` exists and does not match active turn `cwd` after path normalisation
7. hook type is not allow-listed

Allowed hook types for first implementation:

- `user-prompt-submit`
- `post-tool-use`
- `stop`
- `session-start`

### UserPromptSubmit hook

This is the best evidence for turn attribution.

Route/verify only if at least one strong signal matches:

1. prompt text contains the synthetic channel id from the active turn, e.g. `chat_id="..."`; or
2. normalized prompt hash matches `activeTurn.promptHash`; or
3. there is exactly one active turn globally, the hook arrives within 30 seconds of `sentAt`, and `cwd` matches.

On success:

- set `activeTurn.verifiedByUserPromptHookAt`
- store `activeTurn.nativeSessionId` for diagnostics only
- flush any buffered `post-tool-use` events for this same native id and time window

Do not emit a visible user message from this hook by default. The Web UI already records the user prompt when `sendPrompt()` is called. Emitting it again risks duplicates.

### PostToolUse hook

Preferred handling:

1. If active turn is already verified by `UserPromptSubmit`, route.
2. If not verified yet but there is exactly one active turn, buffer for up to 5 seconds.
3. If verification arrives, flush buffered events.
4. If no verification arrives, drop buffered events with reason `unverified_native_tool_hook`.

Do not route `PostToolUse` directly to a session based only on `nativeSessionId`.

### Stop hook

Route only if:

- the active turn is verified; or
- there is exactly one active turn, `cwd` matches, and the stop arrives after `sentAt` but before timeout.

When routed, it may produce `agent_end` / usage updates for the active internal session.

If there is already an MCP `reply` / `agent_end` for the same turn, dedupe rather than emitting a second finalisation.

### SessionStart hook

Use for diagnostics and model/cwd metadata only. Do not use `SessionStart` alone to map native session id to internal session id.

## Dedupe and merge rules

Native hooks and MCP `send_event` can describe the same tool. The UI should not show duplicates.

Maintain a short-lived per-turn tool index:

```ts
interface ObservedToolEvent {
  internalToolCallId: string;
  source: 'mcp_send_event' | 'native_hook';
  toolName: string;
  argsHash: string;
  startedAt: number;
  endedAt?: number;
  hasResult: boolean;
}
```

When a routed native `PostToolUse` arrives:

1. If `toolCallId` matches an existing tool, update that tool result.
2. Else if `toolName + stableJson(toolInput)` matches an existing open tool within +/- 10 seconds, update that existing tool.
3. Else create a synthetic start and end pair from the post-tool-use payload.

Prefer native output for final result when it is available, but keep MCP-start timing if it exists.

Generated fallback id format:

```ts
native_${promptId}_${shortHash(toolName + stableJson(toolInput) + timestampBucket)}
```

## Persistence policy

Initial rollout should be UI-only. Persist after shadow metrics show low ambiguity.

When persistence is enabled:

- persist only routed events, never dropped/buffered raw events
- add optional source metadata to JSONL entries:

```ts
source?: 'mcp_send_event' | 'native_hook' | 'replay_synthetic';
nativeHookType?: string;
```

- cap stored `toolOutput` length using the same policy as other tool outputs
- do not persist full raw native hook payloads
- do not persist native `prompt_text`

## Security and privacy rules

- Treat native hook payloads as untrusted input.
- Validate with Zod or equivalent before routing.
- Allow-list hook types and fields.
- Normalise and compare paths safely.
- Never route if attribution is ambiguous.
- Never log full prompt text, tool input, or tool output by default.
- Keep debug logging behind an explicit env flag.
- Avoid cross-session leakage even if it means dropping useful hook events.

## Observability

Add counters/log reasons in `ClaudeChannelService` or the new router:

- `native_hook_seen_total`
- `native_hook_routed_total`
- `native_hook_buffered_total`
- `native_hook_dropped_no_active_turn_total`
- `native_hook_dropped_cwd_mismatch_total`
- `native_hook_dropped_unverified_total`
- `native_hook_dropped_ambiguous_total`
- `native_hook_deduped_tool_total`

Debug log format:

```text
[ClaudeNativeHookRouter] drop hook=post-tool-use reason=cwd_mismatch native=abc activeSession=59c... promptId=...
```

Do not include raw prompt/tool payloads in logs.

## Testing plan

Add unit tests for `ClaudeNativeHookRouter`:

1. drops native hook when there is no active turn
2. drops native hook when cwd mismatches active turn cwd
3. verifies active turn from `UserPromptSubmit` containing synthetic channel id
4. verifies active turn from exact normalized prompt hash
5. buffers `PostToolUse` before verification and flushes after `UserPromptSubmit`
6. drops buffered `PostToolUse` after TTL without verification
7. routes `Stop` only to the active internal session
8. does not use native session id as durable mapping across two sequential Web UI sessions
9. rejects ambiguous routing if global turn lock is disabled and two candidate turns exist
10. never requests persistence for dropped events

Add adapter/service tests:

1. native `PostToolUse` creates a start/end pair if no MCP event exists
2. native `PostToolUse` updates existing MCP tool card when tool name and args match
3. native result does not duplicate an already-ended tool
4. native `Stop` does not emit duplicate `agent_end` after MCP `reply`
5. unknown native hook does not create `~/.pi-web-ui/claude-sessions/<native-id>.jsonl`

Add integration test:

- Create a Claude channel session, simulate native hook events with a native id, verify they are routed only after a matching active turn is present.

Regression test for the most important risk:

1. session A active, native id `N`, route a tool to A
2. A completes
3. session B active, native id still `N`, route a tool to B
4. assert no B events appear in A history and no A events appear in B history

## Implementation phases

### Phase 1: shadow router only

- Add `ClaudeNativeHookRouter`.
- Add active turn state.
- Add plugin `native_hook` event shape behind feature flag.
- Compute route/drop decisions but do not emit UI events or persist.
- Add counters/debug logs.

### Phase 2: UI-only routed native tool results

- Enable routing to `pending.onEvent()` only.
- Keep persistence disabled.
- Dedupe with MCP `send_event` events.
- Validate in browser that tool cards improve and no duplicates appear.

### Phase 3: persist routed native hook events

- Enable JSONL persistence for routed native tool events only.
- Extend replay tests for `source: 'native_hook'` if stored.
- Keep raw hook payload persistence forbidden.

### Phase 4: optional PreToolUse hook

If PostToolUse routing is stable, consider adding Claude Code `PreToolUse` hooks to show tool start earlier. This should be a separate change because it increases event volume and permission-adjacent complexity.

## Suggested file changes

Likely files to change:

- `server/src/config.ts`
  - add feature flags
- `server/src/claude/claude-channel-service.ts`
  - active turn state
  - global turn guard
  - router integration before event adapter
  - shadow counters/logging
- `server/src/claude/claude-native-hook-router.ts`
  - new attribution/buffering/dedupe logic
- `server/src/claude/claude-channel-event-adapter.ts`
  - support normalized routed native hook events
- `server/src/claude/claude-session-store.ts`
  - optional `source` / `nativeHookType` fields
- `server/src/claude/claude-history-replay.ts`
  - replay source metadata if useful, no raw-hook dependency
- `pi-claude-channel/server.ts`
  - emit `native_hook` events from HTTP hook receiver
  - stop presenting native hook `session_id` as a Web UI `sessionId`
- `server/tests/unit/claude/*`
  - router, adapter, service, replay tests
- `scripts/live-validate.ts`
  - optional validation for native hook visibility after rollout via the Internal API runner

## Acceptance criteria

A future implementation should be considered safe only when all are true:

- Unknown native hook ids never create session files.
- Native hooks are never routed without an active turn.
- Native session id alone is insufficient for persistent routing.
- CWD mismatch causes a drop.
- Ambiguous candidates cause a drop.
- Duplicate MCP/native tool events are merged or deduped.
- Sequential turns sharing the same native session id route to the correct Web UI sessions.
- Full server tests, targeted client tests, lint, typecheck, and build pass.
- Live Claude channel validation still passes after restart.

## Open questions

- Does Claude Code's `UserPromptSubmit` hook always include enough prompt text or metadata to detect the synthetic channel id?
- Does the native hook body reliably include `cwd` and `transcript_path` across Claude Code versions?
- Is the native `tool_call_id` stable and present for all built-in tools?
- Should global Claude channel prompt concurrency be rejected or queued in the UI?
- What maximum `toolOutput` size should be persisted for native hook results?

Until these are answered, keep the feature behind shadow-mode flags and prefer dropping ambiguous hooks.
