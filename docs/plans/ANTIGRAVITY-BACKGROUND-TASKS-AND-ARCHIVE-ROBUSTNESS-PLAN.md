# Antigravity Background Task Surfacing & Archiving Robustness Plan

**Status**: Ready for execution
**Date**: 2026-09-10
**Author**: Parent Conductor (Architect)
**Target Worker**: `pi` runtime via `zai/glm-5.3-flash` (high/max thinking)
**Contract Version**: Remains 1.39.0 (wire additions are additive / internal)

---

## 1. Executive Summary & Problem Statement

### 1.1 The Turn 10 Antigravity Behavior
In session `1e2b515d-4271-41b6-a1c6-7dd61b8b0aba` (native agy conversation `1de6598c-cbef-4bd8-bec9-937bfdbf09c1`), Turn 10 executed an automated Playwright validation test (`scratch/verify_transferred_notifications_pinning_e2e.py`).
1. **Background Tasks**: The model launched `run_command` with an asynchronous wait threshold (`WaitMsBeforeAsync: 10000`). `agy` transitioned the execution to a background process group (`task-3134`).
2. **Turn Cessation**: The model emitted a brief notification: *"I am searching for the notification ID in the server logs."* and ended its active turn.
3. **UI Blindspot**: In the Web UI, `agent_end` fired. The composer showed "Awaiting Input". There was zero indication that a background command was executing on the host.
4. **Completion Silence**: `task-3134` exited with code 0 and wrote its pass receipt into `.system_generated/messages/6cdb3728-ceb3-4cae-b0f7-b2f42e7858e1.json`. But in headless `stream-json` mode, `agy` does not autonomously re-prompt itself when a background task finishes. The turn stayed silent, leaving the user with an idle composer and uncommitted changes.

### 1.2 The Session Discovery & Archiving Flood
When `SessionWatcher` and native discovery (`Resume CLI Session` feature) were introduced, `scanNativeSessions` scanned disk paths under `/root/.pi/agent/sessions/--*--` and indexed 545 historical CLI sessions into `session-registry.json` (`origin: 'native-discovered'`).
- The Web UI derives `archivedSessionPaths` strictly from `web-ui-prefs.json`.
- Newly discovered sessions had no entry in `web-ui-prefs.json`.
- While `Sidebar.tsx` has a 30-day `recentActiveSessions` filter, sessions used within the last 25–29 days remained active, resulting in hundreds of sessions appearing active in the sidebar.
- Furthermore, `SessionCleanup.autoArchiveInactiveSessions` only runs periodically and only stamps entries idle > 30 days.

---

## 2. Measurable Victory Criteria

1. **Antigravity Background Task Surfacing in Frontend**:
   - When an Antigravity turn executes a tool that runs in the background (e.g., `run_command` with `Tool is running as a background task with task id: <id>`), the backend normalizer and service detect the background task.
   - The backend broadcasts a `background_child_state` event (matching `ChildCardProjection`) to the frontend for that session.
   - The frontend's `ChildrenStrip.tsx` renders the running background task banner above the composer (`"1 background task running"`) with its command/label.
   - When the background task completes (or when `command_status` observes completion), the background child is updated to `completed` and cleared from the active strip.

2. **Screen View & Tool Card Parity**:
   - `shared/src/screen-view.ts` and `antigravity-history-replay.ts` project Antigravity tools with their primary argument (e.g., `run_command: python3 ...` instead of an empty `run_command`).
   - `command_status`, `send_command_input`, and `wait` tool cards render properly formatted outputs in both screen-view and chat.

3. **Archiving & Native Discovery Robustness**:
   - Newly discovered historical native sessions (`origin: 'native-discovered'`) with `lastActivity` older than a configurable threshold (or by default older than 14 days) are automatically flagged or auto-archived upon discovery so they do not flood the active list.
   - `autoArchiveInactiveSessions` in `server/src/session-cleanup.ts` is verified to run safely on startup and periodic passes, ensuring no unpinned inactive sessions remain unarchived.
   - The "Archive All" operation in `Sidebar.tsx` and preferences API gracefully handles large sets (>500 sessions) without socket timeouts or partial failures.

4. **Rigorous Validation & Evidence**:
   - Unit tests covering event normalisation, screen view projection, and session cleanup.
   - Full Playwright E2E test on a disposable validation server proving that:
     1. An Antigravity background task renders the active `ChildrenStrip` banner in the UI.
     2. Native session discovery does not flood the sidebar with stale sessions.

