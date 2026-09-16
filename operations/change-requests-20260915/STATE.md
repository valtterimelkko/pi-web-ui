# STATE — change-request programme (2026-09-15) — current state, not a completion claim

> **NEXT WORK LIVES IN ONE FILE: `docs/plans/PI-WEB-UI-MASTER-PLAN-2026-09-15.md`** (committed). It records
> every owner decision of 2026-09-15 — catalogue-script restart path, card identity + variant gate (contract
> 1.44.0), talkerBus correlation, multi-lane in one tab, plus the three smaller threads — with rationale, files,
> acceptance criteria and sequencing. **All four work items are now built, independently verified and merged
> into master; deployment is the remaining step** (the plan's §6 carries the per-item verdicts). This file
> remains the record of what is already deployed.
>
> **Where the restart root-cause work starts: `ROOT-CAUSE-STARTING-POINTS.md`** (this directory), written
> 2026-09-15 before the merge. It records the proven facts, the search order, and the instrumentation gap.

## 🎯 ROOT CAUSE FOUND (2026-09-15) — the 14:27:05Z restart was self-inflicted by a test red-proof

Full write-up: `ROOT-CAUSE-STARTING-POINTS.md` (now a resolution, not a starting point).

**In one line:** the coordination agent's own new `server/tests/unit/restart-drainage.test.ts` restarted production.
At 14:27:03 it renamed `restart-production.sh` aside and `git stash`-ed `restart-pi-web-ui.sh` back to the version
with no pre-flight and a **bare `systemctl`** call — to prove its tests were red — then ran them. The suite's only
interception was `PI_WEB_UI_RESTART_SYSTEMCTL`, an env seam honoured *by the script under test*, so stashing the
script removed the guard **and** the interception together, and the test executed a real
`systemctl restart pi-web-ui`. It killed the session running it (transcript ends 14:27:03.299Z).

Explains every anomaly: no `RESTART-REQUESTED` because the suite redirects `PI_WEB_UI_STOP_AUDIT_FILE` to its own
temp file (deleted at teardown); clean SIGTERM/exit 0 because it was an ordinary stop job; `NRestarts=0`; their
guard commit 12 minutes *after*, because it was still uncommitted. `/tmp/rp.bak` is still on disk.

**Fixed** `d921ac7` (RED-first): a `systemctl` stub at the front of PATH, sharing the env-stub's log, so
interception cannot be stashed away with the implementation. New test pins it with a **read-only** subcommand so
the suite cannot stop the service even while red. Suite 8/8; related script suites 29/29; positive control shows a
real bare restart line captured by the stub with production untouched.

**Lesson (adopt host-wide):** a red-proof must never run against the tree production executes; a test's ability to
reach a destructive command must not depend on the code under test; and a test that can reach a restart must still
leave a trace in the production audit path.

## ✅ DEPLOYED (2026-09-15 16:37:43Z) — production serves the merged master, contract 1.44.0

| Fact | Value |
|---|---|
| Revision deployed | `c1dedf0` (merged master; pushed to `origin/master`) |
| Contract served | **1.44.0** (was 1.43.0) — read from `/api/v1/capabilities.contract.contractVersion` |
| Restarted at | 16:37:43Z via `scripts/restart-pi-web-ui.sh --reason "deploy merged master c1dedf0: …"` |
| Pre-check | **busy-session count = 0 of 200** from `/sessions` — never `activeTurns` |
| Requester recorded | yes (`RESTART-REQUESTED … reason=deploy merged master c1dedf0 … ancestors=…>pi>…>tmux: server`) |
| Conductor survived | yes — it runs in a `tmux-spawn-*.scope`, outside the service cgroup |

**Three independent verifications of the deploy, because one is not proof:**
1. `/capabilities` → `contractVersion: 1.44.0`.
2. The UI on `:3456` serves **exactly** the freshly built bundle (`index-C67PQPyS.js` — byte-identical name to
   `client/dist/assets/`), and that served bundle contains the merged `lane` and `proposalRef` code.
3. A real headless browser loaded production: `HTTP 200`, title "Pi Web UI", React root mounted, login screen
   rendered, **no page errors** (only the expected pre-auth 401 probe).

**Merged-tree browser proof before deploying** (disposable server :3505 + vite :3507, both driven by the
conductor, evidence kept in `exec-2026-09-15/merge-evidence-20260915/`): lane harness **14/14 verdicts, 8
screenshots**; card harness **9/9 verdicts, 8 screenshots**.

**Agent OS mirror** resynced to 1.44.0 in the same sitting — `agent-os` `88d967e`, pushed; `validate:offline`
Stage H pass, mirror pin tests 10/10. Agent OS does not reference the talker surface at all, so only the marker,
the published example and the pin moved.

**Obsolete worktrees and branches removed** (`wt-restart`, `wt-lanes`, `wt-card`; `task/restart-path`,
`task/multi-lane`, `task/card-identity`) after verifying each was clean and every commit was contained in the
merge — `git branch -d` (the safe form) accepted all three, which is itself the proof they were merged.
The repo now holds only `master`; no disposable scopes or listeners remain on the 35xx range.

**OWNER INSTRUCTION IN FORCE:** the merge/deploy gate was lifted **for this session's work only**, explicitly.
The standing "never merge into master, never restart production" gates otherwise remain — this authorisation
does not transfer to any other agent, and it is not a standing licence for future restarts.

## ✅ MERGED (2026-09-15) — three branches into master, zero conflicts, nothing dropped

`master` = `b4cd12d` = the other agent's `1c05f6f` + three `--no-ff` merges:

| Merge | Branch | What it brings |
|---|---|---|
| `51e6d81` | `task/multi-lane` | multi-lane voice in one tab (W-C + W-D): talkerBus request/lane correlation, lane capture, operator floor |
| `495dd97` | `task/card-identity` | confirmation-card identity bound to the bytes authorised, staleness refusal, `original`-variant gate, **contract 1.44.0** (W-B + W-F(ii)) |
| `b4cd12d` | `task/restart-path` | weekly catalogue refresh restarts only on a zero live busy-session count, and via the audited wrapper (W-A) |

Post-merge gates on the merged tree: **typecheck, lint, build clean; server 4464/4464; client 1349/1349;**
the combined "both agents' restart work together" bundle **47/47**. Ancestry check: **0 commits from any of the
three branches missing from master**. The merged wrapper was exercised end-to-end with `--dry-run` (logs
`RESTART-REQUESTED` with its reason, exits 0).

**Integration fix `28ea8b5`** — found by the merge itself: the other agent's capacity pre-flight now sits in front
of W-A's restart, and the weekly script read *any* non-zero restart exit as a hard failure, so a *correct* refusal
would have been reported as a failed weekly run after the catalogue had already been committed and pushed. Fixed
RED-first: only the wrapper's documented refusal is a deferral; anything else still throws. See the plan §6.

**Owner instruction executed with this merge:** the owner lifted the merge/deploy gate for this session's work
("do restart the production … for those changes to take effect") and asked for root-cause hunting afterwards.
The standing "never merge / never restart" gates therefore do **not** apply to this specific, explicitly
authorised deploy — and this authorisation is not transferable to any other agent or any future restart.

## ✅ DEPLOYED AND VERIFIED (2026-09-15 10:24Z) — production serves `447f43e`, i.e. exactly `master`

> **W3 reviewer findings: see `W3-FOLLOWUPS.md`.** One (deleting punctuation without telling the card) is fixed in
> `447f43e`; three are open and need the owner's decision — the proposal TOCTOU (needs a contract bump), the
> ungated `original` variant (fold into the same work), and `talkerBus` request correlation (scope with lanes).

Everything the children built is merged, pushed, built, deployed and live. Production was restarted three times with
full pre-checks (busy-session count 0, zero in-flight runs) — once to deploy, once to prove the app-side stop
instrument on a real stop, once to make the served build match `master` after the drop-in fix.

| Deliverable | Commit | Live state |
|---|---|---|
| Confirmation card honest-tidying + original-words choice | `0798661` (earlier) | served; validated on a disposable server (rows L1–L7) |
| P27 wire row now pins the card contract | `c298775` | served |
| create-and-pin in one go | `ce6e95f` | served |
| Self-describing stops + shutdown instruments | `d765ecf` | served; **instrument proven live** (see below) |
| Mic single-owner + desktop layout mode | `86ce22b` | served |
| Drop-in directive fix + regression tests | `c390e11` | served; drop-in installed and `systemd-analyze verify` clean |
| Punctuation-honesty fix (W3 finding) | `447f43e` | served; TDD, server suite 383 files / 4429 tests green |
| auto-compact-75 v2.7.0 | `pi-enhancement` `8eb9e01` | extension copied to `~/.pi/agent/extensions` (v2.7.0 verified by md5) |

**Live evidence for the stop instrument (the original incident's blind spot):**

```
[Shutdown] event=stop_signal signal=SIGTERM received_at=2026-09-15T10:18:11.997Z pid=2374961 ppid=1 uptime_s=123
[Server] Shutdown complete in 139ms
STOP-AUDIT phase=post ... service_result=success exit_code=exited exit_status=0
RESTART-REQUESTED ts=... uid=0 user=root pid=... cwd=... reason=... ancestors=...
```

Fired on both restarts of the new build (146ms / 139ms), and the naming wrapper records every requester. The
08:29Z incident's three blind spots — no signal record, no requester, no outcome — are each now answerable.

### ⚠️ Defect found by the conductor during deployment: `ExecStopPre` does not exist

The stability drop-in declared `ExecStopPre=`. **systemd has no such directive**; it ignores unknown keys
*silently*, so the pre-SIGTERM hook never ran and the `phase=pre` line its decision table depended on could only be
produced by running the script by hand. Found by `systemd-analyze verify` on install, not by any test. Fixed in
`c390e11`: the drop-in declares only `ExecStopPost`, the file explains the trap, the decision table is rewritten
around the records that exist, and two regression tests pin it (allow-list of real directives; `ExecStopPre` must
not be declared). RED-verified: the same parser rejects the previously deployed file.

**Merged-tree validation before any push:** typecheck clean · lint 0 errors · server **1429 files / 4424 tests** ·
client **118 / 1268** · mcp **8 / 71** · all passing.

Read this before acting. Rewritten at every fan-in / dispatch.

- **Conductor (current):** `01a0a455-0917-7729-9433-fcd8b4d7556d` (cwd `/root/pi-web-ui`), adopted this
  programme after the original conductor `01a0a410-f683-7422-bc57-055af50db3f2` **crashed after 09:09:56Z**
  (its last recorded goal state: paused, reason "supervising four dispatched children").
- Goal engine: **active on this programme objective, deliberately paused while children run** (owner-approved
  2026-09-15). Wakes do not auto-resume it; resume it once the children settle.
- **PRODUCTION RESTART IS OWNER-GATED AGAIN (owner instruction, 2026-09-15 09:43Z).** Another agent is
  using the Internal API; the owner revoked this session's restart permission so its work cannot be
  interrupted. **Do not restart, do not install the systemd drop-in, do not `daemon-reload`, do not
  `npm run build` into `server/dist`** until the owner says otherwise. Preparation only.
  (Earlier note, now superseded for restarts: the owner had granted session-scoped restart permission;
  that grant no longer applies.)
- Sockets/token: `~/.pi-web-ui/internal-api.sock`, `~/.pi-web-ui/internal-api-token` (API base `http://localhost/api/v1`)
- Main checkout: `/root/pi-web-ui` @ `1f341bd` (parent-owned; **no child edits it**). Note it has moved on from
  `0798661`: `b02c97e` + merge `1f341bd` are **another agent's** model-catalogue work sailing through master.

## Card contract (voice-card programme) — see `../voice-card-20260915/STATE.md`

W1 accepted, committed `0798661`, pushed. **W2b live validation ACCEPTED (08:55Z)** — rows L1–L7 pass with the
recorded bytes; the one FAIL was a stale assertion in `scripts/p27-ws-transport-validate.mjs`, fixed in place by
the previous conductor (**uncommitted, main checkout**). W3 read-only review + build/restart still outstanding.

## Children — adopted from the crashed conductor

| # | Item | Child session | Model now | Worktree / repo | Status | Handback |
|---|---|---|---|---|---|---|
| 1 | autocompact75 handoff from Web UI frontend | `01a0a42e-e5b1-7422-bc57-0560c028e9fd` | **clinepass/cline-pass/glm-5.3-flash** (switched 09:18Z) | `/root/pi-enhancement` (6 files **still uncommitted**, v2.7.0); `wt-handoff` **removed as obsolete** | **turn ended 09:15:01 — handed back, verified** | `child-handoff/complete.md` (+`logs/`) |
| 2 | two-tab voice defect + desktop layout + multi-lane design | `01a0a42e-eb8f-7422-bc57-05640c176744` | **clinepass/cline-pass/glm-5.3-flash** (switched 09:49Z once idle) | `/root/pi-web-ui-wt-voice` → **`4342f9e`** | **turn ended 09:49:00 — handed back, verified, committed**; now running its session-end capture turn | `child-voice/complete.md`, `MULTILANE-DESIGN.md`, evidence/, shots/ |
| 3 | create-and-pin in one go | `01a0a42e-e8c7-7422-bc57-0562a081bbea` | **clinepass/cline-pass/glm-5.3-flash** (switched 09:18Z) | `/root/pi-web-ui-wt-pin` (branch `task/create-and-pin`) | **turn ended 09:14:40 — handed back** | `child-pin/complete.md` (+`logs/`) |
| 4 | production-stop robustness | `01a0a43c-d9cc-74e4-896e-6a5bd3e8986b` | **clinepass/cline-pass/glm-5.3-flash** (switched 09:35Z) | `/root/pi-web-ui-wt-stability` (branch `task/production-stop-robustness`, ~12 files) | **turn ended ~09:33 — handed back** | `child-stability/complete.md` (+`evidence/01–06`) |

Card-contract child `01a0a41e-2e40` and W2b child `01a0a42c-b47d` are finished (W2b now **idle, 251 msgs**).

**Nothing above is verified yet.** The conductor has read the handoff, pin and stability handbacks; it has not
re-run their suites, written its own probes, or committed any of it.

## Model route (owner instruction 09:16Z, supersedes the earlier route table)

- Children run on **`clinepass/cline-pass/glm-5.3-flash`**, thinking `max` (that model advertises only `off|max`).
  Cost 0.15/0.50 per Mtok. Probe at 09:15Z returned `CLINEPASS-PROBE-OK`.
- Why: deepseek "is a bit expensive as of right now" (owner). The previous route table (deepseek-flash with a
  commandcode GLM fallback) is now **historical**.
- **Constraint learned:** although the Pi branch of the control route has no busy guard, `setModel` takes a
  per-session model-change lock — on a session inside a long turn the request **hangs** (8 s, no response, HTTP 000)
  instead of returning 409. Treat model switches as **idle-only**.

## Supervision / wake path (re-registered by this conductor at 09:15:14Z)

| Child | Local watch id | Server generation | Firings | Notes |
|---|---|---|---|---|
| handoff | `ww_1_1789463714628` | `650180ee-14b4-445d-98d7-193d4aa11218` | 0 | turn ended **before** re-registration → no wake can come |
| pin | `ww_2_1789463714665` | `3dcbb7a3-a701-46ea-bf01-bbe46a5a57b0` | 0 | same |
| voice | `ww_3_1789463714704` | `736f9563-fff6-402c-ac42-b20c6551fc1e` | 0 | **the live one** |
| stability | `ww_4_1789463714739` | `ed4f03a3-195e-4cfe-adfc-70225b8c3a2d` | 1 | fired ~09:33; extension logged 1/3 wakes sent |

Old conductor's onFire watches on all four children were **archived** to `watch-ledgers/*.json` and deleted
(the local extension refuses to replace another owner's watch).

**Wake lessons (all observed today, all evidence-backed):**
1. A server-side `onFire` wake to a **busy** conductor queues, produces zero events, and was terminalised
   `TURN_STALLED` at 08:51:10 (run `5a62bf6c`, 15-min idle watchdog) — **the wake was silently lost** and the owner
   got a quarantine notice. Recovered only because the conductor noticed.
2. A **steer** delivered into a busy host can be swallowed: stability's 09:33 wake shows `wakes_sent 1/3` with no
   message ever surfacing in the conductor's conversation.
3. A firing that predates a registration is never re-delivered — so **each wake consumes its watch**; re-register
   after every wake, for every child still running.
4. **Therefore the model-free `wake_deadline` backstop is load-bearing, not belt-and-braces**, and the conductor
   should sit **idle** while children run.

## Active backstop

- `deadline-187122bf-9d48-48c5-815c-57514d5c5707` → **2026-09-15T09:45:18Z** (model-free; message instructs
  full reconciliation of all four children + production health).

## ⚠️ Incident class re-confirmed live: `activeTurns` is NOT a safe restart guard

At **09:40:11Z** `/capacity` reported `activeTurns: 0`, `oldestActiveRunStartedAt: null`, while session
`01a0a42e-eb8f` was **provably mid-turn**: `busy: true`, `status: running`, last activity 09:39:33, session file
written **38.7 s** earlier, and live `tool_execution_*` events in its broker snapshot. Its newest run receipt is
`4c340324` **completed at 08:41:14** — i.e. the child has worked ~59 min with **no admitted run**, invisible to the
admission counter (`stalledRuns` meanwhile rose 5 → 6).

**Consequence:** an idle-aware restart that checks `activeTurns === 0` (the pattern in
`scripts/command-code-weekly-refresh.ts`, the only known restart path, and the credible candidate for the 08:29:56
incident) would restart production and **kill a genuinely working child**. Use the **busy-session count** from
`/sessions` (or cgroup membership) as the pre-check, never `activeTurns` alone. This is reported into the stability
child's scope.

## Incident — 2026-09-15 08:29:56–08:30:50 UTC (production stop)

Something stopped `pi-web-ui.service`; it did not exit within `TimeoutStopUSec=30s`; systemd SIGKILLed the whole
control group and restarted at 08:30:50 (`NRestarts=1`). **Killed with it:** four dispatched children and a
disposable validation server running inside the service cgroup. All four were re-dispatched; see receipts
`4c9ae535`/`e21c272c` (interrupted 08:30:50) for handoff/voice.

Evidence: the previous day's `ShutdownCoordinator` instrument logged **nothing** (no SIGTERM path); no journal trace
of the initiator. `/capacity.activeTurns` accuracy is **not** a sufficient alibi — see the section above.

NEW RULE for all children: run disposable servers/helpers via `systemd-run --scope --collect` so a service restart
cannot take them down. **Live examples to tear down when voice finishes:** `childvoice-server.scope` (port 3491),
`childvoice-client.scope` (vite, port 3499), plus scratch dirs `/tmp/child-voice-*` and the stability child's
`/tmp/child-stability-park`.

## What remains (everything else is delivered and live)

1. **Owner decision — lane shape** for the multi-lane work: one tab holding lanes (recommended) versus a tab per
   lane. Grounded analysis and the code facts are in `LANE-SHAPE-DECISION.md`. Cross-device lanes are **dropped**
   by the owner, so the contract bump is not needed. Until this is chosen, the multi-lane work stays design-only.
2. **Owner review** of `child-voice/MULTILANE-DESIGN.md` and the desktop-mode screenshots in
   `child-voice/shots/` (already reviewed by the conductor and behaving correctly).
3. **Arbitration** on `scripts/command-code-weekly-refresh.ts`: the stability work would like the one repo-owned
   restart path to call `scripts/restart-pi-web-ui.sh` so it names itself. That file belongs to the other agent's
   workstream, so neither the child nor the conductor touched it.
4. **Optional follow-up**: the W3 second reviewer (`bg_mu2i6gln_7ic8ql`) may still report; the conductor has
   already reviewed the card fix directly and signed it off, and it is now deployed and live.
5. **Follow-up found during the extension work**: the Web UI's background-work extensions persist registry
   snapshots into session JSONL through a non-current SessionManager. auto-compact-75 v2.7.0 now tolerates that
   tail, but the host behaviour itself is unaddressed and worth a look.

### Retained for reference (no longer blocking)

The four children are settled and verified; all their change sets are in `master` and deployed. The exported
patches in `parent-verification/patches/` are now historical (the commits are in the repo), and the conductor's
probe `parent-verification/parent-verify-create-and-pin.test.ts` is kept as evidence rather than added to the
repo, since the child's own test file covers the same ground.

The W3 reviewer record: attempt 1 (`sa_mu2ht56a_bkutcr`) timed out with no report (38 turns, 86 tool calls, all
reading — its first turns were spent on Agent OS recall/board calls). Attempt 2 (`bg_mu2i6gln_7ic8ql`) was
re-dispatched with a tight brief. **The conductor reviewed `0798661` directly and found all three claims sound:**
`cleaned` derives from one predicate (`relayHasVisibleRemoval()`), `removed` cannot be the whole utterance
(`normaliseRelayText()` aborts wholesale when a transform would empty the text), and the card payload and release
both come from the pure `describeProposal()` descriptor so they cannot drift.

### Cleanup completed (owner guidance: remove obsolete worktrees promptly)
Removed the obsolete `wt-handoff` worktree + branch; released **all five** retention leases; cancelled every watch
(4 obsolete + the voice one, since its work is committed); left the finished children's board entries. Stopped the
`childvoice-server`/`childvoice-client` scopes, removed the harness playwright symlinks, and deleted the disposable
scratch (`/tmp/child-voice-srv`, `child-voice-workspace*`, `child-voice-profile`, `child-stability-park`, plus the
crashed conductor's transient dispatch/watch/capture payload files in `/tmp`). Ports 3491/3499 are free, no child
scopes remain, and `wt-voice` is clean at `4342f9e` after its session-end capture turn (verified: the capture turn
added no edits).

**Goal engine stays PAUSED deliberately** — not because children are running (they are all settled), but because
the only remaining work is owner-gated; auto-continuation must not push past that gate. Resume it when the owner
releases production. Wakes still reach this session normally.

## Verification progress (conductor, independent)

| Child | Their suites | Conductor probe | Verdict |
|---|---|---|---|
| handoff | ✅ 2/2 named `node --test` files pass; whole-repo `tests/*.test.mjs` **402/403** — the single failure is `pi-extension-api-compat.test.mjs` asserting a *deployed* `/root/.pi/agent/extensions/clinepass/index.ts` that does not exist on this host: **environmental, unrelated to the diff** | code review of `inspectHandoffPin` (pinned byte-prefix + append-only growth; fails closed on rewrite/truncate/partial) | **accepted to test+review level**; conductor did *not* drive the browser/GUI handoff path itself |
| pin | ✅ `wt-pin` client store **24 files / 329 tests pass** | ✅ **own probe** `client/tests/unit/store/parent-verify-create-and-pin.test.ts` (4/4) with 7 stale pins — including a **positive control** that reproduces the original silent drop when `sdkType` is absent, and the `unlink` dead-code case | **VERIFIED** |
| voice | ✅ 24 client files / **239 tests** + **18** server tests pass | ✅ **conductor ran the two-tab browser harness itself** (`conductor-verify` tag, disposable server): `"no leak: one tap released every recorder"`, exit-while-recording released the mic (0 recorders, 0 live tracks). The harness **computes** that verdict from the observation, and the *same* harness reads **"LEAK PROVEN"** on the pre-fix evidence — so the instrument is sensitive and the fix genuinely holds | **VERIFIED** |

Note: a capture of the owner's worktree-cleanup guidance was submitted twice and produced **evidence only**
(`candidates=0`) — the raw record is preserved; the conductor stopped rather than resubmitting a third time.
| stability | ✅ **reproduced by conductor**: 123 files / **1188 tests pass** (`bg_4fb01534`) — matches the child's claim exactly | ✅ **non-restarting instrument check** (see below) | **VERIFIED to suite + instrument level** |

### Stability instruments — conductor verification without a restart (09:44:10Z)

Evidence: `parent-verification/stability-instruments-norestart.txt`. Nothing was installed, nothing was restarted.

1. `scripts/systemd-stop-audit.sh pre` (simulated, `INVOCATION_ID=conductor-verify`) produced a complete
   self-describing record and **exited 0** — invocation id, `SERVICE_RESULT/EXIT_CODE/EXIT_STATUS`, main pid +
   liveness, `ActiveState`/`SubState`/`Result`, `NRestarts=1`, `ExecMainStartTimestamp` (08:30:36Z — today's
   restart), elapsed seconds, and the cgroup process list. The hook cannot fail a stop, which is the critical
   property.
2. `scripts/restart-pi-web-ui.sh --reason "…" --dry-run` logged a fully attributed `RESTART-REQUESTED` line
   (uid, pid, ppid, tty, cwd, reason, argv, ancestor chain) and **did not restart** — the one repo-owned restart
   path can now name itself.
3. Both records landed in the durable audit file `/root/.pi-web-ui/stop-audit.log`.

The simulated `pre` line is clearly marked `invocation=conductor-verify` so it can never be mistaken for a real
stop. **What remains unverified by the conductor:** that a real stop now yields `phase=pre` on both sides
(needs a restart — owner-gated), and the app-side instruments in `server/src/index.ts` (need a build).

Conductor probe file is a **new, conductor-written** test (not the child's); it is untracked in `wt-pin` and must be
removed or kept deliberately when that branch is committed.

## Merge preparation (staged, NOT executed — awaiting the owner's answer)

- `git merge-tree master <branch>` for all four branches → **no conflicts** against `master` @ `1f341bd`.
  (All four branches sit at `0798661` with **no commits** — the children were told not to commit, so their work is
  uncommitted in each worktree. That is why every merge-tree returns master's own tree.)
- Exported change sets for a one-command pick-up: `parent-verification/patches/{pin,stability,voice}.patch` +
  `*-untracked.txt` (new files), and `handoff-pi-enhancement.patch` for the extension repo.
- Sizes: pin 15+/5− (1 file) + 2 new files · stability **14 files, 241+/22−** + **21 new files** · voice
  **15 files, 434+/59−** + 7 new files · pi-enhancement 6 files, 334+/24−.
- Merge shape: apply each set to `master` as a **path-limited commit** (the pattern the card fix already used as
  `0798661`), **excluding** the conductor's probe file and any `operations/` scratch unless deliberately kept.

## Commits made by this conductor (on the children's own branches — master untouched, nothing pushed)

| Branch / repo | Commit | Content |
|---|---|---|
| `task/create-and-pin` (`wt-pin`) | **`039eabf`** | sessionStore merge-not-replace + `changeType` fix; the child's new test file. The conductor's probe is deliberately **left untracked** as evidence. |
| `task/production-stop-robustness` (`wt-stability`) | **`2823c72`** | 14 modified + 21 new files: stop-audit drop-in, signal/escape instruments, restart naming wrapper, cgroup guard, docs, tests |
| `pi-enhancement` (branch `master`, in sync with origin) | *not yet* | 6 files still uncommitted — commit when the extension deploy is scheduled |
| `task/voicemode-multilane-desktop` (`wt-voice`) | **`4342f9e`** | mic single-owner acquisition + teardown on unmount, the "Starting microphone" state, and the desktop split layout with an honest narrow-screen fallback |

`master` @ `1f341bd` is **untouched** and nothing was pushed — the merge/push decision is the owner's and was asked for explicitly.

## Cleanup done (owner guidance: remove obsolete worktrees promptly)

- **Removed** `/root/pi-web-ui-wt-handoff` + branch `task/autocompact75-webui-handoff`: clean, zero commits,
  tree identical to its base — the fix for that item actually lives in `pi-enhancement`. Nothing was lost.
- **Kept deliberately**: `wt-pin` + `wt-stability` (each now holds an unmerged commit) and `wt-voice` (live child
  still writing). Remove each as soon as it is merged.
- **Retention leases released** for the four finished children (W1 card-contract, handoff, pin, stability) — only
  the voice child's lease remains, correctly.
- **Obsolete watches cancelled** for handoff, pin and stability (their turns ended before registration, or their
  one-shot condition had already fired); only the voice watch `ww_3_1789463714704` remains, armed and waiting.
- **Board entries left**: `handoff`, `create-and-pin`, `pi-01a0a43c`, and the crashed conductor `pi-01a0a410`
  (whose live replacement is `pi-01a0a455`). `voice-multilane` stays until the child stops.
- **Still to clean when voice stops**: `childvoice-server.scope` (3491), `childvoice-client.scope` (3499),
  `/tmp/child-voice-*`, and the stability child's `/tmp/child-stability-park`.

## Agent OS captures filed by this conductor (all **pending**, nothing promoted)

`cand-aenx4k6pr4` (horizon: programme state) · `cand-ap5qrdglsb` (ClinePass route) ·
`cand-azqsrf97e7` (three wake failure modes) · `cand-bafq846t4o` (production-stop incident) ·
`cand-cysgu5e99k` (two supersessions) · `cand-bw2j1948cu` (deliverables map) ·
`cand-c6ka1lx6cu` (auto-compact-75 v2.7.0 root cause, `project-pi-enhancement`) ·
`cand-cnn37p9qxe` (role: supervision principle).

## Known traps recorded

- `opencode-go/deepseek-v4.1-flash` is region-blocked on this host (403 RegionError); children ran on
  `deepseek/deepseek-flash` before the ClinePass switch.
- Children in worktrees use symlinked `node_modules` (verified: targeted vitest passes from a worktree).
- The main checkout hosts the children's disposable servers — no child edits it.
- A pre-existing worktree `pi-web-ui-wt-mu2eh2nt-6tiz` has since been pruned; it was never ours.

## EXECUTION RUN — 2026-09-15 11:16Z (conductor 01a0a455)

Executing `docs/plans/PI-WEB-UI-MASTER-PLAN-2026-09-15.md`. **Owner gates: merge to master and production restart are both owner-gated — neither may happen without explicit approval.**

| Child | Item | Session | Thinking | Worktree / branch | Watch | Handback |
|---|---|---|---|---|---|---|
| A | W-A catalogue-script restart path | `01a0a4c7-fb25-7451-bac8-3c913c369475` | high | `/root/pi-web-ui-wt-restart` · `task/restart-path` | `ww_6` | `exec-2026-09-15/A-restart-complete.md` |
| B | W-C/W-D correlation + multi-lane | `01a0a4c8-0262-7451-bac8-3c92897b85ff` | max | `/root/pi-web-ui-wt-lanes` · `task/multi-lane` | `ww_7` | `exec-2026-09-15/B-lanes-complete.md` |
| C | W-F(i) readonly investigation | `01a0a4c8-09b0-7451-bac8-3c94032b227c` | high | none (`/tmp/wt-investigate`) | `ww_8` | `exec-2026-09-15/C-sessionfile-findings.md` |

- Route: **`zai/glm-5.3-flash`** (`pi` + `zai`), verified bound via create response (`resolvedModel`, no fallback). NOT clinepass — that is dashboard-only / excluded by the routing table.
- Retention: durable leases, 8h TTL, ownerId `conductor-20260915-<tag>`.
- Goals armed at creation and read back `running`; watches are `goal_end` filtered by the byte-exact objective plus a `goal_state status=paused` question condition. **No `agent_end`** — it fires per turn boundary and burns the wake budget.
- Backstop: model-free `wake_deadline` `deadline-295e1ba2-1983-4ffb-9f88-3a0de50b3ca6` → 12:16:34Z. Re-arm per window; expiry is not completion.
- Run records: `exec-2026-09-15/children.json`; briefs + objectives in the same directory.
- Wave 2 (after B lands, because it shares the identity path): W-B card identity + staleness refusal + `original` gate + contract 1.44.0 + browser harness; W-F(iii) Agent OS Stage J harness.
- Main checkout `/root/pi-web-ui` is READ-ONLY to this programme; children write only inside their worktrees and the untracked `operations/` records.

### Verification ledger — wave 1

**A — W-A catalogue-script restart path — ACCEPTED (conductor-verified 11:39Z).**
Commit `e9f4b09` on `task/restart-path` (2 files, +109/−18). My own checks, not the child's:
- diff read by me: idleness now `client.listSessions()` counting `busy === true`; malformed or throwing probe leaves `idle === false` ⇒ **defer, never restart**; restart via `restart-pi-web-ui.sh --reason`.
- gates re-run by me: tests **14/14 pass**, `typecheck` exit 0, `lint` exit 0 (0 errors, 304 pre-existing warnings).
- **positive control**: their new tests against `master`'s old source ⇒ **6 failures**, so the tests genuinely detect the defect; source restored, worktree clean.
- integration risks their tests could not catch, checked by me: live `GET /sessions` returns `{sessions:[…]}` with `busy` populated (1925 entries); the script imports the live-validation `InternalApiClient` whose `listSessions()` returns `ListSessionsResponse`; **no other code injects the widened `createInternalApiClient` seam**; `restart-pi-web-ui.sh` documents `--reason`/`--no-lock`/`--dry-run` (read statically — never executed).
- accepted residual risk: on a pre-1.25.0 server that omits `busy`, every session reads as not-busy and the script would restart. Production is 1.43.0 so the field is populated; optional hardening noted, not a blocker.

**B — multi-lane — still running** (busy, 159+ msgs). **C — investigation — still running** (busy, 130+ msgs). Neither is accepted; both watched.

**C — W-F(i) session-file investigation — ACCEPTED (conductor-verified 11:57Z).** Read-only; the only artefact is `exec-2026-09-15/C-sessionfile-findings.md`.
Central claim: extensions persist registry snapshots via `pi.appendEntry`, whose closure holds the SessionManager of the AgentSession that **loaded** them — so a second runtime over the same file leaves an append-only disk tail the live runtime never loads; auto-compact-75's freshness gates detect that tail as "session changed outside this runtime".
My spot-checks of its citations (7 samppled):
- `agent-session.js:2202` — **exact**: `new ExtensionRunner(…, this.sessionManager, …)`. Confirms the binding premise.
- `background-shell/core.ts:680` and `subagent/background.ts:349` — **exact**: unconditional `this.persistNow()` on load-time reconcile.
- `auto-compact-75/index.ts:415–425` — **exact**: `adoptableDiskAhead = appendOnlyDiskAhead === true && fenceOnAppendOnly !== true`, else `fenceOwnership("session changed outside this runtime: …")`.
- `watch-wake/index.ts:236–251` — **exact**: the fingerprint gate (`if (fingerprint === lastPersistedFingerprint) return;`), i.e. the counterexample proving the proposed fix direction already exists in this codebase.
- **Empirical core, verified by me against the production JSONL**: entries `5aaa9bee` (`bg-shell-tasks`, 08:18:52.179Z) and `59e8e57e` (`background-tasks`, 08:18:53.010Z), both `tasks: []`, sitting at entries 156–157 of 158 — exactly the two-entry empty tail the mechanism predicts, and exactly the 157-vs-155 the recorded refusal named.
- **One citation is wrong**: the refusal string is at `session-ownership.mjs:**568**`, not the cited `:557` — an 11-line drift, not a fabrication (the file did not change under the child; source and deployed mirror are byte-identical, mtime 08:55 predates C's 11:16 start). Content verbatim correct.
- Accepted honest gap, declared by the child itself: the **invoking event** behind the 08:18 tail is not identified (a second process is consistent with the journal; an unlogged in-process path cannot be fully excluded). The *mechanism* is proven; the *actor* is not.
- Residual risk set (G1 startup fence still exposed; unbounded growth one pair per runtime open; stale-binding re-queue loop) is recorded as the child wrote it. **No fix scoped** — that is deliberate; the finding is the deliverable.

**B — W-C/W-D lane correlation + multi-lane voice in one tab — ACCEPTED (conductor-verified 13:45Z).**
Branch `task/multi-lane`, 5 commits `d6dcd22`→`56d7d33`, 25 files (+2721/−85), **all under `client/`** (zero `server/` changes — verified by me).
- **My own gate run** (`cond-`logs): client exit 0 **1342/1342**; server exit 0 **4432/4432** (full suite green in my env where the child had seen 4 env-induced failures — its environmental explanation re-run by me and confirmed: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED` → 34/34); typecheck 0; lint 0 errors; build 0.
- **I drove the multi-lane harness myself** — my own disposable validation server (3501) + vite (3503) under a systemd scope outside the service cgroup, my own evidence dir, fresh browser profile. **14/14 verdicts `ok:true`, `final.allOk:true`**, 8 screenshots. Highlights I read in the JSON myself: `floor.noSpeechOverCapture` (capture live → lane B queues, **zero chunks play**), `floor.duckNeverStop` (**0.15 duck observed at the player wire**, intent stays current), `floor.tierThenFifo`, `cap.fourthLaneAsks` (replace-or-cancel, still exactly 3), `cap.replace.inPlace`, `lanes.close.noLeak` (0 recorders, 0 live tracks), `singleLane.collapse`, `strip.floorDuringCapture`.
- **I viewed the screenshots myself**: `04-three-lanes.png` shows the real strip at "3 of 3" with one addressed lane; `03b-strip-floor-during-capture.png` shows the capturing row reading "You have the floor" with the other row announcing the holder during real capture.
- Code claims spot-checked by me in source: `MAX_VOICE_LANES = 3` + `'full'` refusal; correlation rejecting never-issued/duplicate/`stale-order`; the floor coordinator recomputing `[...capturing.values()].some(Boolean)` so a lane unmount **cannot** release another lane's floor.
- **Safety check on its admitted slip**: it ran `git stash pop` by mistake. Verified by me — the stash list still holds exactly one entry (2026-04-03) with **no drop in its reflog**; the pop conflicted and was left alone; the worktree is byte-clean at HEAD. **No other agent's work was lost.**
- Caught during my verification: my own JSON parse reported "0/14" and my earlier CPU sample read the wrong process — both were **my** errors, corrected rather than reported as child failures.
- Open items B declares (not defects, recorded for the owner): a lane removed while its card is open discards the unconfirmed card by design; collapsing to one lane remounts the survivor (pending card/focus resets); the mic-handoff gesture finalises the partial utterance into the FIRST lane's talker (flagged for the owner's eye); two lanes on the same worker session are refused; three-lane heavy-streaming cache limits untested at scale.

**WAVE 1 COMPLETE — all three children independently verified and accepted. Nothing merged, nothing pushed, production untouched (owner gates).**

### WAVE 2 — in flight (dispatched 13:30Z)

| Child | Item | Session | Thinking | Worktree / branch | Watch |
|---|---|---|---|---|---|
| D | W-B card identity + staleness refusal + `original` gate + **contract 1.44.0** + browser harness | `01a0a543-2fac-7451-bac8-3ca063b63bd8` | max | `/root/pi-web-ui-wt-card` · `task/card-identity` **stacked on `task/multi-lane` (`56d7d33`)** | `ww_9` |

- **Why stacked:** W-B and the lane work both change the identity path through `talkerBus`/`useVoiceTurn`. Stacking avoids a conflict in exactly the code where subtle breakage hides. The brief REQUIRES server-side commits to be separate from client-side ones so the critical server fix can be taken onto master alone.
- Brief also forbids regressing the lane work (its 14/14 harness verdicts are the regression net) and forbids writing to `/root/agent-os` (the conductor owns that mirror).
- Backstop: `deadline-2c483c04-eb65-4af9-8061-a028871c2ab5` → 14:30:55Z.

**W-F(iii) Agent OS Stage J — DEFERRED, with reason (conductor decision).** `/root/agent-os` is actively contended: four agents declared there at 13:30Z, one explicitly assigned to that repo ("Phase 1 child: fix board auto-presence prompt sync"). W-F(iii) is the lowest-value item on the plan (a validation-harness environment fix: 30 s client timeout, opencode attempted where disabled, a claude 500), and adding a fifth worker to a contended repo risks colliding with work I do not own. Deferred to a quiet window, or to the operator's discretion — **not dropped, and not silently**. The conductor does the Agent OS contract mirror personally when D's contract bump lands.

**Not done, deliberately:** no merge, no push, no production restart in wave 1 or 2 — all owner-gated. Wave 1 (A/B/C) verified and accepted; branches `task/restart-path`, `task/multi-lane` remain unmerged as instructed.

**D — W-B card identity + staleness refusal + `original` gate + contract 1.44.0 — ACCEPTED (conductor-verified 15:45Z).**
Branch `task/card-identity` (stacked on `task/multi-lane`), commits `8c5e196` (server + contract) and `a0ac7dd` (client), 19 files +955/−48. Tree frozen at `a0ac7dd` for verification (I aborted the looping session; that terminalised its goal as `failed` — my deliberate action, NOT a work failure).
- **My own gates**: client **1349/1349**, server **4452/4452** (BOTH with host env as-is and with the inherited env vars unset — D's env-failure claim was an artefact of its shell), drift guard + version pins **17/17**, typecheck 0, lint 0 errors, build 0.
- **I drove D's card harness myself** in my own environment (my own units, ports 3592/3594, my own state dir, fresh browser profile): **9/9 verdicts, exit 0**, 8 screenshots. The decisive one: a FOREIGN WebSocket mutated the draft while the card still showed v5 (`C.staleCardWasGenuinelyStale`), the confirm was refused with `released: null` and the exact mechanical reply, and the card re-showed the CURRENT text under fresh identity v6 — then the fresh confirm released exactly that. D said "eight verdicts"; it is nine (it under-claimed).
- **Strong positive control by me**: neutering ONLY `identityMatches` (leaving the API intact) fails **4 of 16** tests — so the tests detect the behavioural defect, not merely a missing function. A weaker control (pre-card server) also fails, as expected. Tree restored clean both times.
- **Lane regression closed at the browser level, which nobody had done**: D only ran the unit lane suite and explicitly did not re-run the lane harness. I ran the 14-verdict lane harness **against the card branch — the actual merge stack**: **14/14 ok, final.allOk true**. Lanes + card together are browser-verified.
- Static checks by me: `identityMatches` requires BOTH version and hash (rationale documented); `isProposalRef` is wired into `isTalkerTurnMessage` so a malformed ref fails the schema; the stale gate sits AFTER lapsed and BEFORE any release (`released: null`, `modelCalled: false`) with the `original` gate reading the CURRENT descriptor; contract 1.44.0 constant + changelog (consumer guidance + rollback) + published example all consistent.
- Accepted residuals (D's, unchanged): a bare spoken "yes" with no echo keeps pre-existing exposure by design (the card gestures are the precise path); the harness uses claude-runtime workers because a pi relay blocks on the worker's full turn; STT not exercised (out of scope).
- **PENDING, owner-gated:** the Agent OS mirror resync for contract 1.44.0 is deliberately NOT done yet — the mirror must not advertise 1.44.0 while production still serves 1.43.0, or Agent OS's own live validation would fail. Do it when the merge+restart actually lands. W-F(iii) (Agent OS Stage J) still deferred (repo contended).

**ALL FOUR CHILDREN (A, B, C, D) NOW VERIFIED AND ACCEPTED. Nothing merged, nothing pushed, production untouched.**
