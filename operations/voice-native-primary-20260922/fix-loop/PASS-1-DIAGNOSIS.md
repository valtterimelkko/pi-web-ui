# Fix-loop pass 1 — boundary diagnosis (2026-09-23 02:10–02:19Z)

> Raw data: `/root/voice-lane-lab/fix-loop/pass-1/` (per-episode logs + summary).
> Attempt records: `/root/voice-lane-lab/campaigns/primary-mic-journeys/runs/<ID>-standard/attempt-*`.
> Result: **1 pass (C09) / 11 fail**. Every attempt was a real built-app journey with verified
> capture, director replay and cleanup; the failures are interactions, not harness integrity.

| ID | Terminal / problem | Boundary | Verdict |
|---|---|---|---|
| C01 | candidate `prop-1` = `"I want to find out about Podpoint."`; talker said *"I've prepared that message about Podpoint for you to review."*; presentation never completed | presentation | **product**: eyes-free read-back depends on model compliance |
| C03 | same shape | presentation | **product** (as C01) |
| C17 | same shape (correction episode, stalled at first presentation) | presentation | **product** (as C01) |
| C19 | same shape | presentation | **product** (as C01) |
| C05 | no candidate; model answered conversationally (correct per contract) | corpus | **corpus**: opening turn lacked the explicit addressing frame (fixed `99b9e273`) |
| C18 | candidate correct; amendment ("Wait, do not deploy…") acknowledged but **never re-relayed** | relay selection | **product/prompt**: amendment guidance unclear ("at most once") → H2 |
| C20 | candidate from t1 arrived during a `speak` phase → ignored; confirm block's strict `await-candidate` waited for a new candidate → stall | director | **lab**: candidate persistence across speak phases → J2 |
| C14 | no response observed within the 8 s response deadline (real turns measured 8–18 s) | deadlines | **data**: per-step deadlines too tight (bump scheduled with test updates) |
| C15 | journey pass; verifier `response missing required content: "thinking"` — the model's correct answer ("…will not send anything…") never contains it | corpus/verifier | **corpus** (slot fixed `99b9e273`); negation-awareness → J2 |
| C16 | journey pass; verifier `response missing required "plan"` + `contains forbidden "finished"` — the honest answer "…can't confirm if the test suite has finished running." | corpus/verifier | **corpus** (slot fixed) + **lab** negation-aware forbidden check → J2 |
| C21 | conversation-only episode produced candidate `"check the version number before anything"` | relay selection | **product/prompt**: instruction-shaped clause inside doubt/qualification must not relay → H2 |

## Correction round in flight (dispatched 02:22–02:24Z)

| Child | Scope | Paths |
|---|---|---|
| **H2** (`01a0cc12-…`, watch `ww_6`) | host-controlled auto read-back on proposal creation + prompt no longer depends on model read-back; amendment = new relay; doubt/qualification never relays (with the C21 example) | `client/**`, `server/src/voice/**`, `server/src/websocket/voice-live-mount.ts` |
| **J2** (`01a0cc13-…`, watch `ww_7`) | director candidate persistence across speak phases (C20); negation-aware `responseMustNotContain` (C15/C16) | `scripts/voice-lane-lab/lib/**`, phase1 tests |
| conductor | corpus data (C05 frame; C15/C16 slots — `99b9e273`); deadline bump pending with test updates | `scripts/voice-lane-lab/corpus/**` |

## Pass-2 preconditions

1. H2 + J2 verified and merged.
2. Deadline bump applied (candidate 25 s / presentation 15 s / delivery 20 s / worker store 20 s) with
   the timing tests updated to derive from episode data.
3. Re-run the 12 P-tier episodes (affected + family neighbours); pass repeated until two consecutive
   clean full passes.
