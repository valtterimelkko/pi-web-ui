FROZEN

# W-A: catalogue-script restart path — complete

Worker: sole writer in worktree `/root/pi-web-ui-wt-restart`, branch `task/restart-path` (base master 7c87147).
Commit: `e9f4b09` — `fix(command-code): weekly refresh restarts only when the live busy-session count is zero` (2 files, +109/−18). **Not pushed, not merged.** Production untouched; no live API writes.

## What changed (file:line, as committed in e9f4b09)

`scripts/command-code-weekly-refresh.ts`:

- L65: new constant `RESTART_REASON = 'weekly command-code catalogue refresh'`.
- L88, L110: `WeeklyRefreshPaths.restartScript` added; defaults to `<repo>/scripts/restart-pi-web-ui.sh` (script is executable, `flock -n` in the lock wrapper is non-blocking, so the existing 60s `run` timeout still applies).
- L94–96: dependency seam `createInternalApiClient` changed from `getCapacity()` to `listSessions(): Promise<{ sessions?: ReadonlyArray<{ busy?: boolean }> }>`.
- L347–391 (step 8): idleness is now decided from `client.listSessions()` — `GET /api/v1/sessions` — counting entries with `busy === true` (L367–372). A non-array `sessions` field throws inside the probe (L369) and any probe error is caught (L374–377); both leave `idle === false`, so the restart is deferred, never taken. When idle, the restart is `run(paths.restartScript, ['--reason', RESTART_REASON], …)` (L380) instead of `run('systemctl', ['restart', 'pi-web-ui'], …)`; the deferral warn at L387 now names the sessions probe.
- Header docstring (L16–22) updated to match. `--dry-run`, `--no-restart`, `--no-git`, `--json`, the `committed` gate, the 30-minute wait window / 30s poll, and the busy⇒defer branch semantics are all unchanged.

`server/tests/unit/command-code/command-code-weekly-refresh.test.ts`:

- L231–301: new `describe('idle decision from live busy sessions')` with 5 tests (below). Default fake client switched to `listSessions` → `{ sessions: [] }`; restart assertions moved from `systemctl` to the wrapper path (`/tmp/restart-pi-web-ui` via `testPaths().restartScript`); test (b) keeps a no-direct-`systemctl` regression guard. No helper file was extracted — the existing `createInternalApiClient` seam made extraction unnecessary.

## RED evidence (before implementation; fakes then carried both `getCapacity→{activeTurns:0}` and `listSessions`, forcing the old capacity path down its idle branch)

`npm test --workspace=server -- tests/unit/command-code/command-code-weekly-refresh.test.ts` → exit 1, `Tests 5 failed | 9 passed (14)`:

1. `defers the restart while any live session reports busy` — AssertionError: expected true to be false (`restarted` was true; old code restarted on capacity 0).
2. `restarts through restart-pi-web-ui.sh with the named reason when every live session is idle` — AssertionError: expected [] to have a length of 1 but got +0 (old code called `systemctl`, not the wrapper).
3. `defers the restart when the live sessions probe throws` — AssertionError: expected true to be false.
4. `defers the restart when one busy session sits among idle ones` — AssertionError: expected true to be false.
5. `defers the restart when the sessions response is malformed` — AssertionError: expected true to be false.

## Green evidence

Same command after implementation: exit 0, `Test Files 1 passed (1)`, `Tests 14 passed (14)` (9 pre-existing + 5 new). Full RED→GREEN note: between RED and GREEN the fakes' dead `getCapacity` stubs were removed and existing restart assertions moved from `systemctl` to the wrapper path; the five case assertions themselves are unchanged from the RED run.

## Gates — exact commands and exit statuses

From `/root/pi-web-ui-wt-restart`:

- `npm test --workspace=server -- tests/unit/command-code/command-code-weekly-refresh.test.ts` → exit 0 (14/14 pass)
- `npm run typecheck` → exit 0 (all workspaces, including server and internal-api-mcp)
- `npm run lint` → exit 0 (0 errors; 304 pre-existing repo-wide warnings, none in the two touched files)

## Deliberately not done

- No `npm install` (node_modules is symlinked from the main checkout), no push, no merge, no branch creation.
- No extraction of a helper file under `scripts/` — not needed for testability.
- No change to `packages/internal-api-mcp/src/internal-api-client.ts` or `server/src/live-validation/internal-api-client.ts` (both already expose `listSessions()`; the script imports the latter).
- No change to `scripts/restart-pi-web-ui.sh` (used as-is; its default branch takes the production lock via `with-production-lock.sh`, and the `--reason` lands in the journal and stop-audit file).
- No touch of `/capacity` anywhere: the script no longer consults `activeTurns` at all.
- No production restart, no live validation, no other repo writes beyond the two owned files (plus this handback).

## Uncertainty / residual risk

- Premise correction (not a blocker): the brief said the client class is `packages/internal-api-mcp/src/internal-api-client.ts`; the script actually uses `InternalApiClient` from `server/src/live-validation/internal-api-client.ts` (default `new InternalApiClient()` at the same seam). Both have `listSessions()` returning the sessions response with the per-session `busy?: boolean` flag (`server/src/internal-api/types.ts` L658, `ListSessionsResponse` L808), so the required shape exists on the client the script really uses.
- `busy` is additive-since-1.25.0 and optional. An older server that omits `busy` reports every session as not-busy, i.e. the script would trust it and restart. That is the same trust the old code placed in `activeTurns`, but worth knowing: the fix assumes the running server is new enough to populate `busy`. A defensive "at least one entry with a defined busy field" precondition could be added later if the operator wants the script to refuse restarts against pre-1.25.0 servers.
- The wait loop still defers (rather than fails) when the probe cannot determine idleness — same shape as the old error path and the same "committed changes take effect at the next ordinary restart" contract. Exit code stays 0 on deferral.
- The wrapper's `--dry-run`/`--no-lock` modes are not exercised by this script; only `--reason` is passed, which is the mode the brief specified.
- Restart timeout remains 60s; the lock is non-blocking (`flock -n`, exits 75 if held) so this cannot hang the weekly job, but a held lock surfaces as a thrown "restart failed (exit 75)" and the run reports failure after a successful commit/push — same failure semantics as before for a failed restart command.
