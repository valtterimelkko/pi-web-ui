# Watch Defect, Observer Wiring & Production Restart Recovery Brief

## Objective
Fix the zero-token watch system in Pi Web UI so that:
1. Session observers are properly wired on watch registration (`ensureObserver`).
2. Active watches survive production server restarts (`pi-web-ui.service` restart) and remain active with live broker subscriptions.
3. Sessions running in bare CLI or external tools emit updates to the broker via `SessionWatcher`.
4. Parent conductors can reconnect and resume zero-token waiting across production restarts seamlessly.

---

## Background & Defect Analysis

### 1. `ensureObserver` was never passed to `WatchManager`
- **Location**: `server/src/internal-api/routes/sessions.ts:768`
- **Problem**:
  ```ts
  const watchManager = new WatchManager({
    broker,
    storeDir: deps.watchDir,
    pinSession: pinSessionById,
    unpinSession: unpinSessionById,
    dispatchWake: dispatchWatchWake,
    surface: ...,
  });
  ```
  `WatchManagerDeps` defines `ensureObserver?: (sessionPath: string) => void;`, and `WatchManager.registerLocked` calls `this.ensureObserver?.(sessionPath)`. But `routes/sessions.ts` defined `attachPiObserverIfNeeded(sessionPath)` at line 594 and **never passed it** in the options object!
  As a result, registering a watch on a Pi session that wasn't already streaming did not attach the session observer, and broker events never reached `WatchManager`.
- **Fix**: Pass `ensureObserver: attachPiObserverIfNeeded` to `new WatchManager({...})`.

---

### 2. Restart demotes active watches to 'detached' and drops subscriptions
- **Location**: `server/src/internal-api/watch/watch-manager.ts:242-245`
- **Problem**:
  ```ts
  if (migrated.status === 'active') {
    migrated.status = 'detached';
    changed = true;
  }
  ```
  When `pi-web-ui` boots, `watchManager.init()` runs. It blindly demotes all `active` watches to `detached`.
  Crucially, `this.activateWatch(record, resolved)` is **never called**!
  The watch has no live subscription to `broker`, so when the watched session runs or completes after a restart, the watch never fires. Any parent agent long-polling `GET /api/v1/watches/wait` or waiting for an `onFire` wake waits forever or times out.
- **Fix**:
  - Rehydrate active watches on `init()`:
    1. For each persisted watch with `status === 'active'`:
       - Re-resolve its conditions via `resolveConditions(record.conditions.map(c => c.spec))`.
       - Call `this.activateWatch(migrated, resolved)`.
       - Re-acquire subject pin if `migrated.pinned` is true.
       - Re-acquire target pin if `migrated.targetPinned` is true.
       - Call `this.ensureObserver?.(migrated.sessionPath)`.
    2. Downtime reconciliation:
       - If the watch is observing completion (`agent_end` or `status === 'idle'`), check whether the session is already idle/completed in the registry or disk. If it completed while the server was restarting, record the firing immediately so waiting conductors receive the firing on their next wait call.

---

### 3. Native CLI Observation Bridge
- **Location**: `server/src/index.ts:96-115`
- **Problem**: `sessionWatcher` detects file modifications from CLI `pi` instances in `~/.pi/agent/sessions/**/*.jsonl` and broadcasts to WebSocket clients, but never publishes to `InternalApiEventBroker`. Because `WatchManager` only listens to `broker`, sessions run in native CLI (`pi` in tmux) never trigger watches.
- **Fix**:
  - In `server/src/index.ts`, when `sessionWatcher` emits `session_update`, also publish a normalized event to `broker` under both `event.path` and `event.sessionId`.

---

## Child Hierarchy Note
Your previous child worker (`01a08b24`) has finished all its work and is recorded as done in the parent `agent-os board`. You do not need to supervise it. PI BG (`01a08b30`) is kept gated by the parent conductor while you work on `pi-web-ui`.

---

## Requirements & Quality Gates
1. **Strict TDD**:
   - Update and extend `server/tests/unit/internal-api/watch-manager.test.ts`.
   - Add tests verifying:
     - `ensureObserver` is called when registering a watch and when rehydrating.
     - Active watches survive `init()` as `active` and re-subscribe to `broker`.
     - Events published to `broker` after `init()` fire the rehydrated watch.
     - Completed/idle reconciliation works if session settled during restart.
2. **Regression testing**:
   - Run `AUTH_PASSWORD=test npm test -- tests/unit/internal-api/watch-manager.test.ts` and all watch-related tests.
   - Ensure typecheck passes.
3. **Commit & Push**:
   - Commit directly to `master` in `/root/pi-web-ui`.
   - Push to `origin/master`.
   - Run Agent OS capture when complete.
