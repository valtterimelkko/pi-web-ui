# Claude Direct Path — UX Issues & Architecture Analysis

> **Date:** 2026-04-12
> **Status:** Issues 1–3 ✅ **IMPLEMENTED**. Issue 4 + SDK migration deferred.
> **Context:** Claude Direct path (`server/src/claude/`) is newer than the Pi SDK path and has several UX gaps when interacting via the Web UI.

---

## Problems Reported

When using a **Claude Direct** session in the Pi Web UI:

1. ~~**No "thinking" indicator**~~ — ✅ **FIXED** — Claude sessions now broadcast `session_status` via the same 1s polling loop as Pi SDK sessions.
2. ~~**Can't abort**~~ — ✅ **FIXED** — Abort now broadcasts `agent_end` to all subscribers immediately.
3. ~~**Can't send mid-process messages (steer)**~~ — ✅ **FIXED (partial)** — `onComplete` now broadcasts errors and `agent_end` to ALL subscribers (not just the requester). True mid-turn steer is still blocked by Issue 4.
4. **No mid-turn interaction at all** — ❌ **DEFERRED** — The fundamental architecture of `claude -p` subprocess means each turn is fire-and-forget. Requires SDK migration.

These issues are especially noticeable when you leave a Claude session running, come back later (possibly via a different browser tab), and the UI doesn't reflect that the session is still actively processing.

---

## Root Cause Analysis

### The Core Architecture Gap

The Pi Web UI has **two separate runtime paths** with **two separate state management systems**:

| Aspect | Pi SDK Path | Claude Direct Path |
|---|---|---|
| Session manager | `MultiSessionManager` | `ClaudeService` + `ClaudeProcessPool` |
| Status tracking | `MultiSessionManager.getAllSessionStatuses()` | `ClaudeProcessPool.isActive()` |
| Status broadcasting | `setupSessionStatusBroadcasting()` polls every 1s | **Nothing** |
| Event streaming | Events flow through `MultiSessionManager` subscriptions | Events flow through `onEvent` callback in `handleClaudePrompt()` |
| Abort | `agentSession.abort()` + state broadcast | `SIGTERM` to process, no state broadcast |
| Steer | `agentSession.steer()` | **Not implemented** (not possible with `claude -p`) |

The key insight: `setupSessionStatusBroadcasting()` in `connection.ts` (line ~187) **only polls `multiSessionManager.getAllSessionStatuses()`** — which only knows about Pi SDK sessions. Claude sessions managed by `ClaudeService` are completely invisible to this broadcast loop.

### Specific Bugs Found

#### Bug 1: No `session_status` broadcasting for Claude sessions

**File:** `server/src/websocket/connection.ts` — `setupSessionStatusBroadcasting()`

The 1-second polling interval only queries `MultiSessionManager`:

```typescript
setInterval(() => {
  const statuses = this.multiSessionManager.getAllSessionStatuses();
  for (const status of statuses) {
    this.broadcast({ type: 'session_status', ... });
  }
}, 1000);
```

Claude sessions tracked by `ClaudeService`/`ClaudeProcessPool` are never polled, so the client never receives `session_status` updates for them. The client only gets `isStreaming` from the one-time `session_switched` message when switching to a Claude session, then silence.

**Client impact:** After switching to a Claude session that's running, `sessionStore.ts` sets `isStreaming` from the `session_switched` message, but with no ongoing `session_status` events, it eventually falls back to "idle/waiting" appearance.

#### Bug 2: `onComplete` only notifies the requesting client, not all subscribers

**File:** `server/src/websocket/connection.ts` — `handleClaudePrompt()`

When a Claude process finishes, `onComplete` is called:

```typescript
await this.claudeService.sendPrompt(sessionId, prompt,
  (normalizedEvent) => {
    // This correctly broadcasts to all subscribers
    const subscribers = this.claudeSubs.getSubscribers(sessionId);
    for (const subId of subscribers) { ... }
  },
  (error) => {
    // This only sends to the requesting client!
    if (error) {
      this.sendMessage(clientId, { type: 'error', ... });
    }
    // No session_status or agent_end broadcast to other subscribers
  }
);
```

The `onEvent` callback correctly uses `claudeSubs.getSubscribers()` to broadcast to all viewers. But `onComplete` only sends to `clientId` (the requester). If you're viewing the session from a different browser tab, you never see the turn complete.

Also: the `agent_end` event is emitted inside `ClaudeProcessPool.spawn()` (when the process exits normally), which does go through `onEvent` and gets broadcast. But it's fragile — if the process errors, no `agent_end` is emitted to subscribers.

#### Bug 3: Abort doesn't broadcast state change to subscribers

**File:** `server/src/websocket/connection.ts` — `handleAbort()`

