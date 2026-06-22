# Pi Web UI Codebase Map

> Token-efficient file-to-purpose index. Use this to find where a concept is implemented without grepping.

## Frontend (`client/src/`)

### State
- `store/sessionStore.ts` — Main frontend session state: messages, streaming, switching, LRU cache (2 sessions), pinning, archiving, worker status, Claude/OpenCode availability. Uses throttled persist storage and individual Zustand selectors for mobile runtime performance.
- `store/transferStore.ts` — Session context transfer UI state.
- `store/uiStore.ts` — UI chrome state (modals, toasts, navigation).
- `store/chatStore.ts` — Chat input/draft state.

### WebSocket / API
- `hooks/useWebSocket.ts` — Client WebSocket connection manager, sends actions to server.
- `lib/api.ts` — REST API client.
- `lib/session-websocket.ts` — Session-specific WebSocket client.

### Session / Chat UI
- `components/Session/NewSessionModal.tsx` — Runtime picker (Pi / Claude / OpenCode / Antigravity).
- `components/Sidebar/SessionItem.tsx` — Sidebar session row (drag source, pin, archive, rename).
- `components/Sidebar/SessionList.tsx` — Sidebar container.
- `components/Sidebar/TransferConfirmationModal.tsx` — Context transfer confirmation UX.
- `components/Chat/ChatView.tsx` — Main chat surface.
- `components/Chat/MessageList.tsx` — Message list rendering.
- `components/Chat/MessageBubble.tsx` — Individual message bubble.
- `components/Chat/MessageInput.tsx` — Chat input box.

### Drive Mode
- `components/DriveMode/DriveModeOverlay.tsx` — Voice-first overlay and phase routing.
- `components/DriveMode/DriveModeDictate.tsx` — Dictation and read-aloud control surface.
- `components/DriveMode/DriveModeSessionPicker.tsx` / `DriveModeModelPicker.tsx` / `DriveModeFolderPicker.tsx` — Drive Mode navigation.
- `store/driveModeStore.ts` — Drive Mode state machine.
- `hooks/useDriveModeDictation.ts` — Drive Mode prompt-send flow.

### Tools / Extensions
- `components/Tools/ToolCallCard.tsx` — Tool execution card.
- `components/Tools/CollapsibleToolCard.tsx` — Collapsible tool display.
- `components/Extensions/ExtensionDialog.tsx` — Approval/dialog UI for extensions and OpenCode permissions.

## Backend (`server/src/`)

### WebSocket / Routing
- `websocket/connection.ts` — **Main runtime router.** All Pi/Claude/OpenCode prompts, aborts, switches, and events flow through here. Contains `normEventToPiFormat()` and subscriber fanout.
- `websocket/protocol.ts` — Shared WebSocket message type definitions and guards.
- `websocket/session-websocket.ts` — JSON-RPC endpoint for Pi Coding Agent worker communication (`/ws/sessions/:sessionId`).
- `websocket/handlers.ts` — Legacy WebSocket message handlers.

### Pi Coding Agent Path (`server/src/pi/`)
- `pi/multi-session-manager.ts` — **Pi session lifecycle, idle cleanup, pinning, stale-stream reset (15min threshold), API-error grace timer (60s), memory monitoring, skill-content transformation.**
- `pi/pi-service.ts` — Pi Coding Agent service facade.
- `pi/event-forwarder.ts` — Bridges Pi Coding Agent events into WebSocket broadcasts.
- `pi/session-pool.ts` — Session object pool.
- `pi/parallel/session-orchestrator.ts` — Parallel agent session orchestration (worktrees).
- `pi/parallel/worktree-manager.ts` — Git worktree management for parallel sessions.
- `pi/parallel/plan-parser.ts` — Parses parallel execution plans.
- `pi/parallel/merge-coordinator.ts` — Coordinates merge of parallel session results.

### Workers (`server/src/workers/`)
- `workers/worker-pool.ts` — Pi worker process pool, spawn/kill lifecycle.
- `workers/session-rpc-client.ts` — RPC client for talking to Pi workers.
- `workers/rpc-protocol-bridge.ts` — Bridges between JSON-RPC and internal protocol.
- `workers/event-normalizer.ts` — Normalizes Pi worker events.
- `workers/session-worker.ts` — Individual Pi worker process script.

### Claude Runtime Family (`server/src/claude/`)
- `claude/claude-service.ts` — Claude runtime lifecycle, backend selection, session registry integration, prompt dispatch, stats.
- `claude/claude-process-pool.ts` — Legacy `claude -p` subprocess management, spawn, abort, lock handling.
- `claude/claude-event-normalizer.ts` — Converts legacy Claude NDJSON stream into `NormalizedEvent`.
- `claude/claude-history-replay.ts` — Reconstructs session history from Pi-owned JSONL for UI replay.
- `claude/claude-session-store.ts` — JSONL persistence (`~/.pi-web-ui/claude-sessions/`).
- `claude/claude-session-subscribers.ts` — Multi-viewer fanout for Claude sessions.
- `claude/claude-profiles.ts` — Profile schema (Zod), validation, `ClaudeProfileManager`, `resolveProfile`. Loads and validates `claude-profiles.json` at startup; secrets (auth tokens) are resolved from env vars or secret files at session launch time, never stored in the profile.
- `claude/claude-sdk-service.ts` — SDK backend service (`ClaudeSdkService`). Manages Claude sessions through `@anthropic-ai/claude-agent-sdk` `query()` with `canUseTool` permission callbacks, `AbortController` cancellation, and structured SDK messages.
- `claude/claude-sdk-event-adapter.ts` — Converts structured SDK messages into `NormalizedEvent` for the common event pipeline.
- `claude/claude-channel-service.ts` — Channel-backed Claude session orchestration and event fanout.
- `claude/claude-channel-process-manager.ts` — PTY-managed Claude Code process, busy-state tracking, auth-expiry detection.
- `claude/claude-channel-hooks-config.ts` — Managed Claude hook config writer for `~/.claude/settings.json`.
- `claude/claude-channel-ws-client.ts` — WebSocket client receiving channel plugin events.
- `claude/claude-channel-event-adapter.ts` — Converts channel plugin events into the normalized event model.

