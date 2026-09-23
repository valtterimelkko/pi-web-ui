# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 · W2 complete · **W3 fix loop RUNNING** — passes: 1 → 1/12; 2 INVALID (stale build,
runner fixed); 3 → 5/12; 4 → 4 clean/8 not; **correction K merged** (presentation persistence, seam
completeness, open-response, C18 prompt); **pass 5 running** (`bg_9e828e06`).

**Active children:** none — K verified, merged and cleaned up.

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

- master `51604ee4`: all W1/W2 lanes + correction rounds (H2/J2/H3/J3/K) + runner freshness fix + corpus
  data (C05 confirm, C09/C14/C15 openResponse). Lab 647; voice 261; repo lint 0 errors.
- Passes: 1 → 1/12 · 2 INVALID (fixed) · 3 → 5/12 · 4 → 4 clean · **5 running** — the two big seams
  are proven; this pass tests the lab-semantics + prompt round.
- Live accounting: passes 1–5 (~60 min) + probes; inside §10.

**Next sequence**

1. On pass-4 completion: analyse by boundary. If clean, run pass 5 for the second consecutive clean
   full pass; if failures remain, correct and re-run.
2. On two consecutive clean passes: freeze code/prompt/corpus/scorer; cost the §8 matrix (adapt rule).
3. W4: campaign + read-only reviewer + verdict; canonical docs; Agent OS capture.

**Open questions:** none.
**Backstops:** pass 5's `backstop_s` covers this window; no child watches armed.
