# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 complete (3/3) · W2 complete (2/2) · **W3 fix loop RUNNING** — pass 1 diagnosed; correction
round **complete** (H2 + J2 merged, corpus + integration fixes in); **pass 2 running** (`bg_bc65df93`).

**Active children:** none — all correction lanes verified, merged and cleaned up.

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

- master `20eb75f1`: W1/W2 + corpus corrections + **H2** (host read-back, prompt) + **J2** (director
  persistence, negation awareness) + deadline bump/test derivation/lint cleanup. Repo lint 0 errors;
  full server suite 5714 green; phase1 144; voice-live-lab 608.
- **Pass 1: 1 pass / 11 fail**, all boundary-diagnosed and corrected (`fix-loop/PASS-1-DIAGNOSIS.md`).
- **Pass 2 running**; live accounting: pass-1+2 journeys (~16 min) + probes; inside §10.

**Next sequence**

1. On pass-2 completion: analyse by boundary. If clean, run pass 3 for the second consecutive clean
   full pass; if failures remain, correct and re-run.
2. On two consecutive clean passes: freeze code/prompt/corpus/scorer (hash and record), then cost the
   §8 matrix (adapt rule).
3. W4: campaign + read-only reviewer + verdict; canonical docs; Agent OS capture.

**Open questions:** none.
**Backstops:** pass 2's `backstop_s` covers this window; no child watches armed.
