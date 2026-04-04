# Dual-SDK Architecture Plan: Pi SDK + Claude Agent SDK

## Overview

Add Claude Agent SDK as a second runtime path alongside the existing Pi SDK in Pi Web UI. Users choose at session creation time which SDK powers the session. Both session types appear in the same unified sidebar, support background execution, and survive browser close/reopen.

**Three auth/model paths available:**
1. **Pi SDK + Anthropic OAuth** — Subscription extra use, all Pi extensions
2. **Pi SDK + GitHub Copilot** — Copilot quota (free Claude access), all Pi extensions
3. **Claude Direct (Agent SDK)** — Subscription normal quota, Claude Code's own tools/skills

**Key constraints:**
- No mid-session SDK switching (separate runtimes, incompatible session formats)
- SDK choice is made at session creation and locked for the session lifetime
- Both session types share the same sidebar, same visual treatment
- Both run permissionless (`acceptEdits` for Claude SDK)
- Both support background execution (survive browser close)

---

## Architecture Diagram

```
┌─────────────────── Pi Web UI ───────────────────────┐
│                                                      │
│  Frontend (React)                                    │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Sidebar   │  │ ChatView  │  │ Shell/Files/Git  │  │
│  │ (unified) │  │ (adapter) │  │ (shared tabs)    │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
│        │              │                              │
│        │    ┌─────────┴──────────┐                   │
│        │    │  Message Adapter   │                   │
│        │    │  (normalizes both  │                   │
│        │    │   event formats)   │                   │
│        │    └─────────┬──────────┘                   │
│        │              │                              │
├────────┼──────────────┼──────────────────────────────┤
│                                                      │
│  Server (Express + WebSocket)                        │
│  ┌──────────────────────────────────────────────┐    │
│  │          Unified Session Router               │    │
│  │  ┌─────────────────┐ ┌─────────────────────┐ │    │
│  │  │  Pi SDK Path    │ │  Claude SDK Path     │ │    │
│  │  │  (existing)     │ │  (new)               │ │    │
│  │  │                 │ │                      │ │    │
│  │  │  WorkerPool     │ │  ClaudeProcessPool   │ │    │
│  │  │  SessionWorker  │ │  ClaudeSessionWorker │ │    │
│  │  │  PiService      │ │  ClaudeService       │ │    │
│  │  │  EventNormalizer│ │  ClaudeEventNormalizr│ │    │
│  │  └─────────────────┘ └─────────────────────┘ │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Session Storage                                     │
│  ┌──────────────────────────────────────────────┐    │
│  │  ~/.pi/agent/sessions/  (Pi SDK sessions)     │    │
│  │  ~/.pi-web-ui/claude-sessions/ (Claude sess.) │    │
│  │  ~/.pi-web-ui/session-registry.json (index)   │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

---

## Modules & Tasks

### Module 0: Foundation — Shared Types & Session Registry
**Dependencies: None (start first)**
**Files to create/modify:**
- `shared/src/types.ts` — Add `SdkType = 'pi' | 'claude'` to `SessionInfo`, add `ClaudeSessionInfo`
- `server/src/session-registry.ts` — **NEW** — Unified session registry (JSON file) that indexes both Pi and Claude sessions with their SDK type, status, cwd, creation time
- `server/src/config.ts` — Add `claudeSessionDir`, `sessionRegistryPath` config values

**Details:**
```typescript
// shared/src/types.ts additions
export type SdkType = 'pi' | 'claude';

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  sdkType: SdkType;               // NEW
  parentSessionPath?: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  firstMessage: string;
  model?: string;                   // NEW - current model name for display
  claudeSessionId?: string;         // NEW - Claude Code session ID (for claude type)
}
```

The session registry is a JSON file (`~/.pi-web-ui/session-registry.json`) that acts as a unified index. It is updated by both Pi and Claude session managers. This avoids having to scan two different session directories with different formats.

**Backward compatibility:** Existing Pi sessions get `sdkType: 'pi'` when the registry is first built by scanning `~/.pi/agent/sessions/`.

---

### Module 1: Claude Service — Backend Process Manager
**Dependencies: Module 0**
**Files to create:**
- `server/src/claude/claude-service.ts` — **NEW** — Manages Claude Code subprocess lifecycle
- `server/src/claude/claude-process-pool.ts` — **NEW** — Pool of `claude -p` processes (mirrors WorkerPool pattern)
- `server/src/claude/claude-event-normalizer.ts` — **NEW** — Converts Claude `stream-json` events to `NormalizedEvent`
- `server/src/claude/claude-session-store.ts` — **NEW** — Stores Claude session metadata and message history for replay
- `server/src/claude/index.ts` — **NEW** — Barrel export

**Key design decisions:**

**Process model:** Each Claude session runs as a `claude -p` subprocess with `--output-format stream-json --verbose --permission-mode acceptEdits`. The process is spawned per prompt (not persistent like Pi workers), because `claude -p` exits after each response. Session continuity uses `--session-id` to resume.

**Process pool:** `ClaudeProcessPool` mirrors `WorkerPool` with:
- Max 10 concurrent Claude processes (configurable)
- Idle session metadata kept in memory (no subprocess when idle)
- Active process tracking per session

**Event normalization:** Claude `stream-json` produces these events that must be mapped to `NormalizedEvent`:

| Claude stream-json | NormalizedEvent type | Notes |
|---|---|---|
| `type: "system"` | `session_init` | Init with tools list, model, session_id |
| `type: "assistant"` (text block) | `message_start` + `message_update` + `message_end` | Must chunk text for streaming feel |
| `type: "assistant"` (tool_use block) | `tool_execution_start` | Tool call initiated |
| `type: "tool_result"` | `tool_execution_end` | Tool result returned |
| `type: "rate_limit_event"` | Custom `rate_limit` event | Forward quota info to frontend |
| `type: "result"` | `agent_end` | Session turn complete with usage stats |

**Message history storage:** Claude sessions store their own message log in `~/.pi-web-ui/claude-sessions/<session-id>.jsonl` — a simplified format:
```jsonl
{"type":"meta","sessionId":"...","cwd":"...","model":"...","createdAt":"..."}
{"type":"user","content":"...","timestamp":...}
{"type":"assistant","content":[...],"model":"...","usage":{...},"timestamp":...}
{"type":"tool","name":"Read","input":{...},"output":"...","timestamp":...}
```

This is our own format for replay — NOT Claude Code's internal session format.

**Subprocess invocation:**
```typescript
const proc = spawn('claude', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'acceptEdits',
  '--model', modelAlias,     // e.g. 'sonnet' or 'opus'
  '--session-id', sessionId, // resume context
  '--cwd', cwd,
], { env: { ...process.env } });  // inherits Claude Code auth from ~/.claude/
```

**Abort handling:** Send SIGTERM to the subprocess, same as Pi's abort pattern.

---

### Module 2: Unified Session Router — Server-Side Dispatch
**Dependencies: Module 0, Module 1**
**Files to modify:**
- `server/src/websocket/session-websocket.ts` — Modify `handlePrompt`, `handleSteer`, `handleAbort`, `handleSetModel` to check `sdkType` and dispatch to correct backend
- `server/src/pi/multi-session-manager.ts` — Add `sdkType` awareness; delegate Claude sessions to `ClaudeService`
- `server/src/routes/sessions.ts` — Return `sdkType` in session list; support creating Claude sessions
- `server/src/workers/event-normalizer.ts` — No changes (Pi path unchanged)

**Key changes to `session-websocket.ts`:**

```typescript
// In handlePrompt:
const sessionInfo = sessionRegistry.get(sessionPath);
if (sessionInfo?.sdkType === 'claude') {
  await this.handleClaudePrompt(message, sessionPath);
} else {
  // Existing Pi path unchanged
  await client.prompt(message.message || '', images);
}
```

**Claude-specific handlers:**
- `handleClaudePrompt` — Spawns `claude -p` subprocess, streams `stream-json` output, normalizes events, forwards via WebSocket
- `handleClaudeAbort` — Sends SIGTERM to active subprocess
- `handleClaudeSetModel` — Updates session metadata (next prompt uses new model alias)

**Model switching within Claude sessions:** Claude SDK supports `--model sonnet` / `--model opus` per invocation. Changing model mid-session just changes the flag for the next `claude -p` call. The `--session-id` preserves context regardless of model.

**What does NOT work for Claude sessions:**
- `handleSteer` — Claude `-p` doesn't support steering mid-response. Show "not supported" notification.
- `handleSetThinkingLevel` — Claude Code handles thinking internally. Map to `--model` alias if possible.
- `handleCompact` — Claude Code handles compaction automatically.

---

### Module 3: Frontend — New Session Modal & SDK Selector
**Dependencies: Module 0**
**Files to modify:**
- `client/src/components/Session/NewSessionModal.tsx` — Add SDK choice (radio/toggle)
- `client/src/store/sessionStore.ts` — Add `sdkType` to `Session` interface
- `client/src/components/Sidebar/SessionItem.tsx` — Show SDK badge (small "Pi" or "CC" indicator)
- `client/src/components/Sidebar/SessionList.tsx` — No filtering changes (unified list)

**New Session Modal changes:**

Add a toggle at the top of the modal, before folder selection:

```
┌─────────────────────────────────────┐
│  Create New Session                  │
│                                      │
│  Session Type:                       │
│  ┌─────────┐  ┌──────────────────┐  │
│  │ ● Pi SDK │  │ ○ Claude Direct  │  │
│  │ All ext. │  │ Subscription     │  │
│  │ All prov.│  │ Normal quota     │  │
│  └─────────┘  └──────────────────┘  │
│                                      │
│  [Recent Projects...]                │
│  [Folder browser...]                 │
│                                      │
│  [Cancel]  [Create Session]          │
└─────────────────────────────────────┘
```

**SDK choice details displayed:**
- **Pi SDK**: "Full extensions • All providers (Anthropic, Copilot, Kimi, Google, etc.) • Model switching"
- **Claude Direct**: "Claude subscription quota • Claude Code tools & skills • Opus/Sonnet only"

**Model selector for Claude Direct sessions:** When a Claude Direct session is active, the model selector (in header/status bar) shows only Claude models: `opus`, `sonnet`, `haiku`. These map to `--model` aliases. The existing `ModelSelector.tsx` component filters based on `sdkType`.

---

### Module 4: Frontend — Message Adapter & Chat Rendering
**Dependencies: Module 0, Module 2**
**Files to modify:**
- `client/src/lib/messageAdapter.ts` — Add Claude event type handling
- `client/src/components/Chat/MessageBubble.tsx` — Handle Claude-specific tool display
- `client/src/components/Chat/VirtualizedMessageList.tsx` — No changes (receives normalized messages)
- `client/src/components/Tools/CollapsibleToolCard.tsx` — Add Claude tool rendering (Read, Edit, Bash, WebSearch etc.)
- `client/src/components/Tools/ToolCallCard.tsx` — Map Claude tool names to existing Pi tool renderers where equivalent

**Message adapter strategy:**

The `messageAdapter.ts` file already transforms Pi events into `Message` objects for the store. Add a parallel path for Claude events:

```typescript
export function adaptClaudeEvent(event: NormalizedEvent): Message | null {
  // The server-side ClaudeEventNormalizer already converts to NormalizedEvent format
  // so most handling is the same as Pi events.
  // Only Claude-specific events need special handling.
  switch (event.type) {
    case 'rate_limit':
      // Show quota info in status bar, not as a message
      return null;
    default:
      // Use existing adapter for normalized events
      return adaptPiEvent(event);
  }
}
```

**Tool rendering:** Claude Code tools map to existing Pi tool renders:

| Claude Tool | Pi Equivalent | Renderer |
|---|---|---|
| `Read` | `read` | Existing `CollapsibleToolCard` |
| `Edit` | `edit` | Existing `EditDiff` |
| `Write` | `write` | Existing `CollapsibleToolCard` |
| `Bash` | `bash` | Existing `BashOutput` |
| `Glob` | `find` | Existing `CollapsibleToolCard` |
| `Grep` | `grep` | Existing `CollapsibleToolCard` |
| `WebSearch` | `web_search` | Existing `CollapsibleToolCard` |
| `WebFetch` | `web_fetch` | Existing `CollapsibleToolCard` |
| `Agent` | `subagent` | Existing `SubagentToolCard` (simplified) |
| `TodoWrite` | `todo` | Existing `TodoToolCard` |
| `EnterPlanMode` | N/A | New simple card: "Entered plan mode" |
| `Skill` | N/A | New simple card: show skill name + output |

**Verbosity:** The existing Kimi-style verbosity strategy in `CollapsibleToolCard` (collapsed by default, expandable, long outputs truncated) applies equally to Claude tools. No changes needed — the card receives tool name + input + output and renders accordingly.

---

### Module 5: Frontend — Status Bar & Quota Display
**Dependencies: Module 0, Module 2**
**Files to modify:**
- `client/src/components/StatusBar/StatusBar.tsx` — Show SDK type indicator, Claude quota info
- `client/src/components/Usage/ContextRing.tsx` — For Claude sessions, show usage from `result.usage`
- `client/src/store/sessionStore.ts` — Add `quotaInfo` state for Claude sessions

**Claude quota display:** From the `rate_limit_event`:
```
🟢 Subscription (normal) | Opus 4.6 | 17.7k cached
```
or if using overage:
```
🟡 Extra use | Opus 4.6 | Resets 2026-04-07
```

**Context ring for Claude:** Claude's `result.usage` provides `input_tokens`, `output_tokens`, `cache_read_input_tokens`. Display these in the existing context ring. Note: Claude doesn't expose a context window percentage in stream-json, so show raw token counts instead of a percentage ring.

---

### Module 6: Background Execution & Session Lifecycle
**Dependencies: Module 1, Module 2**
**Files to modify:**
- `server/src/pi/multi-session-manager.ts` — Handle Claude session subscribe/unsubscribe lifecycle
- `server/src/claude/claude-service.ts` — Background execution when no subscribers

**Background execution for Claude sessions:**

The key difference: Pi sessions use persistent worker processes that keep running. Claude sessions use ephemeral `claude -p` subprocesses that exit after each response.

**When browser closes:**
- **Pi sessions:** Worker process continues running. Events are buffered. On reconnect, the worker replays from where the client left off.
- **Claude sessions:** If a `claude -p` subprocess is running, it continues to completion. Events are written to our session log file. When the subprocess completes, the result is stored. On reconnect, the client replays from the log.

**15-minute idle unsubscribe:**
- **Pi sessions:** Existing behaviour — worker cleaned up after 30min idle (configurable). Session file persists on disk.
- **Claude sessions:** No running process when idle (processes are ephemeral). Session metadata and log file persist. Only in-memory session state (subscribers map, status) is cleaned up after 15min with no subscribers. Re-subscribe just reloads from log file.

**Resubscribe flow:**
1. Client opens browser, sidebar loads session list from registry
2. Client clicks a Claude session → sends `subscribe` message
3. Server loads session log from `~/.pi-web-ui/claude-sessions/<id>.jsonl`
4. Server replays messages to client (same as Pi's history replay)
5. Session is ready for new prompts

**OOM protection:**
- Claude subprocesses run in their own process (like Pi workers) — one crash doesn't affect others
- In-memory session metadata is lightweight (~5KB per session)
- Message logs are on disk, loaded only when subscribed
- Max concurrent Claude processes: 10 (configurable, separate from Pi's max 15 workers)

---

### Module 7: Session History Replay
**Dependencies: Module 1, Module 6**
**Files to create/modify:**
- `server/src/claude/claude-history-replay.ts` — **NEW** — Read Claude session log, emit as replay events
- `client/src/lib/history-replay.ts` — Add Claude session replay support (may need minimal changes if server normalizes correctly)

**Replay strategy:** When a client subscribes to a Claude session:
1. Server reads `~/.pi-web-ui/claude-sessions/<id>.jsonl`
2. Converts each entry to `NormalizedEvent` (same format as live events)
3. Sends via WebSocket as a replay batch
4. Client's existing replay handler processes them (same as Pi replay)

The key is that the server-side normalization produces identical `NormalizedEvent` format for both replay and live — so the client doesn't need to know the difference.

---

### Module 8: Shell, Files, Git Tabs — Shared Functionality
**Dependencies: Module 0**
**Files to modify:**
- `client/src/components/Shell/ShellTab.tsx` — No changes (independent of SDK)
- `client/src/components/Files/FilesTab.tsx` — No changes (independent of SDK)  
- `client/src/components/Git/GitTab.tsx` — No changes (independent of SDK)

**Analysis:** The Shell, Files, and Git tabs operate independently of the AI session. They use the terminal WebSocket (`/ws/terminal`), the files REST API (`/api/files`), and the git REST API (`/api/git`) respectively. None of these depend on the SDK type. They work with both Pi and Claude sessions.

**No changes needed for this module.** Listing it explicitly to confirm it was considered.

---

### Module 9: Testing — Unit Tests
**Dependencies: Modules 0-7**

**New test files to create:**

| Test File | Tests | Depends On |
|---|---|---|
| `server/tests/unit/session-registry.test.ts` | Registry CRUD, persistence, backward compat | Module 0 |
| `server/tests/unit/claude/claude-service.test.ts` | Process spawn, abort, session management | Module 1 |
| `server/tests/unit/claude/claude-process-pool.test.ts` | Pool limits, concurrent process tracking | Module 1 |
| `server/tests/unit/claude/claude-event-normalizer.test.ts` | All event type mappings, edge cases | Module 1 |
| `server/tests/unit/claude/claude-session-store.test.ts` | JSONL read/write, replay | Module 1 |
| `server/tests/unit/claude/claude-history-replay.test.ts` | Replay ordering, partial sessions | Module 7 |
| `server/tests/unit/websocket/session-websocket-claude.test.ts` | Claude dispatch in router | Module 2 |
| `client/tests/unit/store/sessionStore-dual.test.ts` | sdkType filtering, model selector | Module 3 |
| `shared/src/types-dual.test.ts` | Type guards for SdkType | Module 0 |

**Existing test files to update:**

| Test File | Changes |
|---|---|
| `server/tests/unit/routes/sessions.test.ts` | Add tests for Claude session creation, listing with sdkType |
| `server/tests/unit/pi/multi-session-manager.test.ts` | Add tests for Claude session lifecycle |
| `server/tests/unit/websocket/session-websocket.test.ts` | Add tests for Claude dispatch |
| `server/tests/unit/workers/event-normalizer.test.ts` | Verify Pi events still normalized correctly (regression) |
| `client/tests/unit/store/sessionStore.test.ts` | Add sdkType to test fixtures |
| `client/tests/unit/lib/history-replay.test.ts` | Add Claude replay test cases |
| `shared/src/protocol-types.test.ts` | Add dual-SDK message types |

**Mocking strategy for Claude tests:**
- Mock `child_process.spawn` to simulate `claude -p` subprocess
- Provide canned `stream-json` output fixtures (captured from real Claude runs)
- Test event normalizer with real stream-json samples

---

### Module 10: Testing — E2E / Playwright Tests
**Dependencies: Modules 0-8**

**New E2E test files:**

| Test File | Tests |
|---|---|
| `tests/e2e/dual-sdk-session-creation.spec.ts` | Create Pi session, create Claude session, verify sidebar shows both with correct badges |
| `tests/e2e/claude-session-chat.spec.ts` | Create Claude session → send prompt → verify response renders → verify tool cards display |
| `tests/e2e/session-persistence.spec.ts` | Create sessions of both types → close browser → reopen → verify both sessions listed → resubscribe → verify history replay |
| `tests/e2e/claude-model-switching.spec.ts` | Create Claude session → switch from Opus to Sonnet → send prompt → verify model used |
| `tests/e2e/claude-abort.spec.ts` | Start Claude prompt → abort → verify graceful stop |
| `tests/e2e/background-execution.spec.ts` | Start long prompt → disconnect → reconnect → verify result arrived |

**Playwright test approach (using webapp-testing skill):**
- Tests run against the live Web UI at `http://localhost:3456`
- Use `page.waitForSelector` to verify Claude-specific UI elements (SDK badge, quota display)
- Use `page.evaluate` to check store state for sdkType
- Claude tests require Claude Code to be installed and authenticated (CI consideration)

