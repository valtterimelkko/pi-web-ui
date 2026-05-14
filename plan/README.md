# Pi Web UI — Claude Channel Integration Plan

> **Goal:** Replace `claude -p` (SDK credit path, limited to $20/month) with interactive `claude --channels` (subscription quota path, generous limits) while preserving identical UI functionality and event fidelity.

## Architecture Summary

```
Current (claude -p, SDK credit):
  Pi Web UI → spawn('claude', ['-p', ...]) → NDJSON parse → NormalizedEvent → WebSocket → Frontend

New (claude --channels, subscription quota):
  Pi Web UI → WebSocket → pi-claude-channel (MCP plugin) → Claude Code interactive
                    ↕ HTTP hooks (PostToolUse, Stop, SessionStart)
```

The channel plugin is a single Bun process that:
1. Serves as an MCP server on stdio (Claude Code's channel)
2. Runs a WebSocket server (Pi Web UI connects here)
3. Runs an HTTP hook receiver (Claude hooks POST tool/stop/session events here)
4. Bridges all three, producing NormalizedEvents identical to the current pipeline

## Dependency Graph

```
                    ┌──────────────────┐
                    │  Module 0:        │
                    │  pi-claude-channel│  ← Bun plugin (standalone, testable alone)
                    │  (MCP + WS + HTTP)│
                    └───┬──────┬───────┘
                        │      │
          ┌─────────────┘      └──────────────┐
          ▼                                    ▼
  ┌───────────────┐                  ┌──────────────────────┐
  │ Module 2:      │                  │ Module 9:             │
  │ WS Client      │                  │ Hooks Config Manager  │
  │ (Pi→plugin)    │                  │ (settings.json)       │
  └───────┬───────┘                  └──────────┬───────────┘
          │                                      │
          │                ┌─────────────────────┘
          │                ▼
          │      ┌──────────────────────┐
          │      │ Module 1:             │
          │      │ Process Manager       │
          │      │ (Claude lifecycle)    │
          │      └──────────┬───────────┘
          │                 │
          ▼                 ▼
  ┌───────────────┐  ┌──────────────────────┐
  │ Module 3:      │  │ Module 4:             │
  │ Event Adapter  │  │ Channel Service       │  ← Core orchestration
  │ (plugin→Norm)  │  │ (same API as current  │
  └───────┬───────┘  │  ClaudeService)        │
          │          └──────────┬───────────┘
          │                     │
          └─────────┬───────────┘
                    ▼
          ┌──────────────────────┐
          │ Module 5:             │
          │ ClaudeService Refactor│  ← Add channel path toggle
          │ (existing file)       │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │ Module 6:             │
          │ connection.ts         │  ← Add permission_request
          │ Amendments            │     handling for Claude
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │ Module 7:             │
          │ Frontend Integration  │  ← Permission approval UI
          │ (minimal changes)     │
          └──────────────────────┘
```

## Parallelization Strategy

### Phase 1 — Can Run Simultaneously (No Dependencies Between Them)
| Agent | Module | Task |
|-------|--------|------|
| Agent A | **Module 0** | Build the `pi-claude-channel` Bun plugin (MCP + WebSocket + HTTP receiver) |
| Agent B | **Module 2** | Build `claude-channel-ws-client.ts` (WebSocket client for Pi → plugin) |
| Agent C | **Module 3** | Build `claude-channel-event-adapter.ts` (plugin events → NormalizedEvent) |

### Phase 2 — Depends on Phase 1
| Agent | Module | Depends On |
|-------|--------|------------|
| Agent D | **Module 1** | Module 0 complete (plugin exists, ports known) |
| Agent E | **Module 9** | Module 0 complete (hook endpoint URLs known) |

### Phase 3 — Depends on Phase 2
| Agent | Module | Depends On |
|-------|--------|------------|
| Agent F | **Module 4** | Modules 1, 2, 3 complete |

### Phase 4 — Depends on Phase 3
| Agent | Module | Depends On |
|-------|--------|------------|
| Agent G | **Module 5** | Module 4 complete |
| Agent H | **Module 8a** (Unit tests M0–M4) | Modules 0–4 complete |

### Phase 5 — Depends on Phase 4
| Agent | Module | Depends On |
|-------|--------|------------|
| Agent I | **Module 6** | Module 5 complete |

### Phase 6 — Depends on Phase 5
| Agent | Module | Depends On |
|-------|--------|------------|
| Agent J | **Module 7** | Module 6 complete |
| Agent K | **Module 8b** (Integration + E2E tests) | Module 6 complete |

## Execution Command

Use `orchestrate` tool with this plan file. Maximum parallel agents per phase is noted above.

After each phase completes, verify with `npm run lint && npm run typecheck && npm run build && npm test` before proceeding to the next phase.

## Files Created (New)
| File | Module |
|------|--------|
| `pi-claude-channel/server.ts` | M0 |
| `pi-claude-channel/package.json` | M0 |
| `pi-claude-channel/tsconfig.json` | M0 |
| `pi-claude-channel/.claude-plugin/plugin.json` | M0 |
| `server/src/claude/claude-channel-process-manager.ts` | M1 |
| `server/src/claude/claude-channel-ws-client.ts` | M2 |
| `server/src/claude/claude-channel-event-adapter.ts` | M3 |
| `server/src/claude/claude-channel-service.ts` | M4 |
| `server/src/claude/claude-channel-hooks-config.ts` | M9 |

## Files Modified (Existing)
| File | Module | Change |
|------|--------|--------|
| `server/src/claude/claude-service.ts` | M5 | Add channel toggle; delegate to channel-service |
| `server/src/claude/index.ts` | M5 | Export new modules |
| `server/src/websocket/connection.ts` | M6 | `permission_request` handling for Claude |
| `server/src/config.ts` | M5 | New config: `CLAUDE_CHANNEL_ENABLED`, `CLAUDE_CHANNEL_PORT`, `CLAUDE_CHANNEL_HOOK_PORT` |
| `.env.example` | M5 | Document new env vars |
| `client/src/store/sessionStore.ts` | M7 | Handle `permission_request` for Claude |
| `client/src/components/` | M7 | Permission approval UI component (if needed) |

## Files Retired / Kept
| File | Action |
|------|--------|
| `server/src/claude/claude-process-pool.ts` | **KEPT** — fallback path; can coexist with channel |
| `server/src/claude/claude-event-normalizer.ts` | **KEPT** — still used when channel disabled |
| `server/src/claude/claude-history-replay.ts` | **KEPT** — unchanged (same JSONL format) |
| `server/src/claude/claude-session-store.ts` | **KEPT** — unchanged (same JSONL format) |
| `server/src/claude/claude-session-subscribers.ts` | **KEPT** — unchanged |

## Testing Gate

Before ANY merge to main, ALL of these must pass:
```bash
npm run lint          # Zero errors
npm run typecheck     # Zero errors
npm run build         # Clean build
npm test              # All unit + integration tests pass
npm run test:e2e      # All E2E tests pass (Claude channel path + fallback path)
```

## Key Architectural Decisions

1. **Channel + subprocess coexistence:** The channel path and the current `claude -p` path coexist behind a config flag (`CLAUDE_CHANNEL_ENABLED`). This allows gradual rollout and easy fallback.

2. **Same NormalizedEvent contract:** The channel produces the EXACT same NormalizedEvent instances. `connection.ts` and `sessionStore.ts` see no difference.

3. **Same persistence format:** JSONL files in `~/.pi-web-ui/claude-sessions/` use the same schema. History replay is unchanged.

4. **Permission relay via extension_ui_request:** Claude permission requests through the channel are converted to the existing `extension_ui_request` protocol message type that Pi Web UI already handles.

5. **Single Claude process multiplexing:** One long-lived `claude --channels` process handles all sessions. The plugin routes messages by `sessionId` through the WebSocket. If single-process becomes a bottleneck, spawn per-cwd.

## See Also
- `plan/MODULES.md` — Detailed module specifications with interfaces
- `plan/TESTING.md` — Testing strategy, test files to create/modify
