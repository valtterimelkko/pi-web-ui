# A1 — 24-hour heap soak harness: build evidence bundle

> Scope: this document reports on building and rehearsing the harness in
> `scripts/heap-soak/` — Gate 0 (preflight) and Gate 1 (compressed micro-soak
> with forced faults). **The 24-hour run itself has not been started**, per
> the task's explicit stop condition. See
> [`docs/plans/ORCHESTRATION-SCALING-READINESS-PLAN.md`](../../ORCHESTRATION-SCALING-READINESS-PLAN.md)
> (Stage A, step A1) for where this fits in the larger programme.

Branch: `heap-soak-harness`, rebased onto `master` at `2302fd25` (see
[Rebase](#rebase-and-typecheck) below). Not merged, not pushed.

## 1. Commits

In application order (oldest first):

- `25f34181` feat(heap-soak): 24h heap soak harness — core logic, driver, supervisor, CLI
- `78bf62e3` feat(heap-soak): zai quota guard; fix inspect-port init-order bug; correct Lane C reasoning
- `d3ba1ad7` fix(heap-soak): Gate 0 registry checksum — distinguish ambient prod traffic from harness interference
- `16eba61c` fix(heap-soak): three real bugs found by a live Gate 1 attempt
- `4d4ac86b` fix(heap-soak): board-pollution fix + production-write audit; DoV gaps closed
- `b60eec1d` fix(heap-soak): exclude the sanctioned Telegram notification channel from the production-write audit
- `5e2e0fcc` refactor(heap-soak): single shared production-write-audit marker; wire audit+board check into the supervisor's own final report
- `4d5df59e` fix(heap-soak): persist the injected-quota-sequence position across a supervisor restart
- `fddd4853` docs(heap-soak): fix stale README claims after later fixes (Lane C, snapshot diff, audit timing)
- `3f5bbb78` feat(heap-soak): fidelity changes — production-matching TasksMax, browser-like WS client, registry seeding
- `504a53ef` fix(heap-soak): close second agent-os leak vector via PATH-based stub
- `4f3d0574` fix(heap-soak): wait for the internal-api socket to exist, not just the token file

Canonical design/usage doc: [`scripts/heap-soak/README.md`](../../../../scripts/heap-soak/README.md).

## 2. Amendments addressed

Three amendments arrived from the coordinator mid-build; all three are
reflected in the commits above and in the README:

1. **Lane architecture** — Lane A (`zai/glm-5.3-flash`) is the sole backbone
   and the only lane that can fail the gates; Lane B (OpenRouter free models)
   is best-effort and never gates a verdict; Lane C (Command Code free
   models) is disabled with a documented reason (see §6). Wave target =
   completed children per wave, with the backbone topping up whenever B/C
   fail, time out, or open their circuit. Hard per-child deadline; time-boxed
   waves; per-lane concurrency caps (`server/src/live-validation/heap-soak/lanes.ts`,
   `wave-target.ts`, `scripts/heap-soak/driver.ts`).
2. **zai quota guard** — hysteresis state machine reading `agent-os
   provider-usage --providers zai-glm --json` (read-only), with normal /
   throttled / paused states, one Telegram ping per transition, CSV columns,
   per-state report sections, and an injectable test sequence for Gate 1
   (`server/src/live-validation/heap-soak/zai-quota.ts`, `scripts/heap-soak/quota-poll.ts`).
3. **Board-pollution fix** — real Agent OS board pollution from soak children
   was root-caused to two distinct mechanisms (not one) and both are closed;
   see §7. A production-write audit runs at the end of Gate 0, at the end of
   Gate 1, and is designed to run at 24h-end too.

## 3. Fidelity changes (parent review, 2026-09-26)

The parent's post-handback review asked for four fidelity changes so the
disposable server behaves like production rather than being throttled by
artefacts this harness itself introduced:

- **a. Admission ceiling.** `TasksMax` raised from an artificial `512` to
  `8192` (production's own cgroup limit); Lane A `maxConcurrent` raised from
  4 to `6`; Lane B stays at `1`. `MemoryMax` unchanged at `6G`. Rationale:
  production reserves 96 PIDs/turn and allows 14 API turns (~1,344 projected
  pids at full admission), comfortably inside `8192` — the harness's own
  `512` cap was producing real `ADMISSION_CAPACITY_EXHAUSTED (pid_pressure)`
  rejections that had nothing to do with the code under test (`scripts/heap-soak/launcher.ts`).
- **b. Browser-like WebSocket client.** `scripts/heap-soak/browser-ws-client.ts`
  implements one long-lived, reconnecting, authenticated `/ws` connection —
  login via `POST /api/auth/login`, cookie JWT, `ws://…/ws` with the matching
  `Origin`/`Cookie` headers `decideWsUpgrade` requires — kept open for the
  whole run, exactly like a browser tab. On by default. Status is written to
  `<run>/ws-client-status.json` each sample tick; Gate 0 and Gate 1 both
  assert it connected. The server-to-browser broadcast path is a known
  historical leak area, so keeping a real subscriber attached matters for
  this test even though the client never issues session actions itself.
- **c. Registry seeding.** `server/src/live-validation/heap-soak/registry-seed.ts`
  (`buildSyntheticRegistry`) generates `DEFAULT_SYNTHETIC_REGISTRY_COUNT =
  1700` synthetic entries pointing at non-existent paths inside the run dir,
  written directly to the isolated `session-registry.json` **before** the
  server boots. On by default. Gate 0 proves both boot and session-listing
  work against the seeded registry (`listed.sessions.length >=
  launch.seededRegistryCount`).
- **d. tsx loader.** Not closed — documented as a known fidelity gap. The
  disposable server's dedicated child process
  (`scripts/validation-server-child.ts`) always runs under `node --import
  tsx …`, even in `--compiled` mode, because that file is itself TypeScript
  and needs a loader to run at all; `--compiled` only changes what it
  *imports* (`server/dist/index.js` vs `server/src/index.ts`). Production
  runs plain `node server/dist/index.js`. Closing this cleanly would mean
  either duplicating `validation-server-child.ts`'s process-group/identity
  teardown logic into a second plain-JS entry point (real risk for code
  shared by every other `validate:server` caller) or building an entirely
  separate launch path that reimplements port reservation, directory
  locking, and teardown recording a second time — out of proportion to
  removing one loader layer. The tsx loader's overhead is small and
  constant, present throughout the run, so it does not change the
  heap-vs-uptime shape being measured, only its absolute baseline slightly.

## 4. Rebase and typecheck

Branch was based on `2cdf4df4`; rebased cleanly onto `master` at `2302fd25`
(four docs-only commits in between — `2cdf4df4`, `e5f54134`, `4608ddd7`,
`d54c68ab`, `2302fd25`). `git rebase master` completed with **no conflicts**
across all 11 then-existing commits.

`npm run typecheck` on the rebased tree: **exit 0** (all five workspace
`tsc --noEmit` steps: shared build, server, client, shared typecheck,
`@pi-web-ui/internal-api-mcp`).

This resolved a worktree-specific discrepancy found during the review: the
worktree's own `server/node_modules` was a real, empty (npm-workspace
hoisting override) directory rather than a symlink into the main checkout,
unlike the top-level `node_modules` (which the worktree setup had already
symlinked). The main checkout's `server/node_modules` pins `zod@3.25.76` for
server-only code, while the shared root `node_modules` resolves `zod@4.4.3`
for everything else — without the nested override, the worktree's `tsc`
picked up the wrong zod major version for `server/src/routes/preferences.ts`
and `server/src/routes/worktrees.ts`, producing 10 errors that do not exist
in the main checkout. Fixed by symlinking `server/node_modules` to the main
checkout's copy, the same way root `node_modules` already was (gitignored;
no repository change). `npm run lint` also passes clean (0 errors; 290
pre-existing warnings in unrelated test files, none touched by this branch).

## 5. Gate 0 — preflight

Two attempts were needed after the fidelity changes landed; both failures
were real bugs, fixed, and re-verified.

**Attempt 2** (`preflight-1790407666165-5b7a5c5d`) — FAILED on the new
registry-seeding check:

```
[FAIL] registry seeding: boot + session listing work with ~1,700 synthetic entries
       — connect ENOENT /root/.../validation/internal-api.sock
```

Root cause: `launchDisposableServer()` waited for the Internal API **token**
file to exist before handing back the client, but not for the **socket**
itself. The server writes the token file well before it finishes booting far
enough to bind the Unix socket (Command Code init, run-receipt recovery, and
session-registry load all happen in between — `server/src/internal-api/server.ts`
`start()`). Fixed in `4f3d0574` by also waiting on `existsSync(socketPath)`
before constructing the client, so every downstream caller (Gate 0, Gate 1,
the driver's first wave) is race-free, not just the callers that happen to
run later in the checklist.

**Attempt 3** (`preflight-1790407842886-0e3906cb`) — **PASS**, all checks
green, including the fixed registry-seeding check
(`seeded=1700 listed=1700`):

| Check | Result |
|---|---|
| isolation: run dir + agent dir outside production paths | PASS |
| disposable server boots under systemd-run | PASS |
| registry seeding: boot + session listing work with ~1,700 synthetic entries | PASS (seeded=1700 listed=1700) |
| inspector reachable on 127.0.0.1 only | PASS |
| forced GC works + post-GC reading | PASS (heapUsed=145,490,720 bytes) |
| small heap snapshot writes and parses | PASS (966k–968k nodes) |
| disk check | PASS (59.8 GB free) |
| telegram test ping accepted | PASS (`[soak] preflight`, HTTP 202) |
| zai quota guard: real provider-usage poll (best-effort) | PASS (percentLeft=87, peakActive=false) |
| lane A (backbone) end-to-end child | PASS |
| lane B end-to-end child (best-effort) | PASS gate (child itself no-tool-call — does not fail) |
| lane C disabled (best-effort) | PASS (documented reason recorded) |
| board pollution fix: zero board entries reference this run (while active) | PASS |
| browser-like WS client connects (login + authenticated /ws) | PASS (`connected:true, messagesReceived:4`) |
| teardown: server/supervisor units gone, verified absent | PASS |
| production-write audit: no changed file references this run | PASS (18 files changed under guarded roots; none referenced this run) |
| no STATIC production file changed | PASS |
| production session-registry.json byte diff (informational) | unchanged |
| isolation: no harness session id leaked into the production registry | PASS |

`Gate 0: PASS (run preflight-1790407842886-0e3906cb)`

## 6. Lane C — disabled, reason on record

Recorded verbatim by Gate 0/Gate 1 on every run (not just asserted here): a
live `commandcode` Pi provider does exist on this host (a Command Code API
key resolves), but Lane C is deliberately left disabled because (1) of the
three free model ids originally named for it, only
`poolside/laguna-s-2.1-free` resolves in the live-generated catalogue — the
other two are absent entirely, so the lane cannot be built as specified even
with fallbacks; (2) that catalogue reports `cost: {input:0,output:0}`
uniformly for all 47 of its models, including unambiguously paid ones (e.g.
Kimi-K3, GLM-5.3, Qwen3.8-Max, DeepSeek-v4-Pro) — there is no
machine-checkable signal this harness could use to guarantee a 24h
unattended run never dispatches a paid id; (3) the account has ~7% monthly
credit left, so an accidental paid call is a real financial risk for a lane
that is best-effort and non-load-bearing by design. This is the conservative
call the original task explicitly allowed for.

## 7. Board-pollution fix — two distinct mechanisms, both closed

Root cause turned out to be two separate paths, discovered live across
successive Gate 1 attempts:

1. **Extension-internal spawns.** The `agent-os-inject` Pi extension spawns
   the real `agent-os` CLI itself on certain lifecycle events. Closed by
   `AGENT_OS_BIN` pointing at a no-op stub (`scripts/heap-soak/agent-os-stub.mjs`)
   plus a fake `$HOME` (`os.homedir()`-based paths in every copied extension
   redirected away from the real `/root`).
2. **Model-run bash commands** (found live in a completed Gate 1 attempt,
   commit `504a53ef`). The extension's injected prompt text separately
   encourages the *model* to run `agent-os recall`/`agent-os capture` itself
   as an ordinary bash tool call. That resolves via `PATH`, not
   `AGENT_OS_BIN`, and reached the real `/root/.npm-global/bin/agent-os`
   shim — confirmed by a real leak: a completed Gate 1 attempt's
   production-write audit caught a real child session id written into
   `/root/agent-os/memory-vault/evidence/usage/usage-ledger.jsonl`
   (`01a0dc82-55ea-775c-a33b-a2887ed8e671`). Fixed by symlinking
   `<run>/bin/agent-os` to the same stub and prepending `<run>/bin` onto the
   server unit's `PATH`, so any invocation of the bare command — extension
   spawned or model-run — resolves to the stub first regardless of which
   mechanism launched it.

Both fixes are verified live: Gate 0 attempt 3 and every subsequent run show
`board pollution fix: zero board entries reference this run` and a clean
production-write audit (see §5, §8).

**Out of scope, by explicit instruction:** the ~97 pre-fix board entries
already on the real board from earlier attempts are not cleaned up here. An
earlier attempt to bulk-remove them via the board's own CLI verbs was
blocked by Claude Code's own safety classifier; per the coordinator's
explicit instruction, "Do not attempt any Agent OS board cleanup; I am
handling that with the owner," no further cleanup was attempted in this
task.

## 8. Gate 1 — micro-soak (clean, unbroken attempt)

Run `micro-1790407952587-63c80325`, started 2026-09-26T07:32:40.216Z,
finished 2026-09-26T07:53:13.658Z (~20.5 min wall time). Launched **after**
every fix in §3, §5 and §7 landed (rebased tree, HEAD `4f3d0574`). Result:
**16/16 steps OK, 0 failed** — the fully clean, unbroken attempt required.

### Prior attempt (for context — superseded)

Attempt 3 (`micro-1790405764826-6e1f05c1`, run **before** the fidelity
changes in §3 and the second agent-os fix in §7 item 2) completed with every
check green **except** the production-write audit, which caught exactly the
leak described in §7 item 2 — this is the run whose failure led to that
fix. For completeness, its full result:

| Check | Result |
|---|---|
| server launched | OK |
| supervisor started (lane B forced bad) | OK |
| supervisor restarted after systemctl kill | OK (before pid=715192, after pid=734040) |
| server PID unchanged across supervisor restart | OK (714969 → 714969, no reset) |
| CSV continues growing after reattach | OK (rows 14 → 22) |
| deliberately leaked a child | OK |
| orphan sweep deleted the leaked child | OK |
| report generated with a verdict line | OK (`INCONCLUSIVE`, trailing slope 1567.92 MB/h, 115 samples, peak 729.8 MB — expected on a 20-min compressed schedule, see §9) |
| zai quota guard: normal→throttled→paused→normal, one event per transition | OK (`["normal → throttled","throttled → normal","normal → throttled","throttled → paused","paused → normal"]`) |
| zai quota guard: report shows per-state slope/duration | OK |
| board pollution fix: zero board entries reference this run (while active) | OK |
| **production-write audit** | **FAIL** — leak into `memory-vault/evidence/usage/usage-ledger.jsonl` (see §7) |
| teardown: units stopped/verified absent | OK |
| no STATIC production file changed | OK |

### This attempt (clean)

| Check | Result |
|---|---|
| server launched | OK (unit=pi-web-ui-soak-server-micro-1790407952587-63c80325, pid=857367) |
| supervisor started (lane B forced bad) | OK |
| supervisor restarted after systemctl kill | OK (before pid=857707, after pid=861846) |
| server PID unchanged across supervisor restart (no reset) | OK (857367 → 857367) |
| CSV continues growing after reattach (no reset) | OK (rows 14 → 21) |
| deliberately leaked a child | OK (sessionId=01a0dca4-cfb5-7232-8790-f917efee1982) |
| orphan sweep deleted the leaked child | OK (orphan_swept event seen, session gone) |
| report generated with a verdict line | OK (`INCONCLUSIVE`, trailing slope 1042.47 MB/h, 115 samples, peak heap 602.2 MB — expected on a 20-min compressed schedule, see §9) |
| zai quota guard: normal→throttled→paused→normal, one event per transition | OK (`["normal -> throttled","throttled -> paused","paused -> normal"]` — three transitions this run vs. five in the superseded attempt; both are valid traversals of the same declared sequence, differing only in which polling loop happened to consume which injected reading) |
| zai quota guard: report shows per-state slope/duration | OK |
| board pollution fix: zero board entries reference this run (while active) | OK |
| browser-like WS client connected throughout the run | OK (`connected:true, connectCount:1, reconnectCount:0, messagesReceived:1857`) |
| **production-write audit** | **OK** — 27 file(s) changed under the guarded roots during the run (ambient host activity); none referenced this run, across **84** harness session ids checked. This is the check that failed in the superseded attempt; it is clean here, confirming the §7 item 2 fix. |
| teardown: units stopped | OK (serverGone=true, supervisorGone=true) |
| teardown: units verified absent | OK |
| no STATIC production file changed | OK |

`gate1-status.json`: `"done": true`, 16 steps, 16 ok, 0 failed.

## 9. Known limitations (unchanged from README)

- `eventLoopLagMsProxy` is a CDP round-trip time, not a true in-process
  event-loop-lag measurement (no passive CDP method exists for that);
  labelled as a proxy everywhere it appears.
- Snapshot comparison groups by constructor/node type (the standard cheap
  approximation), not a full retainer-graph/dominator analysis.
- The micro-soak's 20-minute compressed schedule cannot produce a
  `leak`/`stable` verdict under the declared rule (`DEFAULT_VERDICT_RULE`:
  10 MB/h sustained over a 12h trailing window, ≥1h of data required) — an
  `INCONCLUSIVE` verdict on a micro run is expected and correct, not a
  harness defect; only the real 24h run can produce a load-bearing verdict.
- Lane C (Command Code) is disabled; see §6.
- The ~97 pre-fix board entries are not cleaned up here; see §7.

## 10. What is explicitly NOT done

- The 24-hour run has **not** been started.
- The branch has **not** been merged or pushed.
- No further Agent OS board cleanup was attempted (owner is handling this
  directly, per explicit instruction).

## 11. Parent review (review session `fc35fbf1-…`, 2026-09-26)

**Verified by the parent, not taken from reports:**
- The heap-holding server process (the `--inspect` child, not the unit's npx wrapper) runs with `NODE_OPTIONS=--max-old-space-size=4096`, a fake `HOME`, an isolated `PI_CODING_AGENT_DIR`, `AGENT_OS_BIN` pointing at the stub, and a run-local `BOARD_STORE_DIR` (read from `/proc/<pid>/environ` during attempt 3).
- Gate 1 attempt 4 `gate1-status.json`: `done: true`, 16/16 OK, read directly.
- Master `npm run typecheck` exits 0; the typecheck failure reported earlier came from the worktree's `server/node_modules` setup.
- The `scripts/validation-server.ts` change is additive, off by default and bound to loopback.

**Parent changes:**
- `0b2d6fb1`: a third Agent OS leak vector. A repo-anchored `npm --prefix /root/agent-os run agent-os …` call bypasses both `AGENT_OS_BIN` and the PATH stub, so `AGENT_OS_VAULT_ROOT` now points at an empty per-run vault.
- `1b6615df`: heap-threshold snapshots at 1 GiB and 2 GiB post-GC heap, persisted in run-state (TDD, 4 tests). Reason: see below.

**Interpretation correction.** §8 calls the Gate 1 slope "expected on a 20-min compressed schedule". It is not simply expected. Readings are post-forced-GC, and heap grew 146 → 620 MB, steadily through waves after warm-up (295 → 620 MB over the last 13 minutes), without returning during idle stretches, while 84 children were created and deleted (about 5–6 MB retained per child). That is an early signal consistent with production's uptime growth, not a conclusion: the run is short, includes warm-up, and the sampler and snapshot machinery may contribute. It is exactly what the 24 h run and the snapshot comparison must settle. At this rate a long run could reach the heap cap before the scheduled mid-run snapshot, hence the threshold snapshots.

**Not re-run by the parent:** Gate 1 itself (its result was read from the status file). Gate 0 is re-run by the parent after merge, to cover `0b2d6fb1` and `1b6615df` on the merged tree.
