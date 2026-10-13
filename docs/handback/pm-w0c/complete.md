STATUS: complete
BRANCH / BASE SHA / HEAD SHA: claude/pm-w0c / 34471c790674f9287bd4449422a7a03d36dd9d3a / fa50ba3 (plus this hand-back commit)
COMMITS:
  7e41540 RED w0c: tests for profile cap default, accessor, admission refusal, capacity/models fields
  cb5db19 W0-c: refuse at profile cap before the run (PROFILE_CAPACITY_EXHAUSTED), default 8, advertise on /capacity and /models; contract 1.61.0
  fa50ba3 W0-c: update command-code contract version pin to 1.61.0
FILES CHANGED: 19 files, +387/-15 (git diff --stat 34471c7...fa50ba3). Source: claude-profiles.ts, claude-sdk-service.ts, claude-service.ts, internal-api/{error-codes,types,watch/watch-manager}.ts, routes/{models,sessions}.ts. Docs: INTERNAL-API-CONTRACT.md, INTERNAL-API.md, contract snapshot JSON.
  Outside the owned list (disclosed): docs/contract/internal-api-client-snapshot.json (regenerated, drift test requires it); server/tests/unit/internal-api/contract-stability-window{,-guard}.ts (new exception row + re-based shape SHA, required for any minor bump); server/tests/unit/command-code/command-code-contract.test.ts (hard-coded version pin 1.60.0 -> 1.61.0).

