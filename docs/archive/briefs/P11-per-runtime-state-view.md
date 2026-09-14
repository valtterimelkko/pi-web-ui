# P11 — Per-runtime worker state view (close F3, the Claude blindness)

## The finding (F3, from the Phase 5 validation)

`docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` §7 records it: the talker's state view
is **Pi-manager-based for every runtime**. `TalkerSessionRegistry.buildSnapshot`
reads only the Pi `MultiSessionManager`, so when the worker is a **Claude** session
the talker reports the honest-but-blind *"worker session is not loaded on this
server"* — correct by design ("say when it cannot tell"), and the relay path is
unaffected, but **status conversation about a Claude worker is empty**.

The operator has now asked for this to be shipped. It was previously set aside;
**it is now in scope.** Correct any note that says otherwise.

## What exists already (read these)

- `server/src/talker/session-registry.ts` — `buildSnapshot(workerSessionId)` at ~line
  250 reads `this.manager.getSessionStatus(id)` and
  `this.manager.getAgentSession(id)?.messages` for the last assistant text. Note the
  `snapshotProvider` seam already exists (~line 234), and the registry **already keys
  sessions by `${runtime}:${workerSessionId}`** with
  `TalkerRuntime = 'pi' | 'claude' | 'antigravity'`. So the runtime is known — this is
  a **dispatch problem, not a redesign.**
- `server/src/claude/claude-service.ts` — `getSession(sessionId)` exists; find the
  accessors that give equivalent status and last-assistant-text.
- `server/src/talker/state-view.ts` — the `WorkerStateSnapshot` shape the talker
  consumes. Do not change its contract unless you must; if you do, say why.

## The bounded outcome

**The talker's status view reflects the worker's real runtime, and stays honest where
it cannot.**

1. **A per-runtime snapshot provider.** Pi keeps its current behaviour exactly.
   Claude gains a real provider via `claudeService`. Antigravity and any other runtime
   either gains a provider or **keeps the honest fallback** — do not fake one.
2. **Honesty is preserved, not traded away.** This is the whole risk of the change:
   the current Claude behaviour is *honest but blind*, and it must not become
   *confident and wrong*. If the provider cannot obtain state, the snapshot must still
   say so plainly. A snapshot must never imply activity it has not observed.
3. **Read-only.** This observes worker state; it must not drive, steer, or alter the
   worker, the relay, the gate, or any delivery path.

## Invariants that must not be softened

- The **release gate is untouched**: `release()` stays private with one caller,
  `takeForRelease` stays atomic and staleness-enforcing.
- No change to what the talker may *do* — only to what it can *see*.
- The Pi path's behaviour is unchanged (prove it with its existing tests).
- Unknown runtime or unavailable state → honest fallback, never an invented status.

## Live proof required

Unit tests are not sufficient here — the finding came from a live run, and so must
the fix. The Claude SDK path on a **profiles-enabled disposable validation server**
was already proven working (P6 held a real Claude relay with a 95-byte byte-equal
instruction), so use that route:

- run a **real Claude worker** on a disposable server,
- ask the talker a status question about it,
- and show the snapshot now carrying **real** Claude state instead of the blind
  fallback — quoting the talker's reply and the snapshot record behind it.

Then prove the reverse for a runtime you did *not* implement: the fallback still
says plainly that it cannot tell.

## Owned paths (yours)

- `server/src/talker/session-registry.ts`, `state-view.ts` (and `talker.ts` only if a
  wiring change is genuinely needed)
- The runtime service accessor you read from (`claude-service.ts`) — **read it freely;
  change it only if a read-only accessor is genuinely missing**, and report exactly
  what you added
- Their tests

## Off-limits

- **Production.** Disposable validation servers only.
- The release gate, delivery adapters, and the relay path.
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — evidence record; do not rewrite it.
  Your closure belongs in your report (the parent records it).
- **No new lint warnings**: CI enforces a ratchet ceiling of 1738 (currently 1736).
  Check with `node scripts/check-lint-ratchet.mjs --base HEAD` before reporting.
- Two siblings are working concurrently in `scripts/` (P9 browser E2E, P10
  observability). **Do not edit anything under `scripts/`** — if you need a probe,
  put it in `/tmp`.

## Evidence you must return

- Exact commands and exit codes.
- RED-first evidence: a test that fails for the right reason before the fix
  (e.g. a Claude worker yielding the blind fallback when real state exists).
- The **live Claude proof**: the talker's reply and the snapshot behind it, quoted.
- The **honest-fallback** proof for an unimplemented runtime.
- Proof the Pi path is unregressed (its existing tests).
- The ratchet result showing no new warnings.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
