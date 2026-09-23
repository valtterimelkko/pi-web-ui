# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 complete (3/3) · W2 complete (2/2) · **W3 fix loop RUNNING** — pass 1 (12 P-tier
episodes, standard arm) launched in background (`bg_*`, log
`/root/voice-lane-lab/fix-loop/pass-1/summary.txt`).

**Active children:** none. All five W1/W2 lanes verified, merged and cleaned up:

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

- master `c50eca93` (= origin after the docs commit that follows); no worktrees, no leases, no watches.
- Real provider accounting has begun: 4 probe sessions + 2 J journeys + 1 parent journey + fix-loop
  pass 1 (12 episodes) — all inside the §10 ceilings; the live clock is running.
- Holdout wording still unfrozen (validator step) — required only before the final campaign.
- Campaign live execution remains conductor-gated by design (only `--plan --dry-run` enabled).

**Next sequence**

1. On pass-1 completion: read `/root/voice-lane-lab/fix-loop/pass-1/summary.txt`, diagnose every
   failure **by boundary** (fixture → ASR → relay selection → payload meaning → approval → delivery →
   worker result → audible output), fix (RED→GREEN; bounded correction children if code changes are
   needed), re-run affected episodes + family neighbours.
2. Loop until two consecutive clean full dev-set passes (or a named §10 blocked outcome); measure
   per-episode cost/time; then freeze and cost the §8 matrix (adapt rule).
3. W4: campaign + read-only reviewer + verdict; canonical docs; Agent OS capture.

**Open questions:** none.
**Backstops:** pass-1 background task carries `backstop_s`; no child watches armed (none dispatched).
