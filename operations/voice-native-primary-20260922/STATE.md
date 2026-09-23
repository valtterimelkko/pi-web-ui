# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 · W2 complete · **W3 fix loop RUNNING** — passes: 1 → 1/12; 2 INVALID (stale build,
runner fixed); 3 → 5/12; **4 → 4 clean/8 not** (binding grace + read-back seam proven; new lab/prompt
classes found); **correction child K in flight** (presentation persistence, seam completeness,
open-response design, C18 amendment prompt); C05 data fix committed.

**Active children**

| Child | Session | Worktree · branch | Lease | Watch | Scope |
|---|---|---|---|---|---|
| K pass-4 fixes | `01a0cc7f-bb75-73f0-b149-c13be95a7210` | `wt-voice-pass4` · `task/voice-native-pass4` | `579137c0…` | `ww_10_1790137337569` | lab semantics + C18 prompt |

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

- master `d9baaa9d`: H3 + J3 merged; C05 confirmation data fix; K brief.
- Passes: 1 → 1/12 · 2 INVALID (fixed) · 3 → 5/12 · **4 → 4 clean** (C01/C03/C17/C19) — the two big
  seams (binding race, read-back environment) are now proven; remaining failures are lab semantics
  (C20/C16/C21/C09/C14/C15) and one prompt item (C18), all in K's round; C05 fixed in data.
- Live accounting: passes 1–4 (~50 min) + probes; inside §10.

**Next sequence**

1. On pass-4 completion: analyse by boundary. If clean, run pass 5 for the second consecutive clean
   full pass; if failures remain, correct and re-run.
2. On two consecutive clean passes: freeze code/prompt/corpus/scorer; cost the §8 matrix (adapt rule).
3. W4: campaign + read-only reviewer + verdict; canonical docs; Agent OS capture.

**Open questions:** none.
**Backstops:** watch `ww_10` (K) primary; `wake_deadline` armed for the round-4 window.