---

## 3. Step-by-Step Implementation Phases

### Phase 1: Antigravity Background Task Detection & Normalisation (TDD)
- **Target Files**:
  - `server/src/antigravity/agy-event-normalizer.ts`
  - `server/src/antigravity/antigravity-service.ts`
  - `server/tests/unit/antigravity/agy-background-task.test.ts` (New test file)
- **Changes**:
  1. In `agy-event-normalizer.ts`:
     - Inspect `step_type: 'GENERIC'` / `step.content` for patterns matching:
       `Tool is running as a background task with task id: (?<taskId>[^\n]+)`
       `Task Description: (?<description>[^\n]+)`
     - When matched, emit a normalized event:
       ```ts
       {
         type: 'background_child_state',
         sessionId,
         children: [{
           id: taskId,
           kind: 'subagent',
           label: description || toolName,
           model: 'antigravity-task',
           status: 'running',
           task: description,
           startedAt: timestamp,
         }]
       }
       ```
  2. In `antigravity-service.ts`:
     - Track active background tasks in `ActiveSessionMeta`.
     - Forward `background_child_state` events to active WebSocket connections and API observers.
     - When `command_status` or a completion message is encountered, update child status to `'completed'` or clear it.

### Phase 2: Screen View & Replay Projection (TDD)
- **Target Files**:
  - `server/src/antigravity/antigravity-history-replay.ts`
  - `shared/src/screen-view.ts`
  - `server/tests/unit/antigravity/antigravity-history-replay.test.ts`
- **Changes**:
  1. Ensure that in `antigravity-history-replay.ts`, when a tool call has `args` (such as `CommandLine` for `run_command` or `TargetFile` for `write_to_file`), the args are fully preserved on `tool_execution_start` and `tool_execution_end`.
  2. In `shared/src/screen-view.ts`, verify that `toolPrimaryArg` extracts `CommandLine` correctly and renders:
     `run_command: <truncated command>` rather than bare `run_command`.

### Phase 3: Session Archiving & Native Discovery Hygiene (TDD)
- **Target Files**:
  - `server/src/session-cleanup.ts`
  - `server/src/routes/sessions.ts`
  - `client/src/components/Sidebar/Sidebar.tsx`
  - `server/tests/unit/session-cleanup-discovery.test.ts`
- **Changes**:
  1. In `server/src/session-cleanup.ts`:
     - Ensure `autoArchiveInactiveSessions` accurately keys native session paths (`toV2Key(sessionPath, resolver)`), correctly handling both relative paths and canonical IDs.
  2. In `client/src/components/Sidebar/Sidebar.tsx`:
     - Refine default filtering for native-discovered sessions: if a session is `origin: 'native-discovered'` and has not been explicitly opened/resumed in the Web UI, group or filter it under a dedicated "Discovered CLI Sessions" view or ensure it obeys a tighter 14-day recency cutoff unless "Show all" is checked.

### Phase 4: Full Disposable Server E2E Live Validation
- **Target Files**:
  - `scripts/verify-antigravity-background-and-archiving.py` (or TypeScript playwright runner)
- **Scenarios to Validate**:
  1. Start a disposable server (`npm run validate:server`).
  2. Resume/Switch to an Antigravity session and dispatch a command that runs in the background.
  3. Verify via Playwright that `ChildrenStrip` displays the amber background task banner while the command runs.
  4. Query `/api/v1/sessions/:id/transcript?view=screen` and verify that the command string appears in the screen view.
  5. Verify that sidebar session counts do not unexpectedly explode with stale native sessions.

### Phase 5: Verification, Commits, and Agent OS Capture
- Run `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`.
- Commit all changes directly to `master` with standard semantic commit messages.
- Prepare memory capture candidate for Agent OS.

---

## 4. Child Briefing & Execution Constraints

The child worker will be briefed with:
- **Scope Limits**:
  - Work directly on `/root/pi-web-ui`.
  - Do NOT touch other repositories (e.g. `/root/agent-os`).
  - Do NOT restart `pi-web-ui.service` on production.
- **TDD Protocol**:
  - Red tests first, implementation, green tests.
- **Handback Protocol**:
  - Provide test outputs, git diff, and confirmation that all changes are committed cleanly.
