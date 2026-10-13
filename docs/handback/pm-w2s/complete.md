STATUS: complete

BRANCH / BASE SHA / HEAD SHA: claude/pm-w2s / 8bc93e3e17e3c5e013f3568b406a4cae3ba67967 / (this commit's parent is the code head; see `git log` — hand-back commit `HANDBACK w2s: complete` is the head)

COMMITS (base..code head):
- 4a80661 W2-a: stable top-level goalId on goal_state/goal_end; no goal_end from a NEVER_STARTED receipt
- ccbf089 W2-b: stalled-goal monitor — goal_state {stalled:true, stalledForMs} after GOAL_STALL_MINUTES idle, once per episode
- 47933d9 W2-f: admission refusals tipped over by quarantined leases carry reason quarantined_debt + counts (status/code unchanged)
- c2e487a W2: contract 1.62.0 (goalId, stalled goal_state, quarantined_debt) — docs, snapshot, pins, exception row
- (next) W2-b: hold the stall monitor in a const holder (lint:ratchet prefer-const)

FILES CHANGED: server/src/internal-api/{goal/goal-id.ts (new), goal/goal-stall.ts (new), goal/types.ts, event-broker.ts, admission-controller.ts, run-receipts/run-receipt-manager.ts, routes/sessions.ts, watch/watch-manager.ts, server.ts, types.ts, error-codes.ts}; tests: goal/goal-id.test.ts, goal/goal-stall.test.ts, admission-quarantine.test.ts (new), goal/goal-routes.test.ts, watch-never-started.test.ts, session-routes-orchestration.test.ts, contract-stability-window{,-guard}, command-code-contract.test.ts; docs/INTERNAL-API.md, docs/INTERNAL-API-CONTRACT.md, docs/contract/internal-api-client-snapshot.json (regenerated: +goalId/stalled/stalledForMs only). Nothing outside owned paths (server/src/claude/** untouched — no Claude adapter edit was needed).

DESIGN NOTES (deviation-free, but worth knowing):
- goalId is minted centrally from observed projections (goal/goal-id.ts), not per adapter: active projection with new fingerprint(objective+startedAt) or after rotate() → new id; terminal/idle → carries the recorded (old) id. start handlers for Claude/Antigravity/Command Code (route + create-with-goal) call rotate(); Pi relies on startedAt. Stamped by a broker `eventEnricher` (covers every publish path incl. the Wave-K sweep, Pi bridge, nudger, sweepers) and by the GET/POST /goal reads. Persisted under `<receipts-parent>/goal-continue/goal-ids/`.
- Stall monitor: runtime-neutral, fed by every broker event (activity) + goal_state(running); only goals past the threshold are re-read. Arms once a running goal is observed since boot (a Pi goal already running at boot arms when the Wave-K sweep/bridge/GET publishes or reads it).
- Quarantine: AdmissionCapacityError gains `quarantine`; body helper `admissionRefusalFields()` used by all 3 refusal builders; `RunReceiptManager.getQuarantinedByRuntime()` added. Original `reason` on the error object (and thus 429/503 mapping) is unchanged.
- The pre-existing restart-reconciliation synthetic goal_end (interruptedByRestart) is NOT a NEVER_STARTED path and is untouched.

TDD (RED → GREEN; files run with `cd server && npx vitest run <file>`):
- goal-id store/broker stamping (goal-id.test.ts): RED exit 1 (module missing, "Failed to resolve"/no tests) → GREEN exit 0 (8 passed).
- NEVER_STARTED no goal_end (watch-never-started.test.ts 'W2-a: …'): RED exit 1 ("expected 2 to be 1") → GREEN exit 0 (4 passed).
- stalled goal (goal-stall.test.ts, 8 tests: not before / at threshold, once per episode, re-arm on busy, activity resets, non-running forgets, fake-timer start/stop, per-session isolation, config default 10/min 2): RED exit 1 (module missing) → GREEN exit 0 (8 passed).
- quarantined_debt (admission-quarantine.test.ts, 6 tests): RED exit 1 ("c.setQuarantineSource is not a function", 6 failed) → GREEN exit 0 (6 passed).
- Disclosure: route-level tests added AFTER the implementation (not RED-first): goal-routes 'contract 1.62.0 (W2-a) — stable goalId' (Antigravity start→clear→restart on a reused session; events+GET), goal-routes 'W2-b … through the route wiring' (fake Date/setInterval, GOAL_STALL_MINUTES=2), session-routes-orchestration 'W2-f: a batch refusal tipped over by quarantined leases …'. Each passes (exit 0); they exercise wiring the unit tests cannot.

GATES (container; foreground):
- npm run lint → exit 0 ("✖ 310 problems (0 errors, 310 warnings)")
- npm run typecheck → exit 0; npm run build → exit 0
- npm test → exit 0 reported by test-workspaces but server suite "Tests 3 failed | 7555 passed | 37 skipped (7595)"; failing set IDENTICAL to baseline (below). Baseline (clean worktree of 8bc93e3, own npm ci): "3 failed | 7530 passed | 37 skipped (7570)"; +25 tests = my new tests, all passing. Other workspace: "249 passed (249)".
  Failing in both: build-hooks (does not write generated manifests…), parent-resolver (runSs explicit maxBuffer), extension-factory-cache (rewrites <inline:> labels…) — the three known container failures; list in baseline-failures.txt. claude-sdk-signature-pin passed this time.
- npm run lint:ratchet -- --base 8bc93e3 → first run exit 1 (my own prefer-const on `let goalStallMonitor`, sessions.ts:846) → fixed (const holder) → exit 0 ("violations": [], checkedChangedFiles 24).
- docs:check-links → OK (1372 links); docs:check-agent-guides → identical.
- Caveat: the full `npm test` ran before the final prefer-const refactor commit; after it I re-ran lint/typecheck/build (exit 0) and `vitest run tests/unit/internal-api/goal tests/unit/internal-api/session-routes-orchestration.test.ts` (385 passed). Parent's host re-run is the authoritative full pass.
- Snapshot regen note: `npx tsx scripts/generate-client-snapshot.ts` fails in this container (ERR_PACKAGE_PATH_NOT_EXPORTED for @earendil-works/pi-coding-agent under tsx CJS) — I ran the same exported `generateSnapshot()` inside vitest instead; client-snapshot-drift + contract-stability-window tests pass. The parent may re-run the script on the host and expect no diff.

CRITERIA:
- goal_state/goal_end carry top-level goalId; new goal on reused session gets new id; old clear carries old id — MET (goal-id.test.ts; goal-routes reused-session test; broker stamping test).
- NEVER_STARTED receipt produces no goal_end — MET (watch-never-started test). Note: a watch that has ONLY a goal_end condition is no longer woken by a never-started run (by design per brief); parents rely on agent_end+runNeverStarted or the real goal end.
- Running goal on idle session emits goal_state {stalled:true} after threshold, not before, once per episode — MET (fake timers: unit + route wiring).
- Admission refusal driven by quarantined debt carries reason:"quarantined_debt" — MET (unit + batch route). Status/code unchanged. runtime_limit attributed per-runtime only. Single-prompt/create paths use the same builder (sendAdmissionRefusal) — covered by shared helper, not separately route-tested.
- Contract 1.62.0 + docs + snapshot + pins — MET. Gates — MET for server/lint/types/build/ratchet as above; baseline-identical failures.
- Must-not-regress: unknown watch condition 400, restart auto-continue/overlay, L1 reconciliation, PROFILE_CAPACITY_EXHAUSTED — existing tests for all pass unchanged.

HOST FOLLOW-UP NEEDED (disposable server only: `npm run validate:server`, then `validate:live`; NOT production):
1. Stall on a real Pi goal child: start the validation server with `GOAL_STALL_MINUTES=2`; create a Pi session, `POST /sessions/:id/goal {"action":"start","objective":"…long idle…"}`, register `POST /sessions/:id/watch {"conditions":[{"type":"event_type","eventType":"goal_state","dataMatch":{"stalled":true}}]}`, make the session go idle with the goal still `running` (e.g. abort the turn / extension idle), wait ~2.5 min; expect one goal_state with `stalled:true,stalledForMs>=120000`, status still `running`, and no second event until the session is busy again. Caveat to confirm: arming requires a running goal_state/GET after boot.
2. goalId on a reused child: start goal A (note `goalId` in the POST response and `GET /goal`), let it end/clear, start goal B on the same session; confirm B's goalId differs, the clear/goal_end of A carries A's id, and a watch with `dataMatch {"goalId":"<B>"}` is not woken by A's goal_end. Also restart the disposable server mid-goal and confirm GET /goal returns the same goalId.
3. quarantined_debt cannot be produced cheaply live; the unit/route tests cover it. If desired: hold quarantined leases via the existing L1 drill and confirm a refused prompt body carries reason "quarantined_debt".
4. Re-run `npx tsx scripts/generate-client-snapshot.ts` on the host and confirm no diff.

NOT DONE AND WHY: Claude/Antigravity/Command Code real-runtime goalId proofs (disposable `all` covers Pi/Claude/OpenCode only; agy needs separate authorisation). No change to server/src/claude/** (no adapter lived there). Per-adapter minting was not used (central observation instead) — flagged as design note, not a deviation from the frozen criteria.

RESIDUAL RISKS:
- goalId minting is observation-based: a same-objective restart on Claude/agy/CC without going through the goal route AND without an observed terminal in between would keep the old id (route starts call rotate(); Pi has startedAt).
- A Pi goal `running` at boot is not stall-tracked until a goal_state/GET is seen for it.
- Idle-clock is fed by broker events; a session busy without any broker-visible events (unobserved browser turn) is only re-armed by the busy sample after the threshold, i.e. could false-positive once, then re-arm.
- Quarantine runtime for entries lacking a recorded runtime is counted as `pi`.
- npm test in this container ran before the last (refactor-only) commit; see gates caveat.

FROZEN