**CI consideration:** Claude SDK tests require a real Claude Code installation with subscription auth. For CI, these tests should be marked with `test.skip` unless `CLAUDE_AUTH_AVAILABLE=true` env var is set. Pi SDK tests can use mock responses.

---

### Module 11: Documentation — README Updates
**Dependencies: All modules (do last)**
**Files to modify:**
- `/root/pi-web-ui/README.md` — Add Dual-SDK Architecture section
- `/root/pi-web-ui/AGENTS.md` — Update agent instructions with dual-SDK awareness

**README additions:**

```markdown
## Dual-SDK Architecture (April 2026)

Pi Web UI supports two AI runtime paths:

### Pi SDK Sessions
- Uses Pi Coding Agent's SDK for AI interaction
- All Pi extensions active (Enhanced Plan Mode, Subagent, Todo, Web Tools, etc.)
- Supports all providers: Anthropic, GitHub Copilot, Google, Kimi, OpenRouter, etc.
- Full model switching mid-session
- Session files: `~/.pi/agent/sessions/`

### Claude Direct Sessions  
- Uses Claude Agent SDK (`claude -p` subprocess) for AI interaction
- Uses Claude Code's built-in tools (Read, Edit, Bash, WebSearch, Plan mode, Skills, etc.)
- Claude subscription normal quota (not extra use)
- Claude models only (Opus, Sonnet, Haiku)
- Model switching between Claude models
- Session files: `~/.pi-web-ui/claude-sessions/`
- Permissionless: `--permission-mode acceptEdits`

### Session Registry
Both session types are indexed in `~/.pi-web-ui/session-registry.json` for unified listing.

### Choosing Between SDKs
| Criteria | Pi SDK | Claude Direct |
|---|---|---|
| Need Pi extensions | ✅ | ❌ |
| Need non-Claude models | ✅ | ❌ |
| Want normal subscription quota | Via Copilot | ✅ |
| Need mid-session model switching (cross-provider) | ✅ | ❌ |
| Want Claude Code's native skills | ❌ | ✅ |

### For Developers
- Server dispatch: `session-websocket.ts` checks `sdkType` from session registry
- Claude backend: `server/src/claude/` — process management, event normalization
- Event normalization: Both SDKs produce `NormalizedEvent` — frontend is SDK-agnostic
- Session registry: `server/src/session-registry.ts` — unified index
```

