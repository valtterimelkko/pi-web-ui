# MASTER PLAN — Pi Web UI: contract discipline, card integrity, and multi-lane voice

**Owner decisions recorded 2026-09-15. NOTHING IN THIS FILE HAS BEEN STARTED.**
This is the single entry point for the work that follows the 2026-09-15 deployment. Read §0 first.

---

## 0. How to use this file

- **This file is the plan of record** for the work below. Companion files hold detail; where they disagree with
  this file, this file wins, and the companion should be corrected.
- **Authority.** Every decision in §2 was made by the operator on 2026-09-15 and is recorded verbatim in intent.
  Nothing here needs re-approval *to plan*; each work item still needs its own evidence before it ships.
- **Production restarts remain owner-gated.** Approval is required for each restart (or batch) per the standing
  rule; no permission granted earlier should be treated as standing.
- **Do not let this file go stale.** When an item starts, ships or is dropped, edit this file in the same change.
  A stale competing plan is worse than none.

### Companion files (all in `operations/change-requests-20260915/`, present but untracked by design)

| File | What it holds |
|---|---|
| `STATE.md` | Live programme checkpoint: what is deployed, verification status, open items |
| `W3-FOLLOWUPS.md` | The reviewer's findings in full, with the conductor's independent confirmation of each |
| `LANE-SHAPE-DECISION.md` | Lane-shape analysis grounded in code facts (one tab vs a tab per lane) |
| `child-voice/MULTILANE-DESIGN.md` | The multi-lane design: lane identity, floor rules, cap, failure modes |
| `child-voice/complete.md`, `child-stability/complete.md`, `child-handoff/complete.md`, `child-pin/complete.md` | Handbacks with evidence per change request |
| `parent-verification/` | The conductor's own probes, dry-run evidence and the `ExecStopPre` defect record |
| `voice-card-20260915/STATE.md` | The confirmation-card programme checkpoint |

---

## 1. Baseline — what is already deployed and live (2026-09-15)

> **UPDATED AFTER THE MERGE + DEPLOY (2026-09-15 16:37Z).** Production `pi-web-ui.service` now serves
> **contract 1.44.0**, built from merged master revision **`c1dedf0`**, restarted at **16:37:43Z** through
> `scripts/restart-pi-web-ui.sh --reason …` (so the journal names the requester), after a pre-check of the
> **busy-session count from `/sessions`** — the reliable signal — which read **0 busy of 200 sessions**.
> Deploy verified three ways, not one: `/capabilities.contract.contractVersion` = **1.44.0**; the UI on
> `:3456` serving **exactly** the freshly built client bundle (`index-C67PQPyS.js`), which contains the
> merged lane/`proposalRef` code; and a real headless browser loading production and rendering the app
> shell (`HTTP 200`, React root mounted, login screen, no page errors). The upstream baseline this work
> started from was **contract 1.43.0** at revision `a27c12b` — the rest of this section is that starting
> state, kept for the record.

Production `pi-web-ui.service` serves **contract 1.43.0**, built from revision **`a27c12b`**, status ok, restarts
pre-checked on the **busy-session count** (never `activeTurns` alone).

> **Note on revisions:** `master` is ahead of the built revision by **documentation only** (this plan and its
> signposts). The served build is the code of `a27c12b`; no rebuild or restart is needed for a docs-only change,
> and none was taken. When the next code item ships, the build and the restart go together as usual.

| Delivered | Commit | Verified by |
|---|---|---|
| Confirmation card: honest tidying + operator's original words | `0798661` | disposable-server live rows L1–L7; conductor seam probe |
| P27 wire row pins the card contract | `c298775` | script row rewritten; suite green |
| create-and-pin in one go | `ce6e95f` | 329 store tests + conductor probe with a positive control |
| Self-describing stops, shutdown instruments | `d765ecf` | 1188-test suite reproduced; instruments exercised live |
| Mic single-owner + desktop split layout | `86ce22b` | conductor re-ran the two-tab browser harness itself |
| Stop-audit drop-in fix + regression tests | `c390e11` | `systemd-analyze verify` clean; RED-verified tests |
| Punctuation-honesty fix | `447f43e` | TDD RED→GREEN; server suite 4432 tests |
| Contract 1.43.0 (additive `no_activity`) | `a27c12b` | live `/health` + `/capabilities`; drift guard added |
| auto-compact-75 v2.7.0 | `pi-enhancement` `8eb9e01` | loaded fresh in the restarted process |

