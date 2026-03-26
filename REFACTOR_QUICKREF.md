# Refactor Quick Reference

## Timeline Overview

```
Week 1: Foundation (W0) + Server Protocol (W1) + Client Protocol (W4) [parallel]
Week 2: Server Events (W2) + Middleware (W3)
Week 3: Client State (W5)
Week 4: Client UI (W6) + Integration (W7)
Week 5: Testing & Docs (W8) + Buffer
Week 6: Staged Rollout + Monitoring
```

## Module Dependency Graph

```
W0 (Foundation)
 ├─→ W1 (Server Protocol) ─→ W2 (Events) ─→ W3 (Middleware)
 │                              │                 │
 │                              └─────────────────┴─→ W7 (Integration)
 │                                                        ↑
 └─→ W4 (Client Protocol) ─→ W5 (State) ─→ W6 (UI) ───────┘
                                                           
                                                            → W8 (Testing)
```

## Parallelization Matrix

| Can Run In Parallel | Must Be Sequential |
|---------------------|-------------------|
| W1.1, W1.2, W1.3 | W0 → W1 |
| W2.1, W2.2 | W1 → W2 |
| W4.1, W4.2, W4.3 | W2 → W3 |
| W6.1, W6.2, W6.3 | W4 → W5 |
| W8.1, W8.2, W8.3 | W5 → W6 |
| W0.1, W0.2 | W6 → W7 |
| W1 ∥ W4 (after W0) | W7 → W8 |

## Key Preservation Points

### 1. Pi SDK Filtering (event-forwarder.ts)
```
✓ getSkillContentInfo() - Detects <skill name="...">
✓ transformSkillContent() - Converts to brief placeholder
✓ mapEventToMessage() - Maps Pi SDK events
✓ Tool message filtering
```

### 2. Verbosity Adjustments (UI Components)
```
✓ SubagentToolCard.tsx - Hierarchical subagent display
✓ CollapsibleToolCard.tsx - Collapsible tool output
✓ MessageBubble.tsx - Activity indicators, filtering
```

### 3. Persistent Multisession
```
✓ multi-session-manager.ts - Background execution
✓ session-pool.ts - Agent pooling
✓ session-watcher.ts - CLI sync
✓ sessionStore.ts - Session state
```

## Git Strategy

### Branch Naming
```
refactor/wave-{N}/module-{M}.{S}-{description}
```

### Tags Per Module
```
refactor/m0.1-jsonrpc-types
refactor/m1.1-jsonrpc-handler
refactor/m1.2-session-websocket
... (26 total modules)
```

### Rollback Command
```bash
# Single module
git revert refactor/m1.2-session-websocket

# Entire wave
git revert refactor/wave-1
```

## Test Requirements Per Wave

| Wave | New Tests | Modified Tests | Preserved |
|------|-----------|----------------|-----------|
| W0 | protocol/*.test.ts | - | - |
| W1 | websocket/*.test.ts, methods/*.test.ts | - | - |
| W2 | - | event-forwarder.test.ts | ✓ |
| W3 | middleware/*.test.ts | sessions.test.ts | ✓ |
| W4 | lib/*.test.ts | - | - |
| W5 | useSessionStream.test.ts | sessionStore.test.ts | ✓ |
| W6 | - | VirtualizedMessageList.test.tsx | ✓ |
| W7 | - | connection.test.ts, e2e/*.spec.ts | ✓ |
| W8 | benchmarks/*.ts | - | - |

## Critical Edge Cases

### Mobile-Specific
- Tab background/foreground → Pause/resume state sync
- Low memory warning → Trigger cache eviction
- Slow network → Compression, event batching
- Rapid session switches → Atomic teardown + identity guards

### Session Management
- Session deleted while connected → Notify + redirect
- Concurrent connections → Multiple subscribers
- Corrupted JSONL → Graceful degradation

### WebSocket
- Network disconnect → Auto-reconnect with backoff
- Server restart → Watchdog detection
- Malformed JSON → Parse error response

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Mobile session switch | 60-120s | <1s |
| Mobile typing latency | 2-5s | <100ms |
| Desktop session switch | 1-3s | <200ms |
| Memory per session | ~15MB | ~5MB |

## Files Summary

### New Files (26)
- `shared/protocol/jsonrpc.ts`
- `server/src/protocol/*` (8 files)
- `server/src/websocket/session-websocket.ts`
- `server/src/pi/session-broadcaster.ts`
- `server/src/middleware/compression.ts`
- `client/src/lib/*` (3 files)
- `client/src/hooks/useSessionStream.ts`
- `docs/PROTOCOL.md`
- `docs/ARCHITECTURE.md`
- `tests/benchmarks/*` (2 files)

### Modified Files (10)
- `server/src/pi/event-forwarder.ts`
- `server/src/routes/sessions.ts`
- `server/src/websocket/connection.ts`
- `server/src/app.ts`
- `client/src/store/sessionStore.ts`
- `client/src/store/chatStore.ts`
- `client/src/components/Chat/VirtualizedMessageList.tsx`
- `client/src/components/Chat/MessageBubble.tsx`
- `client/src/App.tsx`
- `client/src/hooks/useWebSocket.ts` (deprecate)

### Preserved Files (6)
- `client/src/components/Tools/SubagentToolCard.tsx`
- `client/src/components/Tools/CollapsibleToolCard.tsx`
- `client/src/components/Tools/ToolProgressIndicator.tsx`
- `server/src/pi/multi-session-manager.ts`
- `server/src/pi/session-pool.ts`
- `server/src/pi/session-watcher.ts`

## Validation Gates (Per Wave)

Before proceeding to next wave:
1. ☐ All new tests pass
2. ☐ All existing tests pass
3. ☐ No TypeScript errors
4. ☐ No ESLint errors
5. ☐ Manual smoke test
6. ☐ Preservation checklist verified

---

*See REFACTOR_PLAN.md for full details*