### OpenCode Path (`server/src/opencode/`)
- `opencode/opencode-service.ts` — OpenCode lifecycle, prompt dispatch, context-window tracking, session cleanup, trusted permissions.
- `opencode/opencode-process-manager.ts` — `opencode serve` lifecycle, health checks, idle-aware recycling.
- `opencode/opencode-client.ts` — HTTP client for OpenCode server APIs and SSE subscription.
- `opencode/opencode-event-adapter.ts` — Adapts OpenCode SSE into `NormalizedEvent`; contains tool-event deduplication logic.
- `opencode/opencode-history-replay.ts` — Converts OpenCode message history into replay events.
- `opencode/opencode-session-subscribers.ts` — Multi-viewer fanout for OpenCode sessions.
- `opencode/opencode-types.ts` — OpenCode-specific type definitions.

### Antigravity Path (`server/src/antigravity/`)
- `antigravity/antigravity-service.ts` — Antigravity lifecycle, `agy -p` subprocess dispatch, conversation-id tracking, session cleanup, model listing.
- `antigravity/antigravity-session-store.ts` — JSONL turn persistence at `~/.pi-web-ui/antigravity-sessions/`.
- `antigravity/antigravity-history-replay.ts` — Converts stored Antigravity turns into replay events.
- `antigravity/antigravity-session-subscribers.ts` — Multi-viewer fanout for Antigravity sessions.

### Session Transfer (`server/src/session-transfer/`)
- `session-transfer/transfer-service.ts` — Orchestrates cross-runtime context transfer.
- `session-transfer/visible-transcript.ts` — Builds canonical visible transcript from replay events.
- `session-transfer/transfer-framing.ts` — Builds the handoff message wrapper.
- `session-transfer/transfer-validation.ts` — Validates transfer requests.
- `session-transfer/pi-source-adapter.ts` — Extracts visible transcript from Pi sessions.
- `session-transfer/claude-source-adapter.ts` — Extracts visible transcript from Claude JSONL.
- `session-transfer/opencode-source-adapter.ts` — Extracts visible transcript from OpenCode replay.

### Registry / Persistence
- `session-registry.ts` — Unified cross-runtime session index (`~/.pi-web-ui/session-registry.json`). Atomic tmp+rename writes.
- `session-cleanup.ts` — Scheduled cleanup of archived/pinned sessions.

### Security
- `security/auth.ts` — JWT cookie generation and verification.
- `security/csrf.ts` — CSRF token generation and validation.
- `security/prompt-injection.ts` — Pattern-based prompt injection detection.
- `security/rate-limit.ts` — HTTP and WebSocket rate limiting.
- `security/websocket.ts` — WebSocket auth handshake.
- `middleware/auth.ts` — Express auth middleware.

### REST Routes (`server/src/routes/`)
- `routes/health.ts` — Health/readiness probes, runtime availability.
- `routes/models.ts` — Model listing (Pi, OpenCode, and Antigravity).
- `routes/auth.ts` — Login/logout.
- `routes/sessions.ts` — Session CRUD, export.
- `routes/files.ts` — File browsing and reading (with path validation).
- `routes/extensions.ts` — Extension listing and toggling.
- `routes/preferences.ts` — User preferences (pins, archives, display names).
- `routes/config.ts` — Config validation endpoint.
- `routes/terminal.ts` — Terminal session management.
- `routes/git.ts` — Git operations.

### Config / Bootstrap
- `config.ts` — Environment variable parsing and defaults.
- `app.ts` — Express app setup.
- `index.ts` — Server entry point.

### Operational Helpers
- `scripts/debug-where.mjs` — Fast session locator: maps a session id, runtime-native id, path, or Antigravity conversation id to the relevant logs, registry entry, and runtime-owned files.
- `scripts/validate-claude-profiles.ts` — Profile-specific validation runner. Validates SDK backend, direct CLI backend, tool visibility, skills, follow-up, and concurrency through a disposable server. Run via `npm run validate:claude-profiles`.
- `scripts/concurrency-test.ts` — Tests simultaneous Claude + provider-profile sessions for cross-contamination. Run directly with `npx tsx scripts/concurrency-test.ts`.
- `pi-claude-channel/server.ts` — Local Claude channel/plugin bridge process.

## Shared Package (`shared/src/`)

- `protocol-types.ts` — **The contract.** `NormalizedEvent`, `WorkerStatus`, `InternalCommand`, `SessionEventEnvelope`, git types, terminal types.
- `protocol/jsonrpc.ts` — JSON-RPC message types and utilities.
- `types.ts` — Legacy shared types (`SdkType`, `Session`, `Message`, etc.).
- `constants.ts` — Shared constants.

## Tests

- `tests/e2e/` — Playwright E2E tests (auth, session creation, switching, runtime-specific flows).
- `server/tests/unit/` — Server unit tests (runtime adapters, WebSocket routing, security), including `server/tests/unit/antigravity/*` for Antigravity replay/store/subscriber coverage.
- `server/tests/integration/` — Cross-module integration tests.