**Live stop evidence (the original incident's blind spots, now answerable):**

```
[Shutdown] event=stop_signal signal=SIGTERM received_at=... note="recorded synchronously before any await"
[Server] Shutdown complete in 139ms
STOP-AUDIT phase=post ... service_result=success exit_code=exited exit_status=0
RESTART-REQUESTED ts=... uid=0 pid=... cwd=... reason=...
```

**Traps learned today — carry these into every item below:**

1. `systemd` ignores unknown unit directives **silently** (`ExecStopPre` never ran). Always
   `systemd-analyze verify <unit>` after touching a unit or drop-in.
2. `/capacity.activeTurns` read **0** while a child was provably mid-turn for ~59 minutes. Use the busy-session
   count from `/sessions`.
3. A wake can be lost three ways (queued `onFire` wake killed as `TURN_STALLED`; steer swallowed on a busy host;
   firing predating a re-registration). Keep a model-free `wake_deadline` backstop and stay idle while children run.
4. An agent sleeping and exiting is fine; a **restart** kills everything in the service cgroup. Run helpers under
   `systemd-run --scope --collect`.
5. A wire-visible change merged with **no contract bump** (§2 D-none below is about process, not code).

---

## 2. Owner decisions (2026-09-15) — authoritative

| # | Decision | Owner's answer | Conductor's recommendation on record |
|---|---|---|---|
| **D1** | Catalogue-script restart path | **Option (a): make the change** | Make `scripts/command-code-weekly-refresh.ts` use the named, locked wrapper and decide safety on the busy-session count |
| **D2** | Bind the card to the bytes the operator authorises (TOCTOU) | **Do it** | Yes — the card is the only door to the worker; needs a contract bump |
| **D3** | Server-gate the `original` release variant | **Do it** | Yes, and fold into D2 (same release decision — doing it twice is waste) |
| **D4** | `talkerBus` request/lane correlation | **Do it** | Yes, scoped with the lane work |
| **D5** | Lane shape | **One tab holding the lanes** (recommended option) | Shape B: one page, a lane strip, no cross-tab coordination |
| **D6** | Build multi-lane now? | **Yes — build it now** | (owner-initiated; sequencing in §4) |
| **D7** | Desktop layout (item 4) | **Accepted — "looks really good"** | Already deployed; no further action beyond keeping it |
| **D8** | Smaller threads | **Conductor decides worth + timing** | Judgement recorded in §3 W-F |
| — | Cross-device lanes | **Dropped entirely** | No server-side lane registry, **no contract bump for lanes** |
| — | Contract-discipline process change | **Not now** | Owner declined; the mechanical drift guard from `447f43e` stays |

Also settled earlier the same day (not open): cap **3 lanes**; a fourth lane **asks** (replace, or hand over);
**visual** announcement rather than a cue tone; **waiting-time fairness** for the queue.

---

## 3. Work items

Each item states **why**, **what**, **where**, **how**, **acceptance**, **validation** and **dependencies**.
Work in the repo's normal discipline: TDD (RED first) for behaviour, path-limited commits, `master` only,
and the standard gates (`npm run lint`, `typecheck`, relevant tests, `docs:check-agent-guides`,
`docs:check-links`) before any push. Live-validate against a **disposable** server
(`npm run validate:server` + `npm run validate:live`, helpers under `systemd-run --scope --collect`);
production only with explicit owner approval.

---

### W-A — The catalogue script must restart safely and name itself  *(D1)*

- **Why.** `scripts/command-code-weekly-refresh.ts` is the only unattended restart path in the repo. It restarts
  production when it reads `activeTurns === 0`, and that counter was proven to read zero while real work was
  running. A restart kills everything in the service cgroup — the 08:29Z incident in miniature.
- **What.** Two changes in that file:
  1. Decide idleness on the **busy-session count** (`GET /sessions`, count `busy: true`) plus a zero in-flight
     run-receipt check — never `activeTurns` alone. The client the script already constructs exposes
     `listSessions()` (`packages/internal-api-mcp/src/internal-api-client.ts`), and that response carries the busy
     flag. If either check cannot be made, **do not restart**; log and leave the new catalogue for the next human
     restart. Note the existing code already defers on a capacity error — keep that behaviour, it is correct.
  2. Call `scripts/restart-pi-web-ui.sh --reason "weekly command-code catalogue refresh"` instead of
     `run('systemctl', ['restart', 'pi-web-ui'])`, so the restart names its requester and takes the production
     lock (the wrapper accepts `--no-lock` for callers that already hold it).
- **Where.** `scripts/command-code-weekly-refresh.ts` — the idle loop's decision is at ≈ line 354
  (`if ((capacity.activeTurns ?? 0) === 0) { idle = true; break; }`), the restart call is at ≈ line 362
  (`run('systemctl', ['restart', 'pi-web-ui'], …)`), and the "busy ⇒ deferred" branch already exists just below it.
  The wrapper `scripts/restart-pi-web-ui.sh` already exists (committed in `d765ecf`) and supports `--reason`,
  `--no-lock` and `--dry-run`.
- **How.** TDD: extract the idle decision into a pure, injectable helper and test it against (a) a busy session
  present, (b) only idle sessions, (c) the capacity endpoint unreachable, (d) a non-terminal run receipt present.
  Then swap the restart call. Keep the existing owner-gated behaviour: the script must still be safe to run
  without restarting at all.
- **Acceptance.** A busy session or an unreachable API ⇒ **no restart**, with a log line naming why. An idle
  service ⇒ restart through the wrapper, and the audit file shows a `RESTART-REQUESTED` line with the reason.
- **Validation.** Unit tests for the helper; a dry run of the script against a disposable server with a
  deliberately busy session proving no restart happens; confirm `restart-pi-web-ui.sh` is honoured (it already
  supports `--dry-run`).
- **Coordination.** This file belongs to the model-catalogue workstream. Declare on the board
  (`agent-os board quick-declare`) before editing, and keep the diff limited to the two changes above.
- **Dependencies.** None.

---

### W-B — Bind the confirmation card to the bytes the operator authorises  *(D2 + D3)*

- **Why.** The card's promise is "this is the exact text that will be sent to the worker". Today the confirm
  gesture sends a generic `yes`, and the server releases **whatever the draft holds at that moment** — there is no
  proposal identity linking the confirmation to the text that was displayed. If the draft changes between render
  and confirm (the operator speaks again; another lane or tab mutates it), the released bytes differ from what was
  approved. The independent reviewer called this **critical**; the conductor confirmed the mechanism.
- **What.** Three parts, in one coherent change:
  1. **Proposal identity.** The `proposed` payload carries an identity for the exact bytes shown (a version
     counter, content hash, or both). The card displays from that identity; the confirm echoes it.
  2. **Staleness refusal.** On confirm, if the echoed identity no longer matches the current proposal, **refuse**
     and surface it honestly ("that card is out of date — here is the current text"), never silently release
     something the operator did not read. This is a new mechanical refusal beside the existing lapsed/ambiguous/
     empty refusals; it must not consume the draft.
  3. **Variant gating (D3).** `releaseVariant: 'original'` must be **refused** unless the current proposal's
     descriptor actually advertised an `original` (i.e. a visible removal happened). Today it is only
     enum-validated, so a stale or buggy client can release raw text the card never offered. Route the refusal
     through the same mechanical refusal path — never a silent substitution.
- **Where.** `server/src/talker/pending-proposal.ts` (`describeProposal`, `takeForRelease`),
  `server/src/websocket/protocol.ts` (the `proposed`/confirm message schemas),
  `server/src/websocket/connection.ts` (the operator-turn handler, ≈ lines 4231–4236),
  `client/src/components/DriveMode/ConfirmationCard.tsx`, `client/src/components/DriveMode/useVoiceTurn.ts`,
  `client/src/hooks/useTalkerTurn.ts`, `client/src/lib/talkerBus.ts` (carry the identity through).
- **Contract.** This changes the wire shape on both sides ⇒ **bump the Internal API contract** (next free version
  at the time of writing: **1.44.0**), add the changelog entry in `docs/INTERNAL-API-CONTRACT.md`, and **resync the
  Agent OS mirror** (`/root/agent-os`: `src/pi-web-ui/client.ts`, `docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md`, the
  pin in `tests/pi-web-ui-observability-contract.test.ts`) — then run `npm run validate:offline` and confirm
  Stage H passes. The new drift test (`server/tests/unit/internal-api/contract-version-drift.test.ts`) enforces
  constant ⇄ changelog ⇄ published example.
- **How.** TDD, RED first, with the races as *unit-level* cases on the server (they are the point of the item):
  append-after-render, proposal replaced, proposal cancelled, second confirm after a successful release, and a
  cross-tab/foreign mutation. Then the client: the card must render from the identity it will echo, and the
  refresh action on a stale refusal must show the current text.
- **Acceptance.** No path exists where the bytes released differ from the bytes the card displayed for the
  identity that was confirmed. A stale confirmation refuses, is surfaced, and does not consume or mutate the
  draft. An `original` variant with no advertised original refuses.
- **Validation.** Server + client suites; a **browser-level** run of the real card (see W-F(ii)) covering: normal
  confirm, stale refusal, "Send my exact words", cancel; plus the existing disposable-server live rows re-run.
- **Dependencies.** W-F(ii) for honest browser-level evidence. Interacts with W-D (lane correlation) — do **not**
  duplicate the correlation work; W-B carries identity, W-D carries lane/request routing.

---

### W-C — `talkerBus` must correlate results to their request and lane  *(D4)*

- **Why.** `talkerBus` results are global and filtered only by worker session; the request id and runtime are
  ignored (`client/src/lib/talkerBus.ts` ≈ 69–90, `useVoiceTurn.ts` ≈ 261). With one tab this is latent. With
  several lanes in one page it is precisely how **lane A's card appears in lane B**.
- **What.** Carry and match on `requestId` and a lane identity; drop or park results that match neither, and never
  let a late result from a previous request overwrite a newer card.
- **Where.** `client/src/lib/talkerBus.ts`, `client/src/hooks/useTalkerTurn.ts`,
  `client/src/components/DriveMode/useVoiceTurn.ts`.
- **How.** TDD with out-of-order and foreign-lane results as explicit cases. Prefer a bounded queue keyed by
  `requestId` over global "last result" state.
- **Acceptance.** A stale or foreign result can never populate the active lane's card; an out-of-order arrival
  resolves deterministically.
- **Validation.** Unit cases above; then the browser-level harness from W-F(ii) with two lanes.
- **Dependencies.** Sequence **with** W-D (same surface). This is a prerequisite for W-D's correctness, not an
  optional companion.

---

### W-D — Multi-lane voice in one tab  *(D5 shape, D6 build now)*

- **Why.** The operator's original complaint: two tabs in Voice Mode, and the other one unexpectedly starts
  talking while he is speaking on the first, with no way to tell them apart. Today one tab holds exactly one
  worker session, and switching worker requires leaving Voice Mode entirely (`DriveModeDictate` exposes only
  `onExit`/`onAbort`; `activeSessionId` is a single value).
- **Shape (decided).** **One tab holds the lanes.** No cross-tab coordination: with everything in one page, the
  existing per-tab `speechArbiter` already schedules playback, so no `BroadcastChannel`, no heartbeat, no
  "disconnected lane" states, and no background-tab throttling risk. Cross-device is **dropped** by the owner, so
  there is **no server-side lane registry and no contract bump for lanes**.
- **What, phased — smallest first:**
  1. **Two lanes in one tab.** A lane strip (`Worker 1 · speaking`, `Worker 2 · you have the floor`) that switches
     which worker the operator's voice is addressed to, live, without leaving the screen; per-lane transcript,
     card, reading level and focus; a "+" that adds a second worker from the existing session picker.
  2. **The third lane and the queueing rules.** Cap **3**; a fourth lane **asks** (replace, or choose which to hand
     over) and never appears silently; the lane count is always visible (`2 of 3`).
  3. **One floor across lanes** (from `MULTILANE-DESIGN.md` §4.4): no lane may start speech over any lane's
     capture; speech already playing ducks to 0.15 when capture begins; two lanes wanting the floor queue by tier
     then **waiting-time fairness**; when the operator takes the floor in one lane, the others announce it.
- **Where.** `client/src/components/DriveMode/*` (new: lane strip, lane state, session pane already exists as
  `DriveModeSessionPane.tsx`), `client/src/store/driveModeStore.ts` (single `activeSessionId` is the assumption
  that changes), `client/src/components/DriveMode/voiceFloor.ts`, the speech arbiter, and the talker/relay path
  where per-lane state must not leak. Detail: `child-voice/MULTILANE-DESIGN.md`; shape rationale:
  `LANE-SHAPE-DECISION.md`.
- **Invariants that must not regress** (they are shipped promises): capture is unconditional and never gated by
  the scheduler; the operator's floor is never interrupted; every scheduling decision stays observable in the
  browser diagnostic ring; single-lane use stays byte-identical to today (the strip collapses to the current
  banner and no cross-lane messages are sent).
- **How.** TDD per phase. Phase 1 is shippable alone and is the half that removes the surprise. Keep one lane's
  behaviour provably unchanged by pinning it with a test before adding the second.
- **Acceptance.** With two or three lanes open: nothing ever speaks over the operator; the operator always knows
  which lane is which and which is audible; switching is one deliberate in-app action; a fourth lane asks rather
  than appearing; a lane whose tab is closed or which crashes releases its capture.
- **Validation.** Browser-level (real UI, real capture path with Chromium's fake media device), paired
  screenshots, and the multi-lane harness extended from `child-voice/harness/two-tab-repro-v2.mjs` — but driving
  lanes in **one** page rather than two tabs.
- **Dependencies.** W-C (correlation) first or alongside. Benefits from the browser harness in W-F(ii).

---

### W-E — Keep the Agent OS mirror in step with any contract bump  *(applies to W-B)*

- **Why.** The mirror is load-bearing for Agent OS's orchestration and wake behaviour. On 2026-09-15 an additive
  wire change (`liveness.watchdog.reason` gaining `no_activity`) reached production and the mirror **never
  recorded it** — a consumer switching exhaustively would have mis-read a lost wake as a stalled turn. The gap was
  found only because the operator asked whether a bump had been mirrored.
- **What.** For every contract bump: update the constant (`server/src/internal-api/types.ts`), the changelog entry
  and published example in `docs/INTERNAL-API-CONTRACT.md`, then mirror **all three** in
  `/root/agent-os/src/pi-web-ui/client.ts`, `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` and
  `/root/agent-os/tests/pi-web-ui-observability-contract.test.ts`. Declare on the board before touching
  `agent-os` (other agents work there), commit on `main`, and push.
- **Acceptance.** `curl /capabilities` on production, the pi-web-ui constant, the pi-web-ui doc and the Agent OS
  mirror all report the same version; `npm run validate:offline` in agent-os passes including Stage H.
- **Note on Stage J.** Agent OS `validate:live` Stage J fails for **environmental** reasons that predate this work
  (identical three-way failures, identical reasons, recorded 2026-09-11): the pi attempt exceeds the harness's
  30 s client timeout, opencode is disabled on this host, and the claude direct backend returns 500. See W-F(iii).

---

### W-F — Smaller threads (conductor's judgement under D8)

**(i) Background extensions writing session snapshots through a non-current SessionManager — worth a bounded
investigation; not urgent; run as a small parallel child once W-D has started.**
*Why:* the Web UI's own background-work extensions persist registry snapshots into the session JSONL (observed:
`bg-shell-tasks`, `background-tasks` at session load and after handoff). That mismatch is what made the
auto-compact-75 handoff refuse and fence a live session; v2.7.0 now tolerates the tail, so the symptom is gone but
the cause is not — and any other freshness/fencing gate over session files could trip on it.
*What:* a read-only investigation producing a written finding: which extensions write, through which
SessionManager, when, and which gates in the repo compare session-file state against in-memory state. **No fix
without the finding**; if a fix is warranted, scope it separately.
*Where:* start at `pi-enhancement`'s background-shell / agent-os-inject extensions and
`server/src/pi/multi-session-manager.ts`; the handoff handback has the original evidence
(`operations/change-requests-20260915/child-handoff/complete.md`).

**(ii) Close the card's browser-level evidence gap — worth doing, and do it as part of W-B rather than
separately.** *Why:* the 2026-09-15 live rows exercised the WebSocket seam, not the real card — no disclosure
opened, no "Send my exact words" clicked (`L4` sent the variant directly). W-B changes that card anyway, so it
needs a browser-level harness to be honestly validated.
*What:* a small Playwright-driven harness (fake media device, disposable server) that drives the real card:
propose → inspect → confirm; propose → cancel; propose → stale confirm (must refuse and re-show); propose → "Send
my exact words" (must send the raw bytes). Reuse `child-voice/harness/` patterns and the `webapp-testing` skill.
*Acceptance:* the harness asserts the **released bytes** (from the transcript/relay record) equal the bytes the
card displayed, for every path.

**(iii) Repair the Agent OS live-proof harness assumptions — worth doing; small; do it when W-E next runs.**
*Why:* Stage J currently fails on every run for reasons that are environmental, so the signal is drowned: a
30 s client timeout that a real pi prompt exceeds, `opencode` attempted on a host where it is disabled, and a
claude direct backend 500. An always-red stage teaches people to ignore validation.
*What:* raise/adjust the per-attempt timeout to something realistic (or make it configurable); **skip runtimes the
server reports as unavailable** rather than counting them as failures; and capture the claude 500's runId
diagnostics as its own known-issue note if it persists. Keep the failure evidence artefacts.
*Where:* `/root/agent-os/src/validate/stages/stage-j-live.ts` (with `stage-h-contract.ts` as the model for how the
contract stage is structured).

---

## 4. Recommended sequencing

1. **W-A** — small, self-contained, removes an unattended way to kill production. (Coordinate with the catalogue
   workstream first.)
2. **W-C then W-D** — correlation before lanes; lanes phase 1 (two lanes, one tab) ships alone; then phase 2–3.
3. **W-B (+ W-F(ii))** — the card identity work with its browser harness, and the `original` gate folded in. This
   carries the contract bump to **1.44.0**, so do **W-E** in the same change.
4. **W-F(i)** — the session-file investigation as a parallel child while W-D is underway.
5. **W-F(iii)** — fold into the next W-E validation run.

Rationale for this order: W-A closes a live production risk cheaply; W-D is what the operator asked to be built
now and is the largest item, so start it early; W-B is the only item that touches the contract, so batching its
bump with its mirror keeps the contract story coherent.

---

## 5. What NOT to do (superseded beliefs and traps)

- **Do not add a server-side lane registry or bump the contract for lanes** — cross-device was dropped.
- **Do not reintroduce `BroadcastChannel`** lane coordination: the chosen shape holds lanes in one page, where the
  existing arbiter already schedules.
- **Do not gate restarts on `activeTurns`** — use the busy-session count.
- **Do not add `ExecStopPre`** to any unit — it does not exist; `systemd-analyze verify` after unit edits.
- **Do not treat the handback claims as verified** — where this file says a child's work was verified, the
  conductor re-ran it; where it does not, verify first.
- **Do not commit `operations/`** — it is evidence, and the repo is permanently public (it contains harness
  scripts and a disposable dev credential hash).
- **Do not use the cue tone, fixed lane priority, a silent fourth lane, or cross-device lanes** — each was
  considered and decided against.

---

## 6. Status ledger

**All four work items are MERGED into master as of 2026-09-15 16:0xZ** (`b4cd12d`, three `--no-ff`
merges over the other agent's `1c05f6f`, **zero conflicts**). Post-merge gates on the merged tree:
typecheck, lint, build clean; **server 4464/4464**; **client 1349/1349**; the combined
"both agents' restart work together" bundle **47/47**. Deployment is a separate step (below),
because a restart is what makes merged code live.

| Item | Decision | Started | Merged / shipped |
|---|---|---|---|
| W-A catalogue-script restart path | D1 approved | **yes** — child A, conductor-verified (14/14, positive control failed 6 ways on the old source) | **merged** `51e6d81`-adjacent `b4cd12d` (via `task/restart-path`) |
| W-B card identity + variant gate (contract 1.44.0) | D2, D3 approved | **yes** — child D, conductor-verified (server 4452/4452, client 1349/1349, drift+pins 17/17, card harness 9/9 driven by the conductor, positive control: neutering the identity check fails 4/16) | **merged** `495dd97` (via `task/card-identity`); **production still serves 1.43.0 until the restart** |
| W-C `talkerBus` correlation | D4 approved | **yes** — child B, folded into the multi-lane work | **merged** `51e6d81` |
| W-D multi-lane in one tab | D5, D6 approved | **yes** — child B; conductor drove the 14-verdict harness itself, and re-ran it against the card branch to prove the stacked merge did not regress lanes | **merged** `51e6d81` |
| W-E mirror discipline | process, owner declined a new gate | **yes, per bump** — held at 1.43.0 while 1.44.0 was unshipped, then resynced within the hour of production serving it | **done** `agent-os` `88d967e` (constant, doc note with consumer guidance + rollback, pin test; `validate:offline` Stage H pass, pins 10/10, checked against the live socket before committing) |
| W-F(i) session-file investigation | conductor: worth it, not urgent | **yes** — child C, read-only; accepted with one citation correction (`:557` → `:568`, content verbatim) | delivered as a finding, not code |
| W-F(ii) card browser harness | conductor: worth it, do with W-B | **yes** — written as part of W-B | **merged** with `495dd97` |
| W-F(iii) Agent OS live-proof harness (Stage J) | conductor: worth it, small | **no** — deferred while `/root/agent-os` was contended by four agents | **not done, not dropped** |
| D7 desktop layout accepted | — | — | **live** |

### Post-merge integration fix (found by the merge itself, not by any child)

The merge put the other agent's capacity pre-flight in front of W-A's restart. That pre-flight refuses
with **exit 1** and a documented message while admitted child turns are running — a deliberate,
test-pinned contract, so it was left alone. But the weekly catalogue script read *any* non-zero restart
exit as a hard failure, which would have reported a run that had **already committed and pushed the
catalogue** as a **failed weekly job** whenever the wrapper correctly declined to restart. Fixed with
RED-first TDD in `28ea8b5`: only the wrapper's documented refusal is a deferral (identical in meaning
to the script's existing busy-session branch, and matching its own summary wording), any other
non-zero exit still throws, and the refusal's reason is carried into the summary so a deferral is
visible rather than silent. 16/16 in that file; typecheck and lint clean.

**Open integration caveat, deliberately not "fixed" by softening anything:** the wrapper's pre-flight
keys on `/capacity.activeTurns`, which is *proven* to read `0` while work is provably running. W-A's
path does not depend on it (it counts busy sessions from `/sessions`), so the catalogue refresh cannot
be fooled — but the wrapper's own gate can still admit a restart during unadmitted work. That belongs
to the restart root-cause work, not to this merge.