```typescript
if (this.claudeSessionIds.has(sessionPath)) {
  this.claudeService.abort(sessionPath);  // Sends SIGTERM
  return;  // No broadcast!
}
```

The `abort()` call sends SIGTERM to the subprocess. The process eventually exits, which triggers `onComplete` (which only notifies the original requester — Bug 2). Other subscribers don't see the abort or the state change.

#### Issue 4 (Architectural): No mid-turn interaction possible with `claude -p`

**File:** `server/src/claude/claude-process-pool.ts`

The Claude Direct path spawns `claude -p` as a non-interactive subprocess:

```typescript
const proc = spawn('claude', ['-p', options.prompt, '--output-format', 'stream-json', ...], {
  stdio: ['ignore', 'pipe', 'pipe'],  // stdin is IGNORED
});
```

- `stdin` is set to `'ignore'` — no way to inject messages mid-process
- Each process takes one prompt, runs until completion, exits
- Follow-up turns spawn a new process with `--resume`
- `handleSteer()` in `connection.ts` only works for Pi SDK sessions — Claude sessions are silently dropped

**This is a fundamental `claude -p` limitation, not a bug.** Fixing this requires either:
- Migrating to the Claude Agent SDK (see analysis below)
- Using the SDK's V2 session API (`unstable_v2_createSession` / `.send()`)

---

## Solutions

### ✅ Fix 1: Add Claude session status broadcasting (IMPLEMENTED)

Add Claude-aware status polling to `setupSessionStatusBroadcasting()` in `connection.ts`:

```typescript
setInterval(() => {
  // Existing Pi SDK status broadcasting
  const statuses = this.multiSessionManager.getAllSessionStatuses();
  for (const status of statuses) { ... }

  // NEW: Also broadcast status for active Claude sessions
  for (const sessionId of this.claudeSessionIds) {
    const subscribers = this.claudeSubs.getSubscribers(sessionId);
    if (subscribers.size > 0) {
      const isRunning = this.claudeService.isRunning(sessionId);
      this.broadcast({
        type: 'session_status',
        sessionId,
        sessionPath: sessionId,
        status: isRunning ? 'streaming' : 'idle',
        lastActivity: new Date().toISOString(),
      });
    }
  }
}, 1000);
```

### ✅ Fix 2: Broadcast `agent_end` and errors to all Claude subscribers (IMPLEMENTED)

In `handleClaudePrompt()` in `connection.ts`, change `onComplete` to broadcast:

```typescript
onComplete: (error) => {
  const subscribers = this.claudeSubs.getSubscribers(sessionId);

  if (error) {
    for (const subId of subscribers) {
      this.sendMessage(subId, { type: 'error', message: error.message, code: 'CLAUDE_ERROR' });
    }
  }

  // Broadcast agent_end to all subscribers
  for (const subId of subscribers) {
    this.sendMessage(subId, {
      type: 'session_event',
      sessionId,
      event: { type: 'agent_end', result: null, usage: {} },
    });
  }
}
```

### ✅ Fix 3: Fix abort to broadcast state change (IMPLEMENTED)

In `handleAbort()` in `connection.ts`, after calling `this.claudeService.abort()`, broadcast to subscribers:

```typescript
if (this.claudeSessionIds.has(sessionPath)) {
  this.claudeService.abort(sessionPath);

  // Broadcast abort state change to all subscribers
  const subscribers = this.claudeSubs.getSubscribers(sessionPath);
  for (const subId of subscribers) {
    this.sendMessage(subId, {
      type: 'session_event',
      sessionPath,
      event: { type: 'agent_end', result: null, usage: {} },
    });
  }
  return;
}
```

### ❌ Fix 4: Mid-turn interaction / steer (DEFERRED — requires SDK migration)

See "Issue 4 + Claude Agent SDK Migration Analysis" below.

---

## Issue 4 + Claude Agent SDK Migration — Future Consideration

### What the Claude Agent SDK Provides

The `@anthropic-ai/claude-agent-sdk` package (v0.2.x) wraps the `claude` binary with:

| Feature | Current (`claude -p` subprocess) | SDK V1 (`query()`) | SDK V2 (unstable, `@alpha`) |
|---|---|---|---|
| Spawn mechanism | Manual `child_process.spawn()` | SDK spawns subprocess | SDK spawns subprocess |
| Message types | Raw NDJSON → manual parsing | Typed `SDKMessage` union | Same + session API |
| Abort | SIGTERM | `AbortController.abort()` | `session.close()` |
| Mid-turn input (steer) | ❌ stdin=ignore | ❌ Still single-prompt | ✅ `session.send()` |
| Tool permission callbacks | ❌ | ✅ `canUseTool` | ✅ `canUseTool` |
| Multi-turn | New process per turn | New `query()` per turn | ✅ Persistent `SDKSession` |
| `bypassPermissions` as root | ❌ Blocked since v2.1.100 | ✅ Works | ✅ Works |

