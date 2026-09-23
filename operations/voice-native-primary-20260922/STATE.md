# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 complete (3/3) · W2 complete (2/2) · **W3 fix loop RUNNING** — pass 1 done (**1 pass / 11 fail**,
all boundary-diagnosed), correction round in flight (H2 + J2).

**Active children**

| Child | Session | Worktree · branch | Lease | Watch | Scope |
|---|---|---|---|---|---|
| H2 readback/prompt | `01a0cc12-73b3-73f0-b149-c12ecd942353` | `wt-voice-readback` · `task/voice-native-readback` | `ff606738…` | `ww_6_1790130165876` | host auto read-back; amendment re-relay; doubt/qualification non-relay |
| J2 lab fixes | `01a0cc13-f359-73f0-b149-c130edfea3f9` | `wt-voice-lab-fix` · `task/voice-native-lab-fix` | `01cf8aca…` | `ww_7_1790130264826` | director candidate persistence; negation-aware forbidden check |

| Lane | Merge | Verified by parent |
|---|---|---|
| H host (P3) | `8f27fd98` | 900 tests; parent probe 12/12; source binding + original + correction + exact read-back |
| C client (P2) | `5fa309a9` | client 381; build/typecheck 0; anti-cheat sound |
| L lab (P1) | `301331d1` | phase1 87 / lab 551 / lane 14 / compile 0; **parent-reproduced capture proof**; verifier fail-closed |
| P provider (§7) | `cf003f13` | voice 257; typecheck/eslint 0; **parent re-ran both real arm probes** (standard 337 ms, ET-HIGH 389 ms, transcript 100%) |
| J journey/runner | `c50eca93` | voice-live-lab 597; compile 0; campaign dry 54 cells; credential-missing exit 2; **parent-run real journey attempt-14 pass** (727/366 chunks, 71 steps replayed, cleanup verified) |

**Gates:** G0–G3 passed with evidence. G4 (dev set clean ×2; both arms reachable; cost fits) is the
current target.

**Current truth**

- master `99b9e273`: W1/W2 merges + corpus corrections (C05 frame, C15/C16 slots).
- **Pass 1 (12 real journeys): 1 pass / 11 fail** — diagnosis in `fix-loop/PASS-1-DIAGNOSIS.md`:
  presentation read-back ×4 (product), amendment re-relay (prompt), doubt/qualification proposal
  (prompt), candidate persistence (lab), tight deadlines (data), negation-blind slots (lab), C05
  frame (data). H2/J2 corrections in flight; deadline bump deferred until they merge.
- Live accounting: 12 journeys (~8 min live) + probe sessions; inside §10.

**Next sequence**

1. On H2/J2 handbacks: independent verification, merge, cleanup; apply the deadline bump with its
   test updates; re-run the dev set (pass 2) and iterate until two consecutive clean passes.
2. Freeze code/prompt/corpus/scorer; cost the §8 matrix (adapt rule).
3. W4: campaign + read-only reviewer + verdict; canonical docs; Agent OS capture.

**Open questions:** none.
**Backstops:** watches `ww_6`/`ww_7` primary; `wake_deadline` armed for the correction window.
