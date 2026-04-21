# OpenCode Direct Integration — Comprehensive Implementation Plan

> **Status:** Plan only. Not yet executing.
> **Date:** 2026-04-21
> **Prerequisite reading:** `docs/OPENCODE-DIRECT-INTEGRATION.md` (architecture), `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/CLAUDE-DIRECT-UX-ISSUES.md`
> **Goal:** Add a third runtime path (`opencode`) to Pi Web UI, backed by a real `opencode serve` process, with parity to the existing Claude Direct path in the UI and better primitives underneath.

---

## Table of Contents

1. [Overview and Principles](#1-overview-and-principles)
2. [Dependency Graph](#2-dependency-graph)
3. [Phase 0 — Shared Foundation](#3-phase-0--shared-foundation)
4. [Phase 1 — Server Core (Parallelisable)](#4-phase-1--server-core-parallelisable)
5. [Phase 2 — Server Integration](#5-phase-2--server-integration)
6. [Phase 3 — Client Integration](#6-phase-3--client-integration)
7. [Phase 4 — Permission Bridge](#7-phase-4--permission-bridge)
8. [Phase 5 — End-to-End Testing and Polish](#8-phase-5--end-to-end-testing-and-polish)
9. [Git Strategy](#9-git-strategy)
10. [Testing Strategy](#10-testing-strategy)
11. [Edge Cases and Risk Register](#11-edge-cases-and-risk-register)
12. [File Inventory](#12-file-inventory)
13. [Verification Checklist](#13-verification-checklist)

---

## 1. Overview and Principles

### What we are building

A new runtime path alongside the existing Pi SDK and Claude Direct paths. When the user creates a session with `sdkType: 'opencode'`:

1. Pi Web UI starts (or reuses) a long-lived `opencode serve` backend.
2. Creates a session via the OpenCode HTTP API.
3. Sends prompts via `POST /session/:id/prompt_async`.
4. Consumes live events via OpenCode SSE (`GET /event`).
5. Converts those events into Pi Web UI's normalised `session_event` format.
6. Broadcasts them to WebSocket subscribers.
7. On session switch, replays history from OpenCode's `GET /session/:id/message` API.
8. Supports abort via `POST /session/:id/abort`.
9. Supports interactive permission approval via OpenCode's permission APIs.

### Design principles

- **OpenCode is the source of truth** for session state, messages, and permissions.
- **Pi Web UI adapts, not replaces** — no Pi-owned JSONL transcript for OpenCode sessions.
- **Mirror Claude Direct's external shape** (separate service module, unified sidebar, subscriber fanout, event normalisation) but use OpenCode's stronger server/API primitives internally.
- **Do not spoof** OpenCode identifiers, User-Agent strings, or provider IDs.
- **Incremental commits** — each phase produces independently testable, lint-clean, type-clean code.

### Runtime comparison

| Aspect | Pi SDK | Claude Direct | OpenCode Direct (new) |
|---|---|---|---|
| Backend | In-process Pi workers | `claude -p` subprocess per turn | Long-lived `opencode serve` process |
| Session storage | `~/.pi/agent/sessions/` | `~/.pi-web-ui/claude-sessions/` (Pi-owned JSONL) | OpenCode-owned (no Pi JSONL) |
| Live events | Pi SDK event handlers | NDJSON stdout parsing | SSE from OpenCode server |
| Abort | `agentSession.abort()` | SIGTERM + lock recovery | `POST /session/:id/abort` |
| Permissions | Pi extension UI | `dontAsk` + broad allowlist | OpenCode permission APIs |
| History replay | Load Pi JSONL file | Load Pi-owned JSONL → `historyToReplayEvents()` | `GET /session/:id/message` → adapt |

---

## 2. Dependency Graph

```
Phase 0: Shared Foundation
  ├── 0A: SdkType expansion (shared/)
  └── 0B: Config additions (server/)
      │
      ▼
Phase 1: Server Core (all parallelisable after Phase 0)
  ├── 1A: opencode-types.ts
  ├── 1B: opencode-process-manager.ts
  ├── 1C: opencode-client.ts
  ├── 1D: opencode-event-adapter.ts
  ├── 1E: opencode-history-replay.ts
  └── 1F: opencode-session-subscribers.ts
      │
      ▼ (1B+1C must be done before 1G)
Phase 1G: opencode-service.ts (depends on 1A–1F)
      │
      ▼
Phase 2: Server Integration (sequential)
  ├── 2A: session-registry.ts changes
  ├── 2B: connection.ts changes (routing, status, prompt, abort, replay, sessions list)
  └── 2C: config.ts / health endpoint changes
      │
      ▼
Phase 3: Client Integration (partially parallelisable)
  ├── 3A: sessionStore.ts — handle sdkType 'opencode'
  ├── 3B: Sidebar / session list — show opencode sessions
  ├── 3C: Session creation UI — OpenCode option
  └── 3D: Model selector — OpenCode provider/model support
      │
      ▼
Phase 4: Permission Bridge
  ├── 4A: Server permission event handling
  └── 4B: Client permission dialog integration
      │
      ▼
Phase 5: End-to-End Testing and Polish
  ├── 5A: Unit tests for all new server modules
  ├── 5B: Integration tests
  ├── 5C: E2E tests
  └── 5D: Documentation updates
```

---

## 3. Phase 0 — Shared Foundation

These changes are prerequisites for all subsequent work. Must be committed first.

### 0A: Expand `SdkType` in shared types

**File:** `shared/src/types.ts`

**Change:**
```typescript
// Before
export type SdkType = 'pi' | 'claude';

// After
export type SdkType = 'pi' | 'claude' | 'opencode';
```

**Also update:**
- `shared/src/types-dual.test.ts` — add test case for `'opencode'`

**Ripple effects to check:**
- `server/src/session-registry.ts` — `RegistryEntry.sdkType` uses `SdkType`; adding `'opencode'` requires no structural change but the `upsert`/`listBySdkType` functions will naturally accept it.
- `client/src/store/sessionStore.ts` — `Session.sdkType` — already optional with backward compat.
- `server/src/websocket/connection.ts` — routing logic currently checks `=== 'claude'`; will need OpenCode routing in Phase 2.

### 0B: Add OpenCode config to server config

**File:** `server/src/config.ts`

**Changes:**
```typescript
// Add to ServerConfig interface:
opencodeServerPort: number;
opencodeServerHost: string;
opencodeServerPassword: string;
opencodeServerEnabled: boolean;
opencodeWorkingDir: string;

// Add to config object:
opencodeServerPort: parseInt(process.env.OPENCODE_SERVER_PORT || '4096', 10),
opencodeServerHost: process.env.OPENCODE_SERVER_HOST || '127.0.0.1',
opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD || '',
opencodeServerEnabled: process.env.OPENCODE_ENABLED !== 'false',
opencodeWorkingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
```

**Also update:**
- `.env.example` — add `OPENCODE_SERVER_PORT`, `OPENCODE_SERVER_HOST`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_ENABLED`, `OPENCODE_WORKING_DIR`

### 0A/0B Testing

- Run `npm run typecheck` to confirm shared type change propagates cleanly.
- Run existing `shared/` tests: `npm test -w shared`
- Run `npm run build` to confirm no breakage.

---

## 4. Phase 1 — Server Core (Parallelisable)

All modules in Phase 1 can be developed in parallel by different agents after Phase 0 is committed. Each module is self-contained with well-defined interfaces.

### 1A: `server/src/opencode/opencode-types.ts`

**Purpose:** Shared TypeScript types for the OpenCode integration. All other opencode modules import from here.

**Contents:**
```typescript
// ── OpenCode API response types (derived from opencode serve API docs) ──

/** OpenCode session object from GET /session or POST /session */
export interface OpenCodeSession {
  id: string;
  // additional fields TBD from API testing
}

/** OpenCode message from GET /session/:id/message */
export interface OpenCodeMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: OpenCodeMessagePart[];
  createdAt?: string;
  // additional fields TBD
}

/** A part within an OpenCode message */
export interface OpenCodeMessagePart {
  type: 'text' | 'tool-invocation' | 'tool-result' | 'reasoning' | string;
  text?: string;
  toolInvocationId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  state?: 'partial' | 'result' | 'call' | string;
  // additional fields TBD
}

/** OpenCode SSE event (raw from /event stream) */
export interface OpenCodeSSEEvent {
  type: string;
  properties?: Record<string, unknown>;
  // Exact shape will be refined during API testing
}

/** OpenCode session status */
export type OpenCodeSessionStatus = 'idle' | 'running' | 'error';

/** OpenCode permission request */
export interface OpenCodePermissionRequest {
  id: string;
  sessionId: string;
  toolName?: string;
  args?: unknown;
  // Exact shape TBD from API testing
}

/** Config for the OpenCode service */
export interface OpenCodeConfig {
  host: string;
  port: number;
  password: string;
  workingDir: string;
  enabled: boolean;
}
```

**Testing:** Type-only file — `npm run typecheck` is sufficient.

**Dependencies:** None (standalone).

---

### 1B: `server/src/opencode/opencode-process-manager.ts`

**Purpose:** Start, monitor, health-check, and restart the `opencode serve` process. This is the equivalent of `claude-process-pool.ts` but manages **one long-lived server** instead of one subprocess per prompt.

**Responsibilities:**
1. Start `opencode serve --hostname <host> --port <port>` as a child process.
2. Pass `OPENCODE_SERVER_PASSWORD` via environment if configured.
3. Wait for the server to become healthy (poll `GET /config/providers` or similar).
4. Expose `getBaseUrl(): string` for the client module.
5. Auto-restart on crash with exponential backoff (max 5 retries).
6. Log capture from stdout/stderr.
7. Prevent duplicate startups (idempotent `start()`).
8. Graceful shutdown via `stop()` (SIGTERM, then SIGKILL after timeout).
9. Health check method: `isHealthy(): Promise<boolean>`.

**Key design decisions:**
- **One process for now.** Per-workspace server topology is deferred.
- The process is started lazily on first OpenCode session creation, not on Pi Web UI startup.
- If `opencode` binary is not on PATH, `isAvailable()` returns false and the runtime is disabled.

**Interface sketch:**
```typescript
export class OpenCodeProcessManager {
  constructor(config: OpenCodeConfig);
  
  /** Check if `opencode` binary exists on PATH */
  async isAvailable(): Promise<boolean>;
  
  /** Start the server process (idempotent) */
  async start(): Promise<void>;
  
  /** Stop the server process */
  async stop(): Promise<void>;
  
  /** Is the server process running and healthy? */
  async isHealthy(): Promise<boolean>;
  
  /** Get the base URL for API calls */
  getBaseUrl(): string;
  
  /** Get auth headers (basic auth if password set) */
  getAuthHeaders(): Record<string, string>;
}
```

**Testing:**
- Unit tests: `server/tests/unit/opencode/opencode-process-manager.test.ts`
  - Mock `child_process.spawn` to avoid actually starting OpenCode.
  - Test: start idempotency, restart on crash, stop cleanup, health check polling, `isAvailable` when binary missing.
  - Pattern: follow `claude-process-pool.test.ts` mocking strategy.

**Dependencies:** `opencode-types.ts` (1A), config (0B).

---

### 1C: `server/src/opencode/opencode-client.ts`

**Purpose:** Low-level HTTP/SSE client wrapper for the OpenCode server API. All API calls go through this module.

**Decision: SDK vs raw HTTP.**
Start with raw HTTP (using Node's built-in `fetch`). The `@opencode-ai/sdk` can be added later as an optimisation if the raw approach becomes unwieldy. This avoids adding a dependency before we've validated the exact API behaviour.

**Responsibilities:**
1. **Session CRUD:**
   - `createSession(): Promise<OpenCodeSession>`
   - `listSessions(): Promise<OpenCodeSession[]>`
   - `getSession(id: string): Promise<OpenCodeSession>`
   - `getSessionStatus(id: string): Promise<OpenCodeSessionStatus>`
2. **Prompt dispatch:**
   - `promptAsync(sessionId: string, message: string): Promise<void>` — `POST /session/:id/prompt_async`
   - `sendMessage(sessionId: string, message: string): Promise<unknown>` — `POST /session/:id/message` (sync fallback)
3. **Message retrieval:**
   - `getMessages(sessionId: string): Promise<OpenCodeMessage[]>` — `GET /session/:id/message`
4. **Abort:**
   - `abort(sessionId: string): Promise<void>` — `POST /session/:id/abort`
5. **Permissions:**
   - `replyPermission(sessionId: string, permissionId: string, response: unknown): Promise<void>`
6. **SSE subscription:**
   - `subscribeEvents(onEvent: (event: OpenCodeSSEEvent) => void): () => void` — `GET /event` or `GET /global/event`
   - Returns an unsubscribe function.
   - Must handle reconnection on SSE disconnect.
7. **Provider/config:**
   - `getProviders(): Promise<unknown>`

**Auth handling:**
- If `OPENCODE_SERVER_PASSWORD` is set, include `Authorization: Basic ...` header on all requests (base64 of `:password`).

**Error handling:**
- Throw typed errors for HTTP failures (4xx, 5xx, network errors).
- Include status code and response body in error message.

**Testing:**
- Unit tests: `server/tests/unit/opencode/opencode-client.test.ts`
  - Mock `fetch` globally.
  - Test: each API method produces correct URL/method/headers/body.
  - Test: auth header included when password set.
  - Test: error handling for 4xx, 5xx, network errors.
  - Test: SSE subscription (mock EventSource or use a test SSE server).

**Dependencies:** `opencode-types.ts` (1A).

---

### 1D: `server/src/opencode/opencode-event-adapter.ts`

**Purpose:** Convert OpenCode SSE events and message/part data into Pi Web UI's normalised `NormalizedEvent` format. This is the equivalent of `claude-event-normalizer.ts`.

**Key difference from Claude Direct:**
Claude Direct parses raw NDJSON from stdout. OpenCode Direct adapts structured SSE events and message/part objects. The mapping should be **less lossy** because OpenCode already has structured messages, parts, tools, and status.

**Candidate event mappings (to be refined during API testing):**

| OpenCode event/state | Pi Web UI NormalizedEvent |
|---|---|
| Session starts running | `agent_start` |
| Assistant text part created/updated | `message_start` + `message_update` |
| Assistant text part completed | `message_end` |
| Tool invocation part (state: 'call') | `tool_execution_start` |
| Tool invocation part (state: 'result') | `tool_execution_end` |
| Session returns to idle | `agent_end` |
| Permission request | `permission_request` (new event type) |
| Session init/config | `session_init` |

**Interface sketch:**
```typescript
export class OpenCodeEventAdapter {
  /**
   * Convert a raw OpenCode SSE event into zero or more NormalizedEvents.
   * May need session context (current message ID, etc.) to produce correct output.
   */
  adaptSSEEvent(event: OpenCodeSSEEvent, sessionId: string): NormalizedEvent[];
  
  /**
   * Convert an OpenCode message (from history API) into replay NormalizedEvents.
   * Used by history-replay module.
   */
  messageToReplayEvents(message: OpenCodeMessage, piSessionId: string): NormalizedEvent[];
  
  /**
   * Reset adapter state (e.g., on session switch).
   */
  reset(): void;
}
```

**Important:** The adapter must be stateful per session — it needs to track the current message ID to correlate `message_update` events correctly (similar to how `currentMessageIdBySession` works in `sessionStore.ts`).

**Testing:**
- Unit tests: `server/tests/unit/opencode/opencode-event-adapter.test.ts`
  - Fixture-based: create JSON fixture files of OpenCode SSE events in `fixtures/opencode-sse-*.json`.
  - Test: each OpenCode event type → expected Pi normalised events.
  - Test: state tracking (message ID correlation across updates).
  - Test: unknown event types produce a `opencode_raw` event (like `claude_raw`).
  - Pattern: follow `claude-event-normalizer.test.ts` fixture-based approach.

**Dependencies:** `opencode-types.ts` (1A), `@pi-web-ui/shared` (NormalizedEvent).

---

### 1E: `server/src/opencode/opencode-history-replay.ts`

**Purpose:** Convert OpenCode message history (from `GET /session/:id/message`) into Pi Web UI replay events. Equivalent of `claude-history-replay.ts`.

**Key difference from Claude Direct:**
Claude Direct reads Pi-owned JSONL files and coalesces text deltas. OpenCode Direct reads structured messages from the OpenCode API — each message already has complete parts, so no coalescing is needed.

**Interface sketch:**
```typescript
/**
 * Convert OpenCode messages into Pi-compatible replay events.
 * Called when a client switches to an OpenCode session.
 */
export function opencodeMessagesToReplayEvents(
  messages: OpenCodeMessage[],
  piSessionId: string,
): Array<Record<string, unknown>>;
```

**Replay event sequence per message:**
- User message → `message_start` (role: user) + `message_update` (text) + `message_end`
- Assistant message:
  - For each text part → `message_start` + `message_update` + `message_end`
  - For each tool-invocation part → `tool_execution_start`
  - For each tool-result part → `tool_execution_end`
  - (Parts are emitted in order they appear in the message)

**Testing:**
- Unit tests: `server/tests/unit/opencode/opencode-history-replay.test.ts`
  - Fixture-based: create `fixtures/opencode-messages-*.json` with sample messages.
  - Test: empty messages → empty events.
  - Test: user message → correct message_start/update/end.
  - Test: assistant message with text + tool parts → correct event sequence.
  - Test: ordering matches part order in the message.
  - Pattern: follow `claude-history-replay.test.ts`.

**Dependencies:** `opencode-types.ts` (1A).

---

### 1F: `server/src/opencode/opencode-session-subscribers.ts`

**Purpose:** Track which WebSocket clients are viewing which OpenCode sessions, enabling event fanout to all viewers. This is a direct copy of `claude-session-subscribers.ts` with `Claude` → `OpenCode` naming.

**Implementation:** Near-identical to `ClaudeSessionSubscribers`:
```typescript
export class OpenCodeSessionSubscribers {
  subscribe(clientId: string, sessionId: string): void;
  unsubscribe(clientId: string, sessionId: string): void;
  unsubscribeAll(clientId: string): void;
  getSubscribers(sessionId: string): ReadonlySet<string>;
  getSubscriberCount(sessionId: string): number;
  isSubscribed(clientId: string, sessionId: string): boolean;
  get sessionCount(): number;
}
```

**Consideration:** This is nearly identical to `ClaudeSessionSubscribers`. Consider refactoring into a shared generic `RuntimeSessionSubscribers` class in a later cleanup, but do NOT do this now — keep the implementation simple and parallel to Claude Direct for first-pass clarity.

**Testing:**
- Unit tests: `server/tests/unit/opencode/opencode-session-subscribers.test.ts`
  - Pattern: copy `claude-session-subscribers.test.ts` and adapt names.
  - Test: subscribe/unsubscribe, getSubscribers, unsubscribeAll, multi-client scenarios.

**Dependencies:** None (standalone).

---

### 1G: `server/src/opencode/opencode-service.ts`

**Purpose:** The top-level orchestrator for OpenCode sessions, equivalent to `claude-service.ts`. This is the module that `connection.ts` calls.

**Dependencies:** 1A, 1B, 1C, 1D, 1E, 1F — all must be at least interface-stable before this module can be completed.

**Responsibilities:**
1. Validate OpenCode availability (`isAvailable`, `validateSetup`).
2. Ensure the OpenCode server is running (lazy start via process manager).
3. Create new OpenCode sessions (API call + registry entry).
4. List OpenCode sessions (from registry, optionally refreshed from API).
5. Send prompts to OpenCode sessions (async prompt + SSE subscription for live events).
6. Handle abort.
7. Replay history on session switch.
8. Handle permission replies.
9. Track session running state.
10. Manage SSE subscription lifecycle (subscribe when session has viewers, unsubscribe when no viewers).

**Interface sketch:**
```typescript
export class OpenCodeService {
  constructor(cfg: {
    processManager: OpenCodeProcessManager;
    client: OpenCodeClient;
    registryPath: string;
  });

  /** Check if `opencode` binary is available */
  async isAvailable(): Promise<boolean>;
  
  /** Validate OpenCode server can start and is configured */
  async validateSetup(): Promise<{ ok: boolean; error?: string }>;

  /** Create a new OpenCode session */
  async createSession(cwd: string): Promise<{ sessionId: string; opencodeSessionId: string }>;

  /** Send a prompt to an OpenCode session */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void>;

  /** Abort the running prompt for a session */
  abort(sessionId: string): void;

  /** Is a prompt currently running for this session? */
  isRunning(sessionId: string): boolean;

  /** Get replay events for history */
  async getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>>;

  /** Reply to a permission request */
  async replyPermission(
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ): Promise<void>;

  /** List all OpenCode sessions from registry */
  async listSessions(): Promise<RegistryEntry[]>;

  /** Get a session from registry */
  async getSession(sessionId: string): Promise<RegistryEntry | undefined>;
}
```

**SSE event routing:**
When a prompt is sent, the service:
1. Calls `client.promptAsync(opencodeSessionId, prompt)`.
2. Is already subscribed to SSE events (subscription managed per-session or globally).
3. The event adapter converts incoming SSE events.
4. Normalised events are forwarded to the `onEvent` callback.
5. When session status transitions to idle, calls `onComplete()`.

**State management for "isRunning":**
Track per-session running state based on SSE events:
- Set running on prompt dispatch.
- Set idle when `agent_end` equivalent is received from SSE or status polling.

**Singleton pattern:**
```typescript
let opencodeServiceInstance: OpenCodeService | null = null;

export function getOpenCodeService(): OpenCodeService {
  if (opencodeServiceInstance === null) {
    opencodeServiceInstance = new OpenCodeService({ ... });
  }
  return opencodeServiceInstance;
}
```

**Testing:**
- Unit tests: `server/tests/unit/opencode/opencode-service.test.ts`
  - Mock all dependencies (process manager, client, registry).
  - Test: createSession registers in registry.
  - Test: sendPrompt calls client.promptAsync, forwards events.
  - Test: abort calls client.abort.
  - Test: isRunning state transitions.
  - Test: getReplayEvents returns adapted messages.
  - Test: error handling (server not running, session not found, etc.).

---

### 1H: `server/src/opencode/index.ts`

**Purpose:** Barrel export for the opencode module.

```typescript
export { OpenCodeService, getOpenCodeService } from './opencode-service.js';
export { OpenCodeProcessManager } from './opencode-process-manager.js';
export { OpenCodeClient } from './opencode-client.js';
export { OpenCodeEventAdapter } from './opencode-event-adapter.js';
export { OpenCodeSessionSubscribers } from './opencode-session-subscribers.js';
export { opencodeMessagesToReplayEvents } from './opencode-history-replay.js';
export type * from './opencode-types.js';
```

---

## 5. Phase 2 — Server Integration

These changes wire the new OpenCode modules into the existing server infrastructure. Must be done **after Phase 1G** is complete. Changes within Phase 2 should be done **sequentially** as they all touch shared files.

### 2A: Session Registry Changes

**File:** `server/src/session-registry.ts`

**Changes:**
1. Add `opencodeSessionId?: string` field to `RegistryEntry`:
   ```typescript
   export interface RegistryEntry {
     // ... existing fields ...
     claudeSessionId?: string;
     opencodeSessionId?: string;  // NEW
   }
   ```
2. Add `getByOpencodeSessionId(id: string)` method:
   ```typescript
   async getByOpencodeSessionId(opencodeSessionId: string): Promise<RegistryEntry | undefined> {
     const registry = await this.load();
     return registry.entries.find(e => e.opencodeSessionId === opencodeSessionId);
   }
   ```
3. Update `upsert()` to also match by `opencodeSessionId` when finding existing entries.

**Testing:**
- Update `server/tests/unit/session-registry.test.ts` (if exists) or create it.
- Test: upsert with opencodeSessionId, getByOpencodeSessionId.

### 2B: WebSocket Connection Changes

**File:** `server/src/websocket/connection.ts`

This is the largest integration point. Changes are broken into sub-tasks:

#### 2B.1: Import and initialise OpenCode service

Add to constructor:
```typescript
import { getOpenCodeService, type OpenCodeService } from '../opencode/index.js';
import { OpenCodeSessionSubscribers } from '../opencode/opencode-session-subscribers.js';

// In class:
private opencodeService: OpenCodeService;
private opencodeSessionIds: Set<string> = new Set();
private opencodeSubs = new OpenCodeSessionSubscribers();

// In constructor:
this.opencodeService = getOpenCodeService();

// Restore opencode session IDs from registry (like Claude):
void this.restoreOpencodeSessionIds();
```

#### 2B.2: Add `restoreOpencodeSessionIds()` method

Mirror `restoreClaudeSessionIds()`:
```typescript
private async restoreOpencodeSessionIds(): Promise<void> {
  const registry = getSessionRegistry();
  const opencodeSessions = await registry.listBySdkType('opencode');
  for (const entry of opencodeSessions) {
    this.opencodeSessionIds.add(entry.id);
  }
}
```

#### 2B.3: Update `setupSessionStatusBroadcasting()`

Add OpenCode session status broadcasting alongside Claude:
```typescript
// OpenCode session statuses
for (const sessionId of this.opencodeSessionIds) {
  const subscribers = this.opencodeSubs.getSubscribers(sessionId);
  if (subscribers.size > 0) {
    const isRunning = this.opencodeService.isRunning(sessionId);
    this.broadcast({
      type: 'session_status',
      sessionId,
      sessionPath: sessionId,
      status: isRunning ? 'streaming' : 'idle',
      lastActivity: new Date().toISOString(),
    });
  }
}
```

#### 2B.4: Update `handlePrompt()` — add OpenCode routing

After the Claude session check, add:
```typescript
if (this.opencodeSessionIds.has(sessionPath)) {
  await this.handleOpencodePrompt(clientId, sessionPath, message.message, message.images);
  return;
}
```

#### 2B.5: Add `handleOpencodePrompt()` method

Mirror `handleClaudePrompt()` but simpler (no busy-wait needed since OpenCode handles its own queuing):
```typescript
private async handleOpencodePrompt(
  clientId: string,
  sessionId: string,
  prompt: string,
  _images?: ImageContent[],
): Promise<void> {
  try {
    await this.opencodeService.sendPrompt(
      sessionId,
      prompt,
      (normalizedEvent) => {
        const piEvent = normEventToPiFormat(normalizedEvent);
        const message = { type: 'session_event', sessionId, event: piEvent };
        const subscribers = this.opencodeSubs.getSubscribers(sessionId);
        if (subscribers.size > 0) {
          for (const subId of subscribers) {
            this.sendMessage(subId, message);
          }
        } else {
          this.sendMessage(clientId, message);
        }
      },
      (error) => {
        const subscribers = this.opencodeSubs.getSubscribers(sessionId);
        if (error) {
          for (const subId of subscribers) {
            this.sendMessage(subId, { type: 'error', message: error.message, code: 'OPENCODE_ERROR' });
          }
        }
        for (const subId of subscribers) {
          this.sendMessage(subId, {
            type: 'session_event',
            sessionId,
            event: { type: 'agent_end', result: null, usage: {} },
          });
        }
      },
    );
  } catch (error) {
    this.sendMessage(clientId, {
      type: 'error',
      message: error instanceof Error ? error.message : 'OpenCode prompt failed',
      code: 'OPENCODE_ERROR',
    });
  }
}
```

#### 2B.6: Update `handleAbort()` — add OpenCode routing

```typescript
if (this.opencodeSessionIds.has(sessionPath)) {
  this.opencodeService.abort(sessionPath);
  const subscribers = this.opencodeSubs.getSubscribers(sessionPath);
  for (const subId of subscribers) {
    this.sendMessage(subId, {
      type: 'session_event',
      sessionId: sessionPath,
      event: { type: 'agent_end', result: null, usage: {} },
    });
  }
  return;
}
```

#### 2B.7: Update `handleNewSession()` — add OpenCode session creation

Add `'opencode'` case alongside `'claude'`:
```typescript
if (sdkType === 'opencode') {
  try {
    const { sessionId } = await this.opencodeService.createSession(cwd);
    this.opencodeSessionIds.add(sessionId);
    this.clientViewingSession.set(clientId, sessionId);
    this.opencodeSubs.subscribe(clientId, sessionId);
    this.clientCwd.set(clientId, cwd);

    this.sendMessage(clientId, {
      type: 'session_created',
      sessionId,
      sessionPath: sessionId,
      sdkType: 'opencode',
    });
  } catch (error) {
    this.sendMessage(clientId, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Failed to create OpenCode session',
      code: 'SESSION_CREATE_FAILED',
    });
  }
  return;
}
```

#### 2B.8: Update `handleSwitchSession()` — add OpenCode routing

Add OpenCode session detection alongside Claude:
```typescript
let isOpencodeSession = this.opencodeSessionIds.has(sessionPath);
if (!isOpencodeSession) {
  const entry = await registry.get(sessionPath);
  if (entry?.sdkType === 'opencode') {
    isOpencodeSession = true;
    this.opencodeSessionIds.add(sessionPath);
  }
}

if (isOpencodeSession) {
  if (oldSessionPath && oldSessionPath !== sessionPath) {
    this.opencodeSubs.unsubscribe(clientId, oldSessionPath);
    this.claudeSubs.unsubscribe(clientId, oldSessionPath);
    this.multiSessionManager.unsubscribeClient(clientId, oldSessionPath);
  }
  this.clientViewingSession.set(clientId, sessionPath);
  this.opencodeSubs.subscribe(clientId, sessionPath);
  await this.replayOpencodeHistory(clientId, sessionPath);
  return;
}
```

#### 2B.9: Add `replayOpencodeHistory()` method

```typescript
private async replayOpencodeHistory(clientId: string, sessionId: string): Promise<void> {
  const registry = getSessionRegistry();
  const entry = await registry.get(sessionId);
  if (!entry) {
    this.sendMessage(clientId, { type: 'error', message: 'OpenCode session not found', code: 'SESSION_NOT_FOUND' });
    return;
  }

  this.sendMessage(clientId, {
    type: 'session_switched',
    sessionId,
    sessionPath: sessionId,
    sdkType: 'opencode',
    model: entry.model ?? '',
    messages: [],
    fileTimestamp: 0,
    isStreaming: this.opencodeService.isRunning(sessionId),
  });

  try {
    const events = await this.opencodeService.getReplayEvents(sessionId);
    
    if (events.length === 0) return;

    this.sendMessage(clientId, { type: 'history_start', sessionId });
    for (const evt of events) {
      this.sendMessage(clientId, {
        type: 'session_event',
        sessionId,
        event: evt,
      });
    }
    this.sendMessage(clientId, { type: 'history_end', sessionId });
  } catch (error) {
    console.error(`[replayOpencodeHistory] Error:`, error);
  }
}
```

#### 2B.10: Update `handleGetSessions()` — include OpenCode sessions

Add OpenCode sessions to the sessions list, alongside Claude:
```typescript
// Also load OpenCode sessions from the registry
try {
  const opencodeEntries = await this.opencodeService.listSessions();
  const formattedOpencodeSessions = opencodeEntries.map(entry => ({
    id: entry.id,
    path: entry.id,
    sdkType: 'opencode' as const,
    firstMessage: entry.firstMessage || '',
    messageCount: entry.messageCount || 0,
    cwd: entry.cwd || '',
    name: undefined,
    createdAt: entry.createdAt || new Date().toISOString(),
    lastActivity: entry.lastActivity || new Date().toISOString(),
  }));
  allSessions = [...allSessions, ...formattedOpencodeSessions];
} catch (e) {
  console.warn('[handleGetSessions] Failed to load OpenCode sessions:', e);
}
```

#### 2B.11: Update `handleSetModel()` — OpenCode model change

```typescript
if (this.opencodeSessionIds.has(sessionPath)) {
  // OpenCode model changes may need to go through their config API
  // For now, just update the registry
  this.sendMessage(clientId, {
    type: 'error',
    message: 'Model change for OpenCode sessions is not yet supported',
    code: 'NOT_IMPLEMENTED',
  });
  return;
}
```

#### 2B.12: Update `handleDisconnect()` — cleanup OpenCode subscriptions

```typescript
this.opencodeSubs.unsubscribeAll(clientId);
```

#### 2B.13: Update auth handler — send OpenCode availability

After Claude availability, also send OpenCode availability:
```typescript
void this.opencodeService.isAvailable().then(async (available) => {
  if (available) {
    const setup = await this.opencodeService.validateSetup();
    this.sendMessage(clientId, {
      type: 'opencode_available',
      available: setup.ok,
      error: setup.ok ? null : (setup.error ?? null),
    });
  } else {
    this.sendMessage(clientId, {
      type: 'opencode_available',
      available: false,
      error: 'OpenCode not installed',
    });
  }
}).catch(() => {
  this.sendMessage(clientId, {
    type: 'opencode_available',
    available: false,
    error: 'OpenCode availability check failed',
  });
});
```

### 2C: Config and Health Endpoint Changes

**File:** `server/src/routes/health.ts` (or equivalent)

Add OpenCode health status to the ready/health endpoint:
- `opencodeAvailable: boolean`
- `opencodeServerRunning: boolean`
- `opencodeServerUrl: string | null`

**Testing for all of Phase 2:**
- Update `server/tests/unit/websocket/connection.test.ts` — add tests for OpenCode routing in handleNewSession, handleSwitchSession, handlePrompt, handleAbort.
- Add `server/tests/unit/websocket/opencode-integration.test.ts` for focused OpenCode routing tests.
- Run `npm run typecheck` and `npm run lint` after all changes.

---

## 6. Phase 3 — Client Integration

These changes make OpenCode sessions visible and usable in the browser UI. Can be partially parallelised.

### 3A: Session Store Changes

**File:** `client/src/store/sessionStore.ts`

**Changes:**
1. Update `Session.sdkType` type to include `'opencode'`:
   ```typescript
   sdkType?: 'pi' | 'claude' | 'opencode';
   ```
2. No event handling changes needed — the server already normalises OpenCode events into the same format the client expects. The client is runtime-agnostic by design.
3. Handle `opencode_available` message in the connection handler (similar to `claude_available`).

### 3B: Sidebar / Session List

**File:** `client/src/components/Sidebar/SessionItem.tsx` (or equivalent)

**Changes:**
- Show an icon or badge for `sdkType === 'opencode'` sessions (like Claude sessions have a badge).
- Ensure clicking an OpenCode session triggers `switch_session` the same way Claude sessions do.

### 3C: Session Creation UI

**File:** `client/src/components/Session/` or equivalent session creation component.

**Changes:**
- Add "OpenCode" option alongside "Pi" and "Claude" in the new session creation flow.
- Only show the option if `opencode_available` is true (from server message).
- Send `{ type: 'new_session', cwd, sdkType: 'opencode' }` when selected.

### 3D: Model Selector

**File:** `client/src/components/StatusBar/ModelSelector.tsx` (or equivalent)

**Changes:**
- For OpenCode sessions, either show the OpenCode-configured model or disable model selection with a tooltip explaining that model changes are managed through OpenCode config.
- This can be a simple conditional: if `session.sdkType === 'opencode'`, show current model as read-only.

### Client Testing

- Update `client/` unit tests for sessionStore if any exist.
- Update E2E tests (Phase 5).
- Manual verification: create OpenCode session, see it in sidebar, switch to it, send a message.

---

## 7. Phase 4 — Permission Bridge

This is the highest-value UX differentiator over Claude Direct. Can be done after Phase 2 and Phase 3.

### 4A: Server Permission Event Handling

**File:** `server/src/opencode/opencode-event-adapter.ts` (update)
**File:** `server/src/opencode/opencode-service.ts` (update)
**File:** `server/src/websocket/connection.ts` (update)

**Changes:**
1. **Event adapter:** Map OpenCode permission request SSE events to a new `permission_request` NormalizedEvent:
   ```typescript
   {
     type: 'permission_request',
     sessionId,
     timestamp,
     data: {
       permissionId: '...',
       toolName: '...',
       args: {...},
       description: '...',
     }
   }
   ```

2. **Connection handler:** When receiving a `permission_request` normalised event:
   - Convert to `extension_ui_request` format (reuse the existing Pi extension approval dialog):
     ```typescript
     {
       type: 'extension_ui_request',
       request: {
         id: permissionId,
         type: 'confirm',
         method: `opencode.permission.${toolName}`,
         params: { description, args, toolName },
         timeout: 120000,
       }
     }
     ```
   - Broadcast to subscribers.

3. **Service:** Add `extension_ui_response` handling for OpenCode permission replies:
   - In `connection.ts` `handleExtensionUiResponse()`, detect if the response is for an OpenCode permission (by checking the method prefix or a lookup table).
   - Call `opencodeService.replyPermission(sessionId, permissionId, approved)`.

### 4B: Client Permission Dialog

**File:** `client/src/components/Extensions/` (or equivalent)

**Changes:**
- The existing `extension_ui_request` handling should work out of the box if we map OpenCode permissions into that format.
- May need to add OpenCode-specific UI text (e.g., "OpenCode wants to run: bash 'npm install'").
- Verify that the approval response flows back correctly through `extension_ui_response`.

### Permission Testing

- Unit test: `server/tests/unit/opencode/opencode-permissions.test.ts`
  - Test: SSE permission event → normalised event → extension_ui_request.
  - Test: extension_ui_response → OpenCode permission reply API call.
- E2E test: test permission approval flow (may need mock OpenCode server).

---

## 8. Phase 5 — End-to-End Testing and Polish

### 5A: Unit Tests for All New Server Modules

Create under `server/tests/unit/opencode/`:

| Test File | Covers | Priority |
|---|---|---|
| `opencode-process-manager.test.ts` | Process lifecycle, health checks, restart | High |
| `opencode-client.test.ts` | API calls, auth, error handling | High |
| `opencode-event-adapter.test.ts` | SSE event → NormalizedEvent mapping | High |
| `opencode-history-replay.test.ts` | Message → replay event conversion | High |
| `opencode-session-subscribers.test.ts` | Subscriber tracking | Medium |
| `opencode-service.test.ts` | Service orchestration | High |
| `opencode-permissions.test.ts` | Permission bridge | Medium |

### 5B: Integration Tests

Create `server/tests/integration/opencode/`:

| Test File | Covers |
|---|---|
| `opencode-session-lifecycle.test.ts` | Create session → prompt → receive events → abort → follow-up |
| `opencode-history-replay-integration.test.ts` | Create session, prompt, switch away, switch back, verify replay |

These tests may need a real or mock OpenCode server. Options:
1. **Mock server:** Create a simple Express server that mimics OpenCode's API (recommended for CI).
2. **Real server:** If `opencode` is available, run against real `opencode serve` (for local testing).

### 5C: E2E Tests

Create under `tests/e2e/`:

| Test File | Covers |
|---|---|
| `opencode-session-chat.spec.ts` | Create OpenCode session, send message, see response, abort |
| `opencode-session-switch.spec.ts` | Create OpenCode session, switch to Pi session, switch back |
| `opencode-permission-approval.spec.ts` | Permission dialog appears, approve, see result |

Pattern: follow `claude-session-chat.spec.ts` and `claude-model-selector.spec.ts`.

### 5D: Documentation Updates

| File | Change |
|---|---|
| `README.md` | Add OpenCode Direct as third runtime path |
| `docs/ARCHITECTURE.md` | Add OpenCode to system architecture diagram, runtime paths table |
| `docs/PROTOCOL.md` | Document new `opencode_available` message type, `permission_request` event |
| `CLAUDE.md` | Add OpenCode files to repo map and debugging entry points |
| `DEPLOYMENT.md` | Add OpenCode environment variables, setup instructions |
| `docs/OPENCODE-DIRECT-INTEGRATION.md` | Update status from "proposed" to "implemented", add implementation notes |

### 5E: Existing Test Suite Updates

These existing tests may need updates:

| Test File | Required Change |
|---|---|
| `shared/src/types-dual.test.ts` | Add `'opencode'` SdkType test |
| `server/tests/unit/websocket/connection.test.ts` | Add OpenCode routing tests |
| `server/tests/unit/websocket/claude-ux-fixes.test.ts` | Verify OpenCode doesn't break Claude fix patterns |
| `tests/e2e/dual-sdk-session-creation.spec.ts` | Add OpenCode session creation E2E test |
| `tests/e2e/core.spec.ts` | Ensure OpenCode sessions appear in session list |

---

## 9. Git Strategy

### Commit ordering

Each phase produces one or more commits. Commits should be:
- **Atomic:** Each commit passes `npm run lint`, `npm run typecheck`, and `npm run build`.
- **Testable:** Each commit includes its own tests or updates to existing tests.
- **Descriptive:** Use conventional commit format.

### Recommended commit sequence

```
1. feat(shared): add 'opencode' to SdkType union
2. feat(server): add OpenCode config variables
3. feat(server): add opencode-types.ts
4. feat(server): add opencode-process-manager with tests
5. feat(server): add opencode-client with tests
6. feat(server): add opencode-event-adapter with tests
7. feat(server): add opencode-history-replay with tests
8. feat(server): add opencode-session-subscribers with tests
9. feat(server): add opencode-service with tests
10. feat(server): add opencodeSessionId to session registry
11. feat(server): wire OpenCode routing in connection.ts
12. feat(server): add OpenCode status broadcasting and health
13. feat(client): add OpenCode session support to sessionStore
14. feat(client): add OpenCode option to session creation UI
15. feat(client): add OpenCode badge in sidebar
16. feat(server): add OpenCode permission bridge
17. feat(client): integrate OpenCode permission approval dialog
18. test: add OpenCode integration tests
19. test: add OpenCode E2E tests
20. docs: update architecture and deployment docs for OpenCode
```

### Parallel execution strategy

Agents can work in parallel on:
- **Commits 4–8** (Phase 1 modules) — fully independent after commits 1–3.
- **Commits 13–15** (Phase 3 client work) — independent of each other, depends on commit 11.
- **Commits 16–17** (Phase 4 permissions) — depends on commit 11.
- **Commits 18–19** (Phase 5 testing) — depends on all code commits being done.

**Maximum parallelism:** Up to 5 agents working simultaneously on commits 4, 5, 6, 7, 8.

---

## 10. Testing Strategy

### Test pyramid

```
         ┌───────────┐
         │   E2E     │  3-5 tests (browser-level)
         │ (Playwright)│
         ├───────────┤
         │Integration│  2-3 tests (multi-module)
         │  Tests    │
         ├───────────┤
         │   Unit    │  30+ tests (per-module)
         │   Tests   │
         └───────────┘
```

### Fixture strategy

Create `fixtures/` files for OpenCode API responses:
- `fixtures/opencode-sse-assistant-turn.json` — sample SSE events for a normal turn
- `fixtures/opencode-sse-tool-use.json` — SSE events with tool invocation
- `fixtures/opencode-sse-permission-request.json` — SSE events with permission request
- `fixtures/opencode-messages-history.json` — sample GET /session/:id/message response
- `fixtures/opencode-session-list.json` — sample GET /session response

**Important:** These fixtures will be created during API testing (Phase 1) and refined as the exact event shapes are discovered.

### Mock strategy

For unit tests, mock:
- `child_process.spawn` — for process manager tests
- `global.fetch` — for client API tests
- `EventSource` / SSE — for event subscription tests
- `SessionRegistryManager` — for service tests

For integration tests:
- Create a mock OpenCode server (`server/tests/helpers/mock-opencode-server.ts`) that:
  - Accepts session creation
  - Accepts prompts
  - Emits SSE events on a schedule
  - Supports abort
  - Emits permission requests

### Running tests

```bash
# Unit tests
npm test -w server -- --grep opencode

# All server tests (ensure no regressions)
npm test -w server

# E2E tests
npm run test:e2e -- --grep opencode

# Full verification
npm run lint && npm run typecheck && npm run build && npm test
```

---

## 11. Edge Cases and Risk Register

### Edge cases to handle

| # | Edge Case | Handling |
|---|---|---|
| 1 | `opencode` binary not on PATH | `isAvailable()` returns false; runtime disabled; UI hides OpenCode option |
| 2 | `opencode serve` fails to start | `start()` throws; error surfaced to user; retry with backoff |
| 3 | `opencode serve` crashes mid-session | Process manager detects crash, auto-restarts; active sessions may lose their turn |
| 4 | SSE connection drops | Client module auto-reconnects SSE; missed events are recovered via message polling on reconnect |
| 5 | Prompt sent while session is already running | OpenCode server handles this (rejects or queues); surface error to user |
| 6 | Abort sent for idle session | No-op; don't error |
| 7 | Session switch during active streaming | Unsubscribe from old SSE events; subscribe to new; live events from old session are dropped |
| 8 | Multiple browser tabs viewing same session | Subscriber fanout handles this (same pattern as Claude Direct) |
| 9 | Server restart while OpenCode sessions exist | `restoreOpencodeSessionIds()` loads from registry; OpenCode server is restarted lazily |
| 10 | OpenCode session deleted externally | Session appears stale in sidebar; handle gracefully when switching to it |
| 11 | Permission request with no browser tabs open | Permission times out in OpenCode; session may hang or auto-deny |
| 12 | Very large history replay | Stream events in batches; use existing `history_start`/`history_end` signals |
| 13 | OpenCode server port conflict | Surface error in health check; suggest changing `OPENCODE_SERVER_PORT` |
| 14 | Auth password mismatch | All API calls fail with 401; surface in health check |
| 15 | Concurrent Pi + Claude + OpenCode sessions | Each runtime has its own subscriber tracker; no cross-contamination |

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| OpenCode SSE event format differs from docs | Adapter produces wrong events | Fixture-based tests; API testing phase; adapter designed for extensibility |
| OpenCode SDK changes API surface | Client calls break | Pin `opencode` version; use raw HTTP (no SDK dep) for resilience |
| Performance of SSE + HTTP polling | Slow UI for large sessions | Cache session status; batch replay events; lazy SSE subscription |
| OpenCode server memory usage | OOM on constrained devices | Monitor via health check; document minimum requirements |
| Permission API shape differs from docs | Permission bridge broken | Test against real server before hardening; fallback to auto-deny |

---

## 12. File Inventory

### New files to create

| File | Phase | Purpose |
|---|---|---|
| `server/src/opencode/opencode-types.ts` | 1A | Shared types |
| `server/src/opencode/opencode-process-manager.ts` | 1B | Server process lifecycle |
| `server/src/opencode/opencode-client.ts` | 1C | HTTP/SSE client |
| `server/src/opencode/opencode-event-adapter.ts` | 1D | SSE → NormalizedEvent |
| `server/src/opencode/opencode-history-replay.ts` | 1E | Messages → replay events |
| `server/src/opencode/opencode-session-subscribers.ts` | 1F | Client subscriber tracking |
| `server/src/opencode/opencode-service.ts` | 1G | Top-level service orchestrator |
| `server/src/opencode/index.ts` | 1H | Barrel export |
| `server/tests/unit/opencode/opencode-process-manager.test.ts` | 1B | Unit tests |
| `server/tests/unit/opencode/opencode-client.test.ts` | 1C | Unit tests |
| `server/tests/unit/opencode/opencode-event-adapter.test.ts` | 1D | Unit tests |
| `server/tests/unit/opencode/opencode-history-replay.test.ts` | 1E | Unit tests |
| `server/tests/unit/opencode/opencode-session-subscribers.test.ts` | 1F | Unit tests |
| `server/tests/unit/opencode/opencode-service.test.ts` | 1G | Unit tests |
| `server/tests/unit/opencode/opencode-permissions.test.ts` | 4A | Unit tests |
| `server/tests/unit/websocket/opencode-integration.test.ts` | 2B | Integration tests |
| `server/tests/helpers/mock-opencode-server.ts` | 5B | Test helper |
| `tests/e2e/opencode-session-chat.spec.ts` | 5C | E2E tests |
| `tests/e2e/opencode-session-switch.spec.ts` | 5C | E2E tests |
| `tests/e2e/opencode-permission-approval.spec.ts` | 5C | E2E tests |
| `fixtures/opencode-sse-assistant-turn.json` | 1D | Test fixture |
| `fixtures/opencode-sse-tool-use.json` | 1D | Test fixture |
| `fixtures/opencode-sse-permission-request.json` | 4A | Test fixture |
| `fixtures/opencode-messages-history.json` | 1E | Test fixture |

### Existing files to modify

| File | Phase | Change |
|---|---|---|
| `shared/src/types.ts` | 0A | Add `'opencode'` to `SdkType` |
| `shared/src/types-dual.test.ts` | 0A | Add opencode test case |
| `server/src/config.ts` | 0B | Add OpenCode config fields |
| `.env.example` | 0B | Add OpenCode env vars |
| `server/src/session-registry.ts` | 2A | Add `opencodeSessionId` field |
| `server/src/websocket/connection.ts` | 2B | Add OpenCode routing (largest change) |
| `client/src/store/sessionStore.ts` | 3A | Add `'opencode'` sdkType handling |
| `client/src/components/Sidebar/` | 3B | OpenCode session badge |
| `client/src/components/Session/` or equivalent | 3C | OpenCode creation option |
| `client/src/components/StatusBar/` | 3D | Model selector for OpenCode |
| `server/src/routes/health.ts` | 2C | OpenCode health status |
| `README.md` | 5D | Third runtime path |
| `docs/ARCHITECTURE.md` | 5D | Update diagrams |
| `docs/PROTOCOL.md` | 5D | New message types |
| `CLAUDE.md` | 5D | Add OpenCode to repo map |
| `DEPLOYMENT.md` | 5D | OpenCode env vars |

---

## 13. Verification Checklist

After all phases are complete, run this full verification:

```bash
# 1. Lint
npm run lint

# 2. Type check
npm run typecheck

# 3. Build
npm run build

# 4. Unit tests
npm test

# 5. E2E tests (if opencode is available)
npm run test:e2e

# 6. Manual verification
npm run dev
# → Create OpenCode session
# → Send a message
# → See streamed response
# → Abort mid-stream
# → Switch to Pi session and back
# → Verify history replay
# → Open second browser tab, verify subscriber fanout
# → Verify permission dialog (if applicable)
```

### Definition of done for first milestone

- [ ] OpenCode sessions can be created from the UI
- [ ] Sessions appear in the sidebar with correct badge
- [ ] Prompts stream responses in real-time
- [ ] Abort stops the current turn
- [ ] Switching away and back replays history correctly
- [ ] Follow-up prompts work after idle
- [ ] Multiple browser tabs see the same session state
- [ ] Pi and Claude sessions continue to work without regression
- [ ] All existing tests pass
- [ ] All new tests pass
- [ ] `npm run lint && npm run typecheck && npm run build` passes
- [ ] Documentation updated

---

## Appendix: API Testing Phase

Before hardening the event adapter and history replay, an agent should run a **discovery phase** against a real `opencode serve` instance to capture actual API responses. Suggested steps:

1. Install OpenCode: `npm install -g opencode` (or equivalent).
2. Start server: `opencode serve --hostname 127.0.0.1 --port 4096`
3. Create a session: `curl -X POST http://localhost:4096/session`
4. Send a prompt: `curl -X POST http://localhost:4096/session/<id>/prompt_async -d '{"message":"Hello"}'`
5. Subscribe to SSE: `curl -N http://localhost:4096/event`
6. Capture all events during a multi-turn conversation with tool use.
7. Get messages: `curl http://localhost:4096/session/<id>/message`
8. Save captures as fixtures.
9. Test abort: `curl -X POST http://localhost:4096/session/<id>/abort`
10. Test permissions: trigger a tool that requires approval, capture the permission event, reply to it.

This discovery phase produces the fixture files listed in the file inventory and validates/refines the type definitions in `opencode-types.ts`.
