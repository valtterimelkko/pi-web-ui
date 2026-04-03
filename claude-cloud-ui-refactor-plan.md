# Pi Web UI Refactor Plan: Tab Navigation, Shell, Git, Files, Verbosity Redesign

## Context

The Pi Web UI has a mature, battle-tested backend (process-per-session workers, JSON-RPC 2.0, ref-based streaming, LRU caching, OOM prevention). The frontend currently renders only a Chat view. This refactor adds tab-based navigation (Shell, Files, Git, Tasks placeholder), improves tool verbosity display, shifts the color palette to white/blue, and enhances the status bar -- all while preserving the entire backend architecture.

**Benchmark**: [Claude Code UI](https://github.com/siteboon/claudecodeui) -- inspected full source + screenshots.

**Key Decisions (confirmed with user)**:
- Shell: Full PTY terminal via node-pty + xterm.js
- Git: Full git panel (status, stage, commit, push/pull, branches, diff, log)
- Verbosity: Hybrid -- keep inline primary param + status in header, adopt cleaner expand/collapse for details
- Tab strategy: Keep all visited tabs mounted but hidden (CSS visibility) for instant switching
- Desktop layout: Integrated single header row (session info left, tab nav right)
- Status bar: Keep current layout + add context ring visualization, NO permission mode indicator
- Theme: Shift from light/teal to white/blue
- Tasks tab: Placeholder only (future work)
- Backend/models/auth: NO changes to existing architecture

---

## Dependency Graph

```
Phase 0: Foundation (shared types, nav store, layout shell)
   |
   ├── Phase 1A: Tab Navigation + Layout  ──────────┐
   ├── Phase 1B: Verbosity Redesign (parallel w/ 1A) │
   ├── Phase 1C: Theme Shift (parallel w/ 1A, 1B)    │
   │                                                   │
   ├── Phase 2A: Shell Backend (parallel w/ 1*)       │
   ├── Phase 2B: Git Backend (parallel w/ 1*, 2A)     │
   ├── Phase 2C: Files Backend (parallel w/ 1*, 2A/B) │
   │                                                   │
   ├── Phase 3A: Shell Frontend (needs 1A + 2A)       │
   ├── Phase 3B: Git Frontend (needs 1A + 2B)         │
   ├── Phase 3C: Files Frontend (needs 1A + 2C)       │
   │                                                   │
   ├── Phase 4: Status Bar + Context Ring (needs 1A)  │
   │                                                   │
   └── Phase 5: Integration + E2E Tests (needs all)   │
```

**Max parallelism**: Phase 0 first, then up to 6 agents in parallel (1A, 1B, 1C, 2A, 2B, 2C), then 3 agents (3A, 3B, 3C), then Phase 4, then Phase 5.

---

## Phase 0: Foundation Layer

**Goal**: Scaffolding that all phases depend on. No visible UI changes.

### 0.1: Navigation Store
**New file**: `client/src/store/navigationStore.ts`
```
- activeTab: 'chat' | 'shell' | 'files' | 'git' | 'tasks'
- setActiveTab(tab)
- isMobile: boolean (from window.matchMedia)
- Persist activeTab in localStorage per session
```
**Modify**: `client/src/store/index.ts` -- add export

### 0.2: Shared Types
**Modify**: `shared/src/protocol-types.ts`
- Add: `GitStatus`, `GitBranch`, `GitDiff`, `GitLogEntry`
- Add: `TerminalSessionInfo`
- Add: `FileEntry` (with modifiedAt, size, isDirectory, isSymlink)

### 0.3: Layout Shell Component
**New file**: `client/src/components/Layout/AppShell.tsx`
- Replaces the inline layout in `AuthenticatedApp` (App.tsx:84-99)
- Renders: Sidebar | IntegratedHeader + TabContent area
- Manages mounted-but-hidden tab strategy

**New file**: `client/src/components/Layout/index.ts`

**Modify**: `client/src/App.tsx` -- `AuthenticatedApp` renders `<AppShell>` instead of inline `<Sidebar>` + `<ChatView>`

### Tests
- `client/tests/unit/store/navigationStore.test.ts`
- `client/tests/unit/components/Layout/AppShell.test.tsx`

---

## Phase 1A: Tab Navigation System

**Depends on**: Phase 0

### 1A.1: Integrated Header Bar (Desktop)
**New file**: `client/src/components/Navigation/IntegratedHeader.tsx`
- Single row: session name dropdown (left) | Tab pills: Chat|Shell|Files|Git|Tasks (right)
- Icons from lucide-react: MessageSquare, Terminal, FolderOpen, GitBranch, ListTodo
- Tasks pill shows "Soon" mini-badge
- Active tab has blue underline/highlight
- Hidden below `md` breakpoint

### 1A.2: Mobile Bottom Navigation
**New file**: `client/src/components/Navigation/BottomNav.tsx`
- Fixed bottom bar (visible below `md` breakpoint)
- 5 icons: Chat, Shell, Files, Git, More (...)
- More opens popover with Tasks
- Active state: filled icon + label
- Safe area padding: `pb-[env(safe-area-inset-bottom)]`
- Hides when keyboard is open (input focus detection)

### 1A.3: Tab Content Container
**New file**: `client/src/components/Navigation/TabContent.tsx`
- Renders all visited tabs, hides inactive via `visibility: hidden` + `position: absolute`
- Active tab: `visibility: visible` + `position: relative`
- Chat tab always mounted
- Other tabs mounted on first visit, then kept

### 1A.4: Placeholder Tab Components
- `client/src/components/Shell/ShellTab.tsx` -- "Shell loading..." (replaced in Phase 3A)
- `client/src/components/Git/GitTab.tsx` -- "Git panel loading..." (replaced in Phase 3B)
- `client/src/components/Tasks/TasksPlaceholder.tsx` -- "Tasks coming soon. Use /todos in chat."

### 1A.5: Sidebar Integration
**Modify**: `client/src/components/Sidebar/Sidebar.tsx`
- On mobile: dismiss sidebar when switching tabs
- Keep sidebar independent of tab system

**Modify**: `client/src/components/Chat/ChatView.tsx`
- Remove header bar (moved to IntegratedHeader)
- ChatView becomes content-only (messages + input)
- Settings button moves to IntegratedHeader or sidebar

### Tests
- `client/tests/unit/components/Navigation/IntegratedHeader.test.tsx`
- `client/tests/unit/components/Navigation/BottomNav.test.tsx`
- `client/tests/unit/components/Navigation/TabContent.test.tsx`

**Checkpoint**: Run full client test suite after this phase.

---

## Phase 1B: Verbosity Redesign (Hybrid Approach)

**Depends on**: Phase 0 | **Parallel with**: 1A, 1C

### 1B.1: Redesign CollapsibleToolCard
**Modify**: `client/src/components/Tools/CollapsibleToolCard.tsx` (678 lines)

**Header changes** (collapsed state):
- Current: `[>] [icon] Read  /path/to/file  ✓ Loaded • 42 lines`
- New: `[icon] Using Read  /path/to/file  ✓ 42 lines  [>]`
- Keep inline primary param + brief status (hybrid decision)
- Move chevron to right side
- Use blue icon for in-progress, green check for success, red X for error
- Spinner replaces icon during pending state
- "Using {displayName}" prefix in header text

**Expanded state changes**:
- Section 1: "View input parameters" with chevron -- collapsed by default
- Section 2: "Tool Result" with green/red icon -- collapsed by default
- Both sections have independent expand/collapse
- Cleaner borders and spacing between sections
- Remove the combined arguments+result single-expand pattern

**Keep unchanged**:
- `BRIEF_ONLY_TOOLS` list and logic
- `parseTodoOutput`, `parseReadOutput` summary helpers
- `startTime` elapsed timer for long-running tools
- Error tool cards auto-expand result section

### 1B.2: Add "Expand all" at message level
**Modify**: `client/src/components/Chat/MessageBubble.tsx`
- When message has 3+ tool calls, add small "Expand all / Collapse all" toggle
- Controls all tool cards within that message

### Tests
- **Modify**: `client/tests/unit/components/Tools/CollapsibleToolCard.test.tsx`
  - Update expected text patterns ("Using Read" vs "Read")
  - Test both sections start collapsed
  - Test independent expand/collapse
  - Test error auto-expand
  - Test streaming spinner state

**Checkpoint**: Run full client test suite. Manually verify tool display with `webapp-testing` skill.

---

## Phase 1C: Theme Shift (White/Blue)

**Depends on**: Phase 0 | **Parallel with**: 1A, 1B

### 1C.1: Update Tailwind Config
**Modify**: `client/tailwind.config.js`
- Update primary color from teal to blue (blue-500/blue-600 as primary)
- Ensure dark mode still works (existing dark classes)

### 1C.2: Update Component Colors
Files to modify (search-and-replace teal with blue):
- `client/src/components/Sidebar/Sidebar.tsx` -- accent colors
- `client/src/components/Sidebar/SessionItem.tsx` -- active session highlight
- `client/src/components/Chat/ChatView.tsx` -- header accents
- `client/src/components/Chat/MessageInput.tsx` -- send button, accents
- `client/src/components/Chat/MessageBubble.tsx` -- user message bubble
- `client/src/components/Settings/ModelSelector.tsx` -- selection highlights
- `client/src/components/Auth/LoginForm.tsx` -- login button
- Any component using `teal-*`, `violet-*` classes -> `blue-*`

### 1C.3: Background Updates
- Main bg: `bg-white` (keep) / `dark:bg-gray-950` (keep)
- Cards: `bg-gray-50` instead of `bg-slate-50`
- Sidebar: clean white with subtle border
- Tool cards: white bg with light gray border

### Tests
- Visual regression check with `webapp-testing` skill
- All existing component tests should still pass (colors don't affect test logic)

---

## Phase 2A: Shell Tab Backend

**Depends on**: Phase 0 | **Parallel with**: 1A-1C, 2B, 2C

### 2A.1: Install node-pty
**Modify**: `server/package.json` -- add `node-pty` (or `node-pty-prebuilt-multiarch` as fallback)

### 2A.2: Terminal Manager
**New file**: `server/src/terminal/terminal-manager.ts`
```typescript
class TerminalManager {
  private terminals: Map<string, IPty>  // clientId -> pty
  create(clientId: string, cwd: string, cols: number, rows: number): TerminalSessionInfo
  write(clientId: string, data: string): void
  resize(clientId: string, cols: number, rows: number): void
  destroy(clientId: string): void
  destroyAll(): void  // cleanup on shutdown
}
```
- Max 1 terminal per client connection
- Idle timeout: 30 minutes
- Shell: `process.env.SHELL || '/bin/bash'`
- CWD: session's working directory

### 2A.3: Terminal WebSocket Endpoint
**New file**: `server/src/terminal/terminal-websocket.ts`
- Upgrade handler for `/ws/terminal/:clientId`
- Cookie auth (same as session WebSocket)
- Binary frames for terminal I/O
- JSON frames for control: `{ type: 'resize', cols, rows }`, `{ type: 'create', cwd }`
- Forward PTY output -> WebSocket, WebSocket input -> PTY stdin

**Modify**: `server/src/index.ts` -- add terminal WebSocket upgrade handler alongside session WebSocket

### 2A.4: Terminal REST Endpoints (optional, for status)
**New file**: `server/src/routes/terminal.ts`
- `GET /api/terminal/status` -- list active terminals
- `DELETE /api/terminal/:clientId` -- force kill terminal

**Modify**: `server/src/app.ts` -- mount `/api/terminal`

### Tests
- `server/tests/unit/terminal/terminal-manager.test.ts` -- create, write, resize, destroy, idle cleanup, max terminals
- `server/tests/unit/terminal/terminal-websocket.test.ts` -- auth, data relay
- `server/tests/unit/routes/terminal.test.ts`

**Checkpoint**: Run server test suite.

---

## Phase 2B: Git Tab Backend

**Depends on**: Phase 0 | **Parallel with**: 1A-1C, 2A, 2C

### 2B.1: Git Service
**New file**: `server/src/git/git-service.ts`

Uses `child_process.execFile` (NOT shell) for safety:
```typescript
class GitService {
  async isGitRepo(cwd: string): Promise<boolean>
  async getStatus(cwd: string): Promise<GitStatus>
  async getBranches(cwd: string): Promise<{ current: string; branches: GitBranch[] }>
  async getLog(cwd: string, limit?: number): Promise<GitLogEntry[]>
  async getDiff(cwd: string, options: { staged?: boolean; file?: string }): Promise<string>
  async stage(cwd: string, paths: string[]): Promise<void>
  async unstage(cwd: string, paths: string[]): Promise<void>
  async discard(cwd: string, paths: string[]): Promise<void>
  async commit(cwd: string, message: string): Promise<string>
  async push(cwd: string, remote?: string, branch?: string): Promise<string>
  async pull(cwd: string): Promise<string>
  async checkout(cwd: string, branch: string): Promise<void>
  async createBranch(cwd: string, name: string): Promise<void>
}
```
- Path validation: reuse `validatePath` from `server/src/routes/files.ts`
- Timeout: 30s per git command
- Error handling: parse git stderr for user-friendly messages

### 2B.2: Git REST Endpoints
**New file**: `server/src/routes/git.ts`

All require auth (cookieAuthMiddleware):
- `GET /api/git/status?cwd=...`
- `GET /api/git/branches?cwd=...`
- `GET /api/git/log?cwd=...&limit=50`
- `GET /api/git/diff?cwd=...&staged=false&file=...`
- `POST /api/git/stage` -- body: `{ cwd, paths }`
- `POST /api/git/unstage` -- body: `{ cwd, paths }`
- `POST /api/git/discard` -- body: `{ cwd, paths }`
- `POST /api/git/commit` -- body: `{ cwd, message }`
- `POST /api/git/push` -- body: `{ cwd, remote?, branch? }`
- `POST /api/git/pull` -- body: `{ cwd }`
- `POST /api/git/checkout` -- body: `{ cwd, branch }`
- `POST /api/git/branch` -- body: `{ cwd, name }`

Input validation with Zod schemas.

**Modify**: `server/src/app.ts` -- mount `/api/git`

### Tests
- `server/tests/unit/git/git-service.test.ts` -- mock execFile, all methods, path validation, non-git dir handling
- `server/tests/unit/routes/git.test.ts` -- supertest for all endpoints

**Checkpoint**: Run server test suite.

---

## Phase 2C: Files Tab Backend Enhancement

**Depends on**: Phase 0 | **Parallel with**: 1A-1C, 2A, 2B

### 2C.1: Enhance File Routes
**Modify**: `server/src/routes/files.ts`

Add CRUD operations:
- `POST /api/files/write` -- body: `{ path, content }` (create/overwrite)
- `PUT /api/files/rename` -- body: `{ oldPath, newPath }`
- `DELETE /api/files/delete` -- body: `{ path }`
- `POST /api/files/mkdir` -- body: `{ path }`
- Enhance `GET /api/files/browse` response to include: `modifiedAt`, `size`, `isSymlink`

All operations through existing `validatePath` security. Input validation with Zod.

### Tests
- `server/tests/unit/routes/files-crud.test.ts` -- write, rename, delete, mkdir, security checks

**Checkpoint**: Run server test suite.

---

## Phase 3A: Shell Tab Frontend

**Depends on**: Phase 1A (tabs working) + Phase 2A (backend ready)

### 3A.1: Install xterm.js
**Modify**: `client/package.json` -- add `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`

### 3A.2: Terminal Hook
**New file**: `client/src/hooks/useTerminal.ts`
- Manages xterm instance + WebSocket connection to `/ws/terminal/:clientId`
- FitAddon for responsive sizing (ResizeObserver on container)
- Auto-reconnect on disconnect
- Cleanup on unmount
- Theme sync (light/dark mode terminal colors)

### 3A.3: Shell Tab Component
**Replace**: `client/src/components/Shell/ShellTab.tsx`
- Full-screen terminal rendered by xterm.js
- Connects to session's CWD
- Mobile: virtual keyboard support, full height
- Desktop: fills tab content area
- Reconnect button if connection drops
- Loading state while PTY spawns

**New file**: `client/src/components/Shell/index.ts`

### 3A.4: Terminal Store
**New file**: `client/src/store/terminalStore.ts`
```
- connected: boolean
- error: string | null
```

### Tests
- `client/tests/unit/components/Shell/ShellTab.test.tsx`
- `client/tests/unit/hooks/useTerminal.test.ts`

**Checkpoint**: Full test suite + manual test with `webapp-testing` skill (open terminal, run `ls`, verify output).

---

## Phase 3B: Git Tab Frontend

**Depends on**: Phase 1A (tabs working) + Phase 2B (backend ready)

### 3B.1: Git Store
**New file**: `client/src/store/gitStore.ts`
```
- status: GitStatus | null
- branches: { current: string; list: GitBranch[] }
- log: GitLogEntry[]
- diff: string
- selectedFile: string | null
- isLoading: boolean
- error: string | null
- Fetch actions that call /api/git/* endpoints
- Auto-refresh: poll status every 10s when Git tab is active
```

### 3B.2: Git Tab Component
**Replace**: `client/src/components/Git/GitTab.tsx`

Three sub-views as collapsible sections (not sub-tabs):
1. **Changes**: Staged + unstaged file lists with stage/unstage/discard buttons
2. **Commit**: Message input + commit button + push button
3. **Log**: Recent commit list with expandable diffs

### 3B.3: Sub-Components
- `client/src/components/Git/GitChanges.tsx` -- file lists with checkboxes
- `client/src/components/Git/GitDiffViewer.tsx` -- syntax-highlighted diff (reuse patterns from `Tools/EditDiff.tsx`)
- `client/src/components/Git/GitCommitForm.tsx` -- message textarea + buttons
- `client/src/components/Git/GitLog.tsx` -- scrollable commit history
- `client/src/components/Git/GitBranchSelector.tsx` -- dropdown in Git tab header
- `client/src/components/Git/index.ts`

### 3B.4: Non-Git Directory Handling
- When session CWD is not a git repo, show "Not a git repository" message
- Detect via `GET /api/git/status` returning error

### Tests
- `client/tests/unit/components/Git/GitTab.test.tsx`
- `client/tests/unit/components/Git/GitChanges.test.tsx`
- `client/tests/unit/components/Git/GitDiffViewer.test.tsx`
- `client/tests/unit/store/gitStore.test.ts`

**Checkpoint**: Full test suite + manual test with `webapp-testing` skill.

---

## Phase 3C: Files Tab Frontend

**Depends on**: Phase 1A (tabs working) + Phase 2C (backend ready)

### 3C.1: Files Store
**New file**: `client/src/store/filesStore.ts`
```
- currentPath: string
- items: FileEntry[]
- selectedFile: string | null (for preview)
- isLoading: boolean
- error: string | null
- Navigate, refresh, CRUD actions
```

### 3C.2: Files Tab Component
**New file**: `client/src/components/Files/FilesTab.tsx`
- Breadcrumb path navigation at top
- File list with icons, names, sizes, modified dates
- Click directory to navigate in, click file to preview
- Action buttons: New File, New Folder, Rename, Delete
- Search/filter bar

### 3C.3: Refactor Existing Components
**Modify**: `client/src/components/FileBrowser/FileTree.tsx`
- Update from dark theme (`bg-slate-900`) to white/blue theme
- Add file metadata display (modified date, size)
- Integrate with filesStore

**Modify**: `client/src/components/FileBrowser/FilePreview.tsx`
- Clean up styling to match new theme
- Add line numbers in preview

**New file**: `client/src/components/Files/index.ts`

### Tests
- `client/tests/unit/components/Files/FilesTab.test.tsx`
- `client/tests/unit/store/filesStore.test.ts`

**Checkpoint**: Full test suite + manual test.

---

## Phase 4: Status Bar Enhancement

**Depends on**: Phase 1A

### 4.1: Context Ring Component
**New file**: `client/src/components/Usage/ContextRing.tsx`
- Small SVG progress ring (20-24px)
- Color: blue (0-60%), yellow (60-80%), red (80-100%)
- Shows percentage number inside or beside
- Tooltip with detailed token info on hover

### 4.2: Enhanced Status Bar
**Modify**: `client/src/components/Chat/MessageInput.tsx`
- Replace text-only context display with ContextRing component
- Keep model name display
- Keep existing layout structure
- Only visible on Chat tab

### Tests
- `client/tests/unit/components/Usage/ContextRing.test.tsx`

---

## Phase 5: Integration & E2E Testing

**Depends on**: All previous phases

### 5.1: New E2E Tests
**New/modify** in `tests/e2e/`:
- `tab-navigation.spec.ts` -- desktop/mobile tab switching, content renders
- `shell-tab.spec.ts` -- terminal opens, type command, see output
- `git-tab.spec.ts` -- view status, stage file, commit
- `files-tab.spec.ts` -- browse, create file, rename, delete
- `mobile-tabs.spec.ts` -- bottom nav, tab switching on mobile viewport

### 5.2: Update Existing E2E Tests
- `core.spec.ts` -- update selectors if header changed
- `mobile.spec.ts` -- update for new bottom nav

### 5.3: Performance Regression
**Modify**: `client/tests/performance/message-rendering.test.ts`
- Add tab switching latency benchmark
- Verify mounted-but-hidden doesn't leak memory

### 5.4: Cross-Tab State Tests
- Session switch updates all tabs (Git shows new CWD, Files shows new CWD, Shell CWD)
- Streaming in Chat doesn't block other tabs
- Rapid tab switching doesn't crash

---

## Implementation Schedule (Parallelization Map)

### Batch 1 (Foundation)
- **Agent 1**: Phase 0 (all) -- foundation types, nav store, layout shell

### Batch 2 (6-way parallel)
- **Agent 1**: Phase 1A -- tab navigation system
- **Agent 2**: Phase 1B -- verbosity redesign
- **Agent 3**: Phase 1C -- theme shift white/blue
- **Agent 4**: Phase 2A -- shell backend (node-pty + terminal WS)
- **Agent 5**: Phase 2B -- git backend (git service + REST endpoints)
- **Agent 6**: Phase 2C -- files backend enhancement

### Batch 3 (3-way parallel, after Batch 2)
- **Agent 1**: Phase 3A -- shell frontend (xterm.js)
- **Agent 2**: Phase 3B -- git frontend
- **Agent 3**: Phase 3C -- files frontend

### Batch 4 (sequential)
- **Agent 1**: Phase 4 -- status bar + context ring

### Batch 5 (sequential)
- **Agent 1**: Phase 5 -- integration + E2E tests

### Testing Checkpoints
- After Batch 1: `npm test` (all existing tests pass)
- After each Phase in Batch 2: Run workspace-specific tests
- After Batch 2: Full `npm test` 
- After each Phase in Batch 3: Run workspace-specific tests + manual `webapp-testing`
- After Batch 3: Full `npm test` + manual smoke test all tabs
- After Batch 4: Full `npm test`
- After Batch 5: Full `npm test` + `npm run test:e2e`

---

## Critical Files Reference

### Files to Modify (existing)
| File | Phase | Change |
|------|-------|--------|
| `client/src/App.tsx` | 0 | Replace inline layout with AppShell |
| `client/src/store/index.ts` | 0 | Add new store exports |
| `shared/src/protocol-types.ts` | 0 | Add Git/Terminal/File types |
| `client/src/components/Chat/ChatView.tsx` | 1A | Remove header (moved to IntegratedHeader) |
| `client/src/components/Sidebar/Sidebar.tsx` | 1A | Mobile tab-switch dismiss |
| `client/src/components/Tools/CollapsibleToolCard.tsx` | 1B | Hybrid verbosity redesign |
| `client/src/components/Chat/MessageBubble.tsx` | 1B | Add expand-all toggle |
| `client/tailwind.config.js` | 1C | Primary color teal->blue |
| Multiple component files | 1C | teal/violet -> blue class names |
| `server/package.json` | 2A | Add node-pty |
| `server/src/index.ts` | 2A | Terminal WebSocket upgrade |
| `server/src/app.ts` | 2A,2B | Mount terminal + git routes |
| `server/src/routes/files.ts` | 2C | Add CRUD operations |
| `client/package.json` | 3A | Add xterm.js |
| `client/src/components/FileBrowser/FileTree.tsx` | 3C | Theme update |
| `client/src/components/Chat/MessageInput.tsx` | 4 | Add ContextRing |

### New Files
| File | Phase |
|------|-------|
| `client/src/store/navigationStore.ts` | 0 |
| `client/src/components/Layout/AppShell.tsx` | 0 |
| `client/src/components/Navigation/IntegratedHeader.tsx` | 1A |
| `client/src/components/Navigation/BottomNav.tsx` | 1A |
| `client/src/components/Navigation/TabContent.tsx` | 1A |
| `client/src/components/Tasks/TasksPlaceholder.tsx` | 1A |
| `server/src/terminal/terminal-manager.ts` | 2A |
| `server/src/terminal/terminal-websocket.ts` | 2A |
| `server/src/routes/terminal.ts` | 2A |
| `server/src/git/git-service.ts` | 2B |
| `server/src/routes/git.ts` | 2B |
| `client/src/hooks/useTerminal.ts` | 3A |
| `client/src/components/Shell/ShellTab.tsx` | 3A |
| `client/src/store/terminalStore.ts` | 3A |
| `client/src/store/gitStore.ts` | 3B |
| `client/src/components/Git/GitTab.tsx` | 3B |
| `client/src/components/Git/GitChanges.tsx` | 3B |
| `client/src/components/Git/GitDiffViewer.tsx` | 3B |
| `client/src/components/Git/GitCommitForm.tsx` | 3B |
| `client/src/components/Git/GitLog.tsx` | 3B |
| `client/src/components/Git/GitBranchSelector.tsx` | 3B |
| `client/src/store/filesStore.ts` | 3C |
| `client/src/components/Files/FilesTab.tsx` | 3C |
| `client/src/components/Usage/ContextRing.tsx` | 4 |

### Reusable Existing Code
- `server/src/routes/files.ts:validatePath()` -- reuse for git path validation
- `client/src/components/Tools/EditDiff.tsx` -- reuse diff rendering patterns for GitDiffViewer
- `client/src/hooks/useWebSocket.ts` -- reference pattern for useTerminal WebSocket
- `server/src/websocket/session-websocket.ts` -- reference for terminal WebSocket auth

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| node-pty compilation fails | High | Use `node-pty-prebuilt-multiarch` fallback. Document build deps. |
| Verbosity redesign hides errors | Medium | Error tool cards auto-expand. Keep BRIEF_ONLY_TOOLS unchanged. |
| Mounted tabs use too much mobile RAM | Medium | Monitor with performance tests. Fallback: unmount Git/Files on mobile only. |
| xterm.js memory leaks on tab switch | Medium | Strict cleanup in useTerminal. Terminal idle timeout server-side. |
| Git ops on non-git dirs | Low | isGitRepo() check. Show "Not a git repository" message. |
| Theme shift breaks dark mode | Low | Only change light mode colors. Dark mode classes untouched. |
| Bottom nav overlaps input | Low | Input detection hides bottom nav. `pb-16` on content containers. |

---

## Verification Plan

After full implementation:
1. `npm test` -- all existing + new tests pass
2. `npm run test:e2e` -- all E2E tests pass
3. `npm run build` -- TypeScript compilation clean
4. Manual `webapp-testing` on desktop:
   - Switch all tabs, verify content loads
   - Open terminal, run commands
   - Browse files, create/rename/delete
   - View git status, stage, commit
   - Chat with agent, verify tool cards look correct
5. Manual `webapp-testing` on mobile viewport:
   - Bottom nav visible, tabs switch
   - Terminal usable with virtual keyboard
   - No content overlap with bottom nav
6. `npm run test:coverage` -- verify coverage targets maintained
