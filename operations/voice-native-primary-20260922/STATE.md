# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 COMPLETE (3/3 merged and verified) · **W2 RUNNING** — P (provider profiles) and J (primary-mic journey + campaign runner) dispatched.

**Active children**

| Child | Session | Worktree · branch | Lease | Watch | Status |
|---|---|---|---|---|---|
| P provider | `01a0cbb6-f85a-73f0-b149-c1240fbef407` | `wt-voice-provider` · `task/voice-native-provider` | `94637b2a…` | `ww_4_1790124169013` | running (goal armed) |
| J journey | `01a0cbb6-fc3c-73f0-b149-c12630857a5f` | `wt-voice-journey` · `task/voice-native-journey` | `73063c95…` | `ww_5_1790124169077` | running (goal armed) |

Both: `zai/glm-5.3-flash` high · briefs `children/{P,J}/brief.md` · handbacks `/root/voice-native-20260922/coordination/{P,J}/complete.md`.

**W1 outcomes (all merged, all independently verified)**

| Child | Merge | Verification |
|---|---|---|
| H host (Phase 3 server) | `8f27fd98` | scoped 900 passed; parent probe 12/12; exact read-back + source binding + correction/original fixes |
| C client (Phase 2 surface) | `5fa309a9` | scoped client 381; build/typecheck 0; anti-cheat sound (real surface + wire frames) |
| L lab (Phase 1 instrumentation) | `301331d1` | phase1 87 / voice-live-lab 551 / lane-lab 14; scripts compile 0; **parent-reproduced real capture proof** (attempt-10: ingress 111 / egress 132); verifier fail-closed (raw exit 2 on parent damage probes) |

Post-merge gates: server suite 446 files / 5520 tests; client suite 145 files / 1639 tests — both green.
No worktrees or leases remain; all three watches cancelled.

**Current truth**

- master `df9f9590` (= origin) holds W1 merges + W2 briefs; worktrees provider/journey based on it.
- Holdout corpus surface forms intentionally EMPTY (validator freeze is pending, to be done by the
  parent/validator before the final campaign only).
- Plan §10 budget: metered spend so far US$0.00; P's real arm probes will be the first counted calls.
- Preflight 2026-09-23 00:42Z: zai 78% (off-peak), capacity 1/16.

**Next sequence**

1. On W2 handbacks: independent verification (P: real arm probes + same-host mapping; J: real
   browser journey + runner dry index; no green-skip paths), merge accepted lanes, cleanup.
2. Then W3 fix loop (parent-led, bounded correction children) → W4 campaign + read-only reviewer +
   verdict.

**Open questions:** none.
**Backstops:** `wake_deadline` to be armed after this update; watches `ww_4`/`ww_5` primary.