DESIGN NOTES
- ClaudeSdkService.getProfileCapacity(id)/getProfileCapacities() (read-only); ClaudeService delegates. DEFAULT_PROFILE_MAX_CONCURRENT = 8 in claude-profiles.ts (schema default + in-service fallback). In-service throw kept as last-line guard.
- routes/sessions.ts: profileCapacityFull(entry) checked (a) single prompt/follow_up when dispatchMode==='prompt', before claimDirectDispatch/beginRun; (b) batch prompt entries before beginRun; (c) watch-wake dispatch before beginRun (PROFILE_CAPACITY_EXHAUSTED added to the watch manager's TRANSIENT_WAKE_ERRORS). steer never checks. 429 + Retry-After + body profileId/maxConcurrent/active/retryAfterSeconds.
- Create-with-goal re-enters the prompt route internally, so it inherits the check; there is no separate create-time initial-prompt path in this tree.
- /capacity: claudeProfiles[]; /models: Claude profile:<id> entries get maxConcurrent.

TDD (all in server/):
- default is 8: claude-profiles.test.ts "parses a valid native-env GLM profile" (asserts 8). RED: npx vitest run <4 files> -> exit 1 (8 failed); GREEN: exit 0.
- accessor: claude-sdk-service-integration.test.ts "reports per-profile capacity and active turns". RED exit 1 / GREEN exit 0.
- 3rd prompt refused 429, no receipt: session-routes-profile-capacity.test.ts "refuses a prompt at the profile cap ... creates no run receipt" (checks no nonterminal run and findExistingRun for the idempotency key is undefined, sendPrompt not called); also follow_up, batch entry, admit-below-cap.
- steer at cap works: same file, "still steers a busy session at the cap" (202 accepted, claudeService.steer called).
- /capacity and /models: same file "GET /capacity advertises claudeProfiles"; models-route.test.ts selector test extended (maxConcurrent 3 and 8).
- RED run (before implementation): 8 failed | 65 passed (exit 1). GREEN: npx vitest run tests/unit/claude tests/unit/internal-api -> only baseline-flaky + snapshot drift failures, snapshot regenerated, then all green (see full run).

GATES
- npm run lint -> 0 errors (310 pre-existing warnings), exit 0
- npm run typecheck -> exit 0
- npm run build -> exit 0
- npm run lint:ratchet -- --base 34471c790674f9287bd4449422a7a03d36dd9d3a -> exit 0 ("violations": [])
- npm run docs:check-agent-guides -> exit 0; npm run docs:check-links -> exit 0 (1371 links)
- npm test (full, foreground-equivalent):
  baseline (before any change): server 3 failed | 7523 passed | 37 skipped. Failing: build-hooks.test.ts (does not write generated manifests ...), parent-resolver.test.ts (runSs collects small output intact), extension-factory-cache.test.ts (rewrites <inline:> labels ...). List: docs/handback/pm-w0c/baseline-failures.txt. Note: scripts/test-workspaces.mjs stops at the failed server workspace, so client/shared/mcp suites did not run in either baseline or after.
  after (at cb5db19): 4 failed | 7529 passed | 37 skipped; the same 3 plus command-code-contract.test.ts (hard-coded '1.60.0' pin) -> fixed in fa50ba3; that test and the contract-stability-window / client-snapshot-drift / contract-version-drift tests re-run green (31 passed, exit 0). I did NOT re-run the whole suite after fa50ba3 (a one-line test-only change); the parent's host run is authoritative.
  Flaky note: claude-sdk-signature-pin.test.ts "object-signature query() does not trigger the misuse abort" failed in two isolated runs (also on the base commit in a clean worktree) yet passed in both full runs. It exercises the real SDK and is unrelated to this change.

CRITERIA
- (a) default 8: met. (b) third prompt at cap 2 refused 429 PROFILE_CAPACITY_EXHAUSTED, no run receipt: met (unit level with a mocked ClaudeService capacity; the real counter path is covered by the accessor test, not by one end-to-end test). (c) /capacity + /models fields: met. (d) steer at cap works: met.
- Existing contract + error-code list tests green: met. Unknown watch condition types still 400, NEVER_STARTED / restart auto-continue tests untouched and green in the full run: met (no edits to them).
- Gates: met except the pre-existing baseline failures above; client/shared/mcp test workspaces not run by the harness after the server failure.

OWNER-DECISION FLAG: the contract stability window requires an owner-decision row per minor bump. I recorded the decision as "PARENT-ORCHESTRATION-MACHINERY-PLAN W0-c (finding F8; owner plan of record)" in INTERNAL-API-CONTRACT.md and the guard test. The parent must confirm that is acceptable or rename it.

HOST FOLLOW-UP NEEDED
- Agent OS mirror sync for 1.61.0 (parent does it; see INTERNAL-API-CONTRACT.md "Downstream mirrors").
- Disposable-server live proof: `npm run validate:server`, with a claude-profiles.json whose Sonnet SDK profile has no maxConcurrent (=> 8). Then `npm run validate:live -- --socket <sock> --token-path <token> --runtime claude --scenario <id>` driving 3 and 4 concurrent Sonnet child runs: all accepted, none RUNTIME_ERROR; GET /capacity shows claudeProfiles[].active rising.
- Same server with that profile set to maxConcurrent: 2: start two long turns, dispatch a third -> HTTP 429 PROFILE_CAPACITY_EXHAUSTED with Retry-After, `GET /runs` (or the session's receipts) shows no new receipt for it; steer on a busy session at the cap still 202.
- Raise ~/.pi-web-ui/claude-profiles.json (parent's step, not mine).

NOT DONE AND WHY: no live/host validation (no Pi Web UI server in the cloud container). Client/shared/MCP test workspaces unexecuted by the harness. No web client change (the client does not read the new fields).
RESIDUAL RISKS
- Check-then-act race: two prompts can pass the pre-check simultaneously and the loser still hits the in-service throw (RUNTIME_ERROR). The in-service counter is incremented only inside sendPrompt, after the route check. Closing it fully needs an atomic reservation across the route and the service; not attempted (design said keep the throw as last line).
- `active` counts running SDK turns for the profile; a session wired through the browser WebSocket path shares the counter, so Internal API callers may be refused because of browser turns (intended: same cap).
- Hot-reloaded profile changes are read per call, so the advertised cap follows reloads.
FROZEN