---

## Dependency Graph & Parallelization

```
Module 0 (Foundation)
    │
    ├──────────────────┬──────────────────┐
    ▼                  ▼                  ▼
Module 1           Module 3           Module 8
(Claude Service)   (Frontend Modal)   (Tabs - no changes)
    │                  │
    ▼                  ▼
Module 2           Module 4
(Session Router)   (Message Adapter)
    │                  │
    ├──────┬───────────┤
    ▼      ▼           ▼
Module 5  Module 6   Module 7
(Status)  (Lifecycle) (Replay)
    │      │           │
    └──────┴───────────┘
           │
           ▼
      Module 9 (Unit Tests)
           │
           ▼
      Module 10 (E2E Tests)
           │
           ▼
      Module 11 (Documentation)
```

**Maximum parallelization:**

| Phase | Modules | Can Run In Parallel |
|---|---|---|
| **Phase 1** | 0 | Single (foundation for everything) |
| **Phase 2** | 1, 3, 8 | ✅ All three in parallel |
| **Phase 3** | 2, 4 | ✅ Both in parallel (2 needs 1; 4 needs 3; no cross-deps) |
| **Phase 4** | 5, 6, 7 | ✅ All three in parallel |
| **Phase 5** | 9 | Single (tests reference all modules) |
| **Phase 6** | 10 | Single (E2E needs everything built) |
| **Phase 7** | 11 | Single (docs finalized last) |

