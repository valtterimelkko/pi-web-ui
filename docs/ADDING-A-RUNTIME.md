# Adding a New Runtime to Pi Web UI

> Checklist for integrating a fourth backend runtime alongside Pi Coding Agent, the Claude runtime family, and OpenCode Direct.

## 1. Shared Types

- Add the new `SdkType` value in `shared/src/types.ts` and `shared/src/protocol-types.ts`.
- Add any runtime-specific metadata fields to shared session/message types if needed.

## 2. Registry Integration

In `server/src/session-registry.ts`:
- Add a lookup helper like `getByNewRuntimeSessionId(newRuntimeSessionId: string)`.
- Ensure `RegistryEntry` can store the runtime's native session ID.

## 3. Server Module Family

Create a new directory: `server/src/newruntime/`

Recommended files (copy from `server/src/opencode/` as the cleanest template):
- `newruntime-service.ts` — Lifecycle, prompt dispatch, replay loading, pinning.
- `newruntime-process-manager.ts` — If the runtime is a long-lived server process.
- `newruntime-client.ts` — HTTP/API client (if applicable).
- `newruntime-event-adapter.ts` — Convert native events → `NormalizedEvent`.
- `newruntime-history-replay.ts` — Convert native history → replay events.
- `newruntime-session-subscribers.ts` — Multi-viewer fanout.
- `newruntime-types.ts` — Runtime-specific types.

### Must-implement service methods

```typescript
interface RuntimeService {
  createSession(cwd: string): Promise<{ sessionId: string; nativeSessionId: string }>;
  sendPrompt(sessionId: string, prompt: string, onEvent: (e: NormalizedEvent) => void, onComplete: (err?: Error) => void): Promise<void>;
  abort(sessionId: string): void;
  isRunning(sessionId: string): boolean;
  getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>>;
  isAvailable(): Promise<boolean>;
  validateSetup(): Promise<{ ok: boolean; error?: string }>;
  pinSession(sessionId: string): Promise<boolean>;
  unpinSession(sessionId: string): boolean;
  isSessionPinned(sessionId: string): boolean;
}
```

## 4. WebSocket Router Integration

In `server/src/websocket/connection.ts`:
- Add a `Set<string>` for the new runtime's session IDs.
- Add subscriber tracker instance.
- Restore session IDs from registry on startup (like `restoreClaudeSessionIds()` / `restoreOpencodeSessionIds()`).
- Add prompt routing in `handlePrompt()`.
- Add abort routing in `handleAbort()`.
- Add session creation in `handleNewSession()`.
- Add status broadcasting in `setupSessionStatusBroadcasting()`.
- Add availability announcement after CSRF auth success.

## 5. Session Transfer Integration

In `server/src/session-transfer/transfer-service.ts`:
- Add source adapter: `extractNewRuntimeTranscript(...)`.
- Add target creation in `createTargetSession()`.
- Add busy check in `isTargetBusy()`.
- Add dispatch in `dispatchToTarget()`.

## 6. REST Endpoints

In `server/src/routes/health.ts`:
- Add runtime availability check to readiness probe.

In `server/src/routes/models.ts`:
- Add model listing endpoint for the new runtime if applicable.

## 7. Client Integration

In `client/src/store/sessionStore.ts`:
- Add availability flag and setter.
- Add `sdkType` handling in `session_created`, `session_switched`, etc.

In `client/src/components/Session/NewSessionModal.tsx`:
- Add runtime option to the picker.
- Show availability state.

## 8. Tests

- Unit tests for event adapter and history replay.
- WebSocket routing tests in `server/tests/unit/websocket/`.
- Integration tests for session creation and switching.
- E2E tests if the runtime is available in CI.

## Key Invariants

1. **Always emit `agent_end`.** The frontend unlocks input on `agent_end`. If your runtime doesn't naturally emit this, synthesize it in the adapter or connection handler.
2. **Use `NormalizedEvent`.** All runtimes must feed into the common `normEventToPiFormat()` converter.
3. **Registry is the source of truth for metadata.** Runtime-specific session state lives in your service, but `session-registry.json` owns the cross-runtime index.
4. **Subscriber fanout.** If a session can be viewed from multiple browser tabs, implement a subscriber tracker (see `ClaudeSessionSubscribers` / `OpenCodeSessionSubscribers`).