### Key V2 API (Unstable)

```typescript
// Create a persistent session
const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6',
  allowedTools: ['Bash', 'Read', 'Edit', 'Write'],
  canUseTool: async (toolName, input, { signal }) => {
    // Relay to web UI for approval
    return { behavior: 'allow', updatedInput: input };
  },
});

// Send a message
await session.send("Read auth.py");

// Stream responses
for await (const msg of session.stream()) {
  // Typed: SDKAssistantMessage, SDKToolUseMessage, SDKResultMessage, etc.
}

// Mid-turn interaction (THIS is what we need for steer)
await session.send("Also check the tests"); // While still streaming

// Close
session.close();
```

### Migration Assessment

**Benefits of migrating:**
- ✅ **Cleaner code**: Replace `ClaudeProcessPool` (~180 lines) + `ClaudeEventNormalizer` (~200 lines) with SDK calls
- ✅ **Typed messages**: No more manual NDJSON parsing
- ✅ **`canUseTool`**: Enables web UI tool approval flow (huge UX win)
- ✅ **V2 sessions**: Would enable steer/mid-turn interaction (if/when V2 stabilizes)
- ✅ **`bypassPermissions` as root**: No more `dontAsk` + broad `--allowedTools` workaround

**Risks of migrating:**
- ⚠️ SDK is v0.2.x — still evolving, API may break
- ⚠️ V2 session API is explicitly `@alpha`/`unstable` — could change or be removed
- ⚠️ SDK stores sessions in `~/.claude/projects/` (different format) — breaks current `ClaudeSessionStore` and `claude-history-replay.ts`
- ⚠️ Existing sessions in `~/.pi-web-ui/claude-sessions/` would need migration or coexistence
- ⚠️ The SDK still spawns a `claude` subprocess underneath — same binary dependency, same auth requirements
- ⚠️ New npm dependency to manage and keep updated

**What the SDK does NOT solve (still needs our own code):**
- ❌ WebSocket broadcasting to multiple subscribers
- ❌ `session_status` periodic updates to the client
- ❌ Session history replay on reconnect
- ❌ Session registry and metadata management
- ❌ Client-side state management

### Recommendation

**Do NOT migrate now.** The three fixes above (1–3) solve the immediate user-facing problems and are half a day of work. The SDK migration is a 2–3 day effort with significant risk.

**Revisit SDK migration when:**
1. The V2 session API (`unstable_v2_createSession` / `.send()` / `.stream()`) stabilizes out of `@alpha`
2. You want `canUseTool` for web UI tool approval (this is the most compelling SDK feature)
3. The NDJSON parsing in `ClaudeEventNormalizer` becomes a maintenance burden due to `claude` CLI output format changes
4. The `bypassPermissions` root restriction becomes a blocker (currently handled by `dontAsk` workaround)

**Estimated migration effort:** 2–3 days for a clean migration, plus testing. Would involve:
- Adding `@anthropic-ai/claude-agent-sdk` dependency
- Replacing `ClaudeProcessPool` with SDK `query()` calls
- Replacing `ClaudeEventNormalizer` with `SDKMessage → NormalizedEvent` adapter
- Updating or replacing `ClaudeSessionStore` for SDK's session format
- Updating `claude-history-replay.ts` for SDK session file format
- Testing session creation, multi-turn, abort, reconnect, and history replay
- Handling coexistence with existing sessions

---

## Files Modified (Fixes 1–3 ✅)

| File | Fix | Change |
|---|---|---|
| `server/src/websocket/connection.ts` | 1, 2, 3 | Added Claude status broadcasting in `setupSessionStatusBroadcasting()`, broadcast `agent_end`+errors to all subscribers in `onComplete`, broadcast abort state change to all subscribers |
| `server/tests/unit/websocket/claude-ux-fixes.test.ts` | Tests | New test file covering all three fixes + integration scenarios |
| No client changes needed | — | Client already handles `session_status` and `agent_end` correctly for any session type |

## Related Files (Reference)

| File | Purpose |
|---|---|
| `server/src/claude/claude-service.ts` | Claude session lifecycle, prompt dispatch |
| `server/src/claude/claude-process-pool.ts` | `claude -p` subprocess management |
| `server/src/claude/claude-event-normalizer.ts` | NDJSON → NormalizedEvent conversion |
| `server/src/claude/claude-session-subscribers.ts` | WebSocket client subscriber tracking |
| `server/src/claude/claude-session-store.ts` | JSONL session persistence |
| `server/src/claude/claude-history-replay.ts` | History replay on session switch |
| `server/src/websocket/connection.ts` | WebSocket handler — where all fixes go |
| `client/src/store/sessionStore.ts` | Client state — already handles events correctly |