---

## Git Strategy

**Single branch:** All work happens on the `main` branch of `/root/pi-web-ui`.

**Commit convention:** One commit per module completion, with descriptive messages:
```
feat(dual-sdk): Module 0 - foundation types and session registry
feat(dual-sdk): Module 1 - Claude service and process pool
feat(dual-sdk): Module 3 - SDK selector in NewSessionModal
feat(dual-sdk): Module 2 - unified session router dispatch
feat(dual-sdk): Module 4 - message adapter and Claude tool rendering
feat(dual-sdk): Module 5 - status bar quota display
feat(dual-sdk): Module 6 - background execution and lifecycle
feat(dual-sdk): Module 7 - session history replay for Claude
test(dual-sdk): Module 9 - unit tests
test(dual-sdk): Module 10 - E2E Playwright tests
docs(dual-sdk): Module 11 - README and AGENTS.md updates
```

**Agents executing the plan** should use their own git branch/worktree strategy as appropriate. The commit messages above are for merging into main.

**No breaking changes:** The existing Pi SDK path is never modified in a breaking way. All new code is additive. If an agent needs to refactor shared code, it must ensure Pi path regression tests pass.

---

## Edge Cases & Risk Mitigation

### Edge Case 1: Claude Code Not Installed
- **Detection:** Check `which claude` on startup
- **Behaviour:** If not found, hide "Claude Direct" option in NewSessionModal, log warning
- **Test:** Unit test for detection + UI test for hidden option

### Edge Case 2: Claude Code Not Authenticated
- **Detection:** Run `claude auth status --output-format json` on startup
- **Behaviour:** If not logged in, show "Claude Direct" as disabled with tooltip "Claude Code not authenticated — run `claude auth login`"
- **Test:** Unit test with mock auth status

### Edge Case 3: Claude Process Crash Mid-Response
- **Detection:** Subprocess exit code ≠ 0
- **Behaviour:** Emit error event to client, mark session as errored, log details
- **Recovery:** User can retry by sending another prompt (new subprocess)
- **Test:** Unit test with mock process crash

### Edge Case 4: Concurrent Claude Processes Exceed Limit
- **Detection:** `ClaudeProcessPool` checks count before spawn
- **Behaviour:** Queue the prompt, show "waiting for available slot" in UI
- **Alternative:** Return error "Maximum concurrent Claude sessions reached"
- **Test:** Unit test for pool limits

### Edge Case 5: Session Registry Corruption
- **Detection:** JSON parse error on load
- **Behaviour:** Rebuild from scanning both session directories
- **Test:** Unit test with corrupted file

### Edge Case 6: Claude Rate Limit / Overloaded
- **Detection:** `rate_limit_event` with `status: "blocked"` or subprocess error
- **Behaviour:** Show rate limit info to user, auto-retry after delay (like Pi's retry logic)
- **Test:** Unit test with rate-limited stream-json output

### Edge Case 7: Very Large Claude Response
- **Detection:** `stream-json` messages with large tool outputs
- **Behaviour:** Apply same truncation as Pi path (50KB/2000 line limit in tool cards)
- **Test:** E2E test with large file read

### Edge Case 8: Browser Reconnect During Active Claude Process
- **Detection:** Client sends subscribe for session with running subprocess
- **Behaviour:** Attach to existing subprocess's event stream, replay buffered events
- **Test:** E2E test: start prompt → disconnect → reconnect

### Edge Case 9: Model Selector Shows Wrong Models
- **Detection:** Claude session active but Pi models shown (or vice versa)
- **Behaviour:** `ModelSelector.tsx` reads `sdkType` from current session and filters
- **Pi models:** All from `modelRegistry.getAvailable()`
- **Claude models:** Hardcoded list: `opus`, `sonnet`, `haiku` (+ version variants from `claude --help`)
- **Test:** Unit test for model filtering

### Edge Case 10: Slash Commands Conflict
- **Existing Pi commands:** `/compact`, `/plan`, `/approve`, `/a`, `/modify`, `/m`, `/todos`, `/worktrees`, `/orchestrate`, `/merge`, `/abort-worktree`, `/webtools-clear-cache`
- **Claude Code built-in commands:** `/compact`, `/context`, `/cost`, `/init`, `/review`, `/security-review`, `/extra-usage`, `/insights`, plus 115+ skill commands
- **Conflict:** `/compact` exists in both
- **Resolution:** For Claude sessions, slash commands are forwarded as text to `claude -p` which handles them natively. The frontend's `SlashPalette` loads different command lists based on `sdkType`. No naming conflict because commands are dispatched to different runtimes.

---

## Preserving Existing Investments

The following features from past commits are explicitly preserved:

| Feature | Commits | How Preserved |
|---|---|---|
| **Verbosity redesign** | `185392c` (Phase 1B) | `CollapsibleToolCard` unchanged; Claude tools use same card |
| **SDK input filtering** | `185392c`, `de0c330` | Pi path completely unchanged; Claude path gets own filtering |
| **Process-per-session / OOM** | `4cc5ab8` → `82cd723` | Pi WorkerPool unchanged; Claude gets separate `ClaudeProcessPool` |
| **Tab navigation** | `59ac3d3` → `3334846` | Shell/Files/Git tabs are SDK-independent |
| **Session persistence** | `bbc6d14`, `5de9142`, `66e6c5b` | Pi sessions unchanged; Claude sessions get parallel persistence |
| **Lazy backend sessions** | `7eeb60f` | Existing lazy loading preserved; Claude sessions also lazy-loaded |
| **Mobile improvements** | `bb71dff`, `16cca9d`, `967eb97` | All UI preserved; SDK selector designed mobile-friendly |
| **Worker crash monitoring** | `17e65a6`, `ebc567e` | Pi workers unchanged; Claude processes get own crash logging |
| **Context ring** | `eea739b` | Shows Pi token stats or Claude usage stats based on session type |

---

## Summary of All Files Changed/Created

### New Files (17)
```
server/src/session-registry.ts
server/src/claude/index.ts
server/src/claude/claude-service.ts
server/src/claude/claude-process-pool.ts
server/src/claude/claude-event-normalizer.ts
server/src/claude/claude-session-store.ts
server/src/claude/claude-history-replay.ts
server/tests/unit/session-registry.test.ts
server/tests/unit/claude/claude-service.test.ts
server/tests/unit/claude/claude-process-pool.test.ts
server/tests/unit/claude/claude-event-normalizer.test.ts
server/tests/unit/claude/claude-session-store.test.ts
server/tests/unit/claude/claude-history-replay.test.ts
server/tests/unit/websocket/session-websocket-claude.test.ts
tests/e2e/dual-sdk-session-creation.spec.ts
tests/e2e/claude-session-chat.spec.ts
tests/e2e/session-persistence.spec.ts
```

### Modified Files (16)
```
shared/src/types.ts
server/src/config.ts
server/src/websocket/session-websocket.ts
server/src/pi/multi-session-manager.ts
server/src/routes/sessions.ts
client/src/components/Session/NewSessionModal.tsx
client/src/components/Sidebar/SessionItem.tsx
client/src/components/Settings/ModelSelector.tsx
client/src/components/StatusBar/StatusBar.tsx
client/src/components/Chat/MessageBubble.tsx
client/src/components/Tools/CollapsibleToolCard.tsx
client/src/lib/messageAdapter.ts
client/src/store/sessionStore.ts
server/tests/unit/routes/sessions.test.ts
README.md
AGENTS.md
```

---

## Estimated Effort

| Phase | Modules | Estimated Lines | Parallel Agents |
|---|---|---|---|
| Phase 1 | 0 | ~200 | 1 |
| Phase 2 | 1, 3, 8 | ~800, ~150, 0 | 3 |
| Phase 3 | 2, 4 | ~300, ~200 | 2 |
| Phase 4 | 5, 6, 7 | ~100, ~250, ~150 | 3 |
| Phase 5 | 9 | ~600 | 1-2 |
| Phase 6 | 10 | ~300 | 1 |
| Phase 7 | 11 | ~150 | 1 |
| **Total** | | **~3,100** | |

---

## Appendix A: Claude `stream-json` Format Reference

Agents implementing Module 1 (ClaudeEventNormalizer) MUST understand the exact JSON format that `claude -p --output-format stream-json --verbose` produces. Real captured fixtures are at `/root/pi-web-ui/fixtures/`.

### Event Sequence (Tool Use Turn)

```
1. {"type":"system"} — Init: session_id, tools[], model, cwd, permissionMode
2. {"type":"assistant"} — Claude's response with content[]: [{type:"tool_use", id, name, input}]
3. {"type":"rate_limit_event"} — Quota: isUsingOverage, rateLimitType, resetsAt
4. {"type":"user"} — Tool result: content[{type:"tool_result", content, is_error, tool_use_id}]
5. {"type":"assistant"} — Claude's follow-up with content[]: [{type:"text", text}]
6. {"type":"result"} — Final: result text, usage stats, total_cost_usd, session_id
```

### Critical Field Mappings for ClaudeEventNormalizer

**Tool call** (from `type:"assistant"` with `tool_use` content):
```typescript
// Claude stream-json:
assistant.message.content[i] = {
  type: "tool_use",
  id: "toolu_01YCKD3ZXHu5ZEwpav2EgZDX",
  name: "Read",
  input: { file_path: "/tmp/file.txt" }
}

// Must emit as NormalizedEvent:
{
  type: "tool_execution_start",
  timestamp: Date.now(),
  data: {
    toolCallId: "toolu_01YCKD3ZXHu5ZEwpav2EgZDX",
    toolName: "Read",
    args: { file_path: "/tmp/file.txt" }
  }
}
```

**Tool result** (from `type:"user"` with `tool_result` content):
```typescript
// Claude stream-json:
user.message.content[i] = {
  type: "tool_result",
  content: "hello fixture",
  is_error: false,
  tool_use_id: "toolu_01YCKD3ZXHu5ZEwpav2EgZDX"
}

// Must emit as NormalizedEvent:
{
  type: "tool_execution_end",
  timestamp: Date.now(),
  data: {
    toolCallId: "toolu_01YCKD3ZXHu5ZEwpav2EgZDX",
    result: { content: [{ type: "text", text: "hello fixture" }] },
    isError: false
  }
}
```

**Text response** (from `type:"assistant"` with `text` content):
```typescript
// Claude stream-json:
assistant.message.content[i] = { type: "text", text: "The file contains: hello" }
assistant.message.id = "msg_01UMHp614MMq1a3p9xcfeEqE"

// Must emit 3 NormalizedEvents:
{ type: "message_start", data: { id: "msg_01UMHp...", role: "assistant" } }
{ type: "message_update", data: { id: "msg_01UMHp...", assistantMessageEvent: { type: "text_delta", delta: "The file contains: hello" } } }
{ type: "message_end", data: { id: "msg_01UMHp..." } }
```

**Note:** Claude `stream-json` delivers complete messages, not token-by-token deltas. To provide a streaming feel, the normalizer should chunk text into smaller pieces with small delays, or emit the full text as a single `text_delta` (simpler, less smooth).

---

## Appendix B: Web UI Internal Event Flow Reference

Agents implementing Modules 2, 4, 6, 7 need to understand how events flow through the system.

### Current Pi SDK Event Flow

```
Pi AgentSession
  → emits AgentSessionEvent (tool_execution_start, message_start, etc.)
  → WorkerPool.SessionWorker captures via RPC bridge
  → EventNormalizer converts to NormalizedEvent { type, sessionId, timestamp, data }
  → session-websocket.ts sends via WebSocket as SessionEventEnvelope:
    { type: "session_event", sessionId: "...", event: NormalizedEvent }
  → Frontend sessionStore.ts switch(event.type) processes each type
```

### NormalizedEvent Interface (from shared/src/protocol-types.ts)

```typescript
export interface NormalizedEvent {
  type: string;        // "message_start" | "message_update" | "message_end" |
                       // "tool_execution_start" | "tool_execution_update" | "tool_execution_end" |
                       // "agent_start" | "agent_end" | "error" | etc.
  sessionId?: string;
  timestamp: number;
  data: unknown;       // Shape depends on type — see sessionStore.ts switch cases
}
```

### Frontend Event Consumption (sessionStore.ts)

The frontend expects these `data` shapes for each event type:

| Event Type | `data` Shape | Frontend Action |
|---|---|---|
| `message_start` | `{ id: string, role: "user"\|"assistant", content?: unknown }` | Creates new Message in store |
| `message_update` | `{ id: string, assistantMessageEvent: { type: "text_delta"\|"thinking_delta", delta: string } }` | Appends delta to existing message |
| `message_end` | `{ id: string }` | Updates cache metadata |
| `tool_execution_start` | `{ toolCallId: string, toolName: string, args: unknown }` | Creates tool Message with `toolCall` field |
| `tool_execution_update` | `{ toolCallId: string, partialResult: { content: [{ type: "text", text: string }] } }` | Updates tool message content |
| `tool_execution_end` | `{ toolCallId: string, result: ..., isError: boolean }` | Finalizes tool message with `toolResult` |
| `agent_start` | `{}` | Sets `isStreaming: true` |
| `agent_end` | `{}` | Sets `isStreaming: false` |

### Session Creation Flow

```
Frontend: useWebSocket().createNewSession(cwd)
  → sends WebSocket: { type: "new_session", cwd: "/root/project" }
  → Server session-websocket.ts handleNewSession()
  → creates Pi session via MultiSessionManager
  → responds with session info
  → Frontend adds to session list
```

For Claude Direct, this flow must be extended:
```
Frontend: useWebSocket().createNewSession(cwd, sdkType: "claude")
  → sends WebSocket: { type: "new_session", cwd: "/root/project", sdkType: "claude" }
  → Server checks sdkType → creates Claude session via ClaudeService
  → registers in session-registry.json
  → responds with session info (including sdkType)
```

---

## Appendix C: Claude CLI Flags Reference

Agents implementing Module 1 (subprocess invocation) need these exact flags:

```bash
# Full invocation for a Claude Direct session prompt:
claude -p "<user prompt>" \
  --output-format stream-json \
  --verbose \
  --permission-mode acceptEdits \
  --model <alias> \
  --session-id <uuid> \
  --cwd <working-directory>

# Model aliases (short forms):
#   opus, sonnet, haiku
#   Or full IDs: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5

# Check if Claude Code is installed and authenticated:
which claude          # Returns path or exit 1
claude auth status    # Returns JSON with loggedIn, subscriptionType

# The --session-id flag resumes an existing Claude Code session.
# If the session doesn't exist yet, Claude creates it.
# This is how multi-turn conversations work across separate -p invocations.

# IMPORTANT: --dangerously-skip-permissions does NOT work as root.
# Use --permission-mode acceptEdits instead (works as root, within cwd).

# stream-json + verbose is REQUIRED for tool call visibility.
# Without --verbose, stream-json is rejected for -p mode.
```

---

## Appendix D: Key Existing Files to Read Before Each Module

Agents SHOULD read these files before starting their assigned module:

### Module 0
- `shared/src/types.ts` — Current SessionInfo, Message types
- `shared/src/protocol-types.ts` — NormalizedEvent, InternalCommand
- `server/src/config.ts` — Current config shape

### Module 1
- `server/src/workers/worker-pool.ts` — Pattern to mirror for ClaudeProcessPool
- `server/src/workers/session-worker.ts` — Pattern to mirror for subprocess management
- `server/src/workers/event-normalizer.ts` — Pattern to mirror for ClaudeEventNormalizer
- `fixtures/claude-stream-json-with-tool.jsonl` — Real Claude output to normalize
- `fixtures/claude-stream-json-text-only.jsonl` — Simple text response
- Skill `claude-sdk` at `/root/.skills-global/skills-global/claude-sdk/SKILL.md`

### Module 2
- `server/src/websocket/session-websocket.ts` — Current dispatch (handlePrompt, handleAbort, handleSetModel)
- `server/src/pi/multi-session-manager.ts` — Session lifecycle management
- `server/src/routes/sessions.ts` — REST API for session listing

### Module 3
- `client/src/components/Session/NewSessionModal.tsx` — Current modal (full file)
- `client/src/hooks/useWebSocket.ts` — createNewSession function
- `client/src/store/sessionStore.ts` — Session interface, store shape
- `client/src/components/Sidebar/SessionItem.tsx` — Session rendering

### Module 4
- `client/src/store/sessionStore.ts` — Event handling switch cases (search for `case 'message_start'`)
- `client/src/lib/messageAdapter.ts` — Current adapter
- `client/src/components/Tools/CollapsibleToolCard.tsx` — Tool card rendering
- `client/src/components/Chat/MessageBubble.tsx` — Message routing to tool cards

### Module 5
- `client/src/components/StatusBar/StatusBar.tsx`
- `client/src/components/Usage/ContextRing.tsx`

### Module 6
- `server/src/pi/multi-session-manager.ts` — Full file (subscribe/unsubscribe, idle cleanup)
- `server/src/workers/worker-pool.ts` — Cleanup patterns

### Module 7
- `client/src/lib/history-replay.ts` — Current replay implementation
- `server/src/pi/event-forwarder.ts` — How Pi events are forwarded

### Module 9-10
- All test files listed in the module descriptions
- `playwright.config.ts` — E2E test configuration
- `tests/e2e/core.spec.ts` — Pattern for E2E tests (login flow, selectors)
