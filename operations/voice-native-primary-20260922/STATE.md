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
| ~~P provider~~ | `01a0cbb6-f85a-…` | ~~`wt-voice-provider`~~ | released | `ww_4` cancelled | **merged `cf003f13`, cleaned up** |
| J journey | `01a0cbb6-fc3c-73f0-b149-c12630857a5f` | `wt-voice-journey` · `task/voice-native-journey` | `73063c95…` | `ww_5_1790124169077` | running (goal armed; HEAD advanced to `e3ea7694`) |

P: verified by parent (voice 257, typecheck 0, eslint 0, both real arm probes re-run: standard 337 ms /
ET-HIGH 389 ms, transcript 100%). J: `zai/glm-5.3-flash` high · brief `children/J/brief.md` · handback
`/root/voice-native-20260922/coordination/J/complete.md`.

**W1 outcomes (all merged, all independently verified)**

| Child | Merge | Verification |
|---|---|---|
| H host (Phase 3 server) | `8f27fd98` | scoped 900 passed; parent probe 12/12; exact read-back + source binding + correction/original fixes |
| C client (Phase 2 surface) | `5fa309a9` | scoped client 381; build/typecheck 0; anti-cheat sound (real surface + wire frames) |
| L lab (Phase 1 instrumentation) | `301331d1` | phase1 87 / voice-live-lab 551 / lane-lab 14; scripts compile 0; **parent-reproduced real capture proof** (attempt-10: ingress 111 / egress 132); verifier fail-closed (raw exit 2 on parent damage probes) |

Post-merge gates: server suite 446 files / 5520 tests; client suite 145 files / 1639 tests — both green.
No worktrees or leases remain; all three watches cancelled.

**Current truth**

- master `cf003f13` (= origin): W1 merges + W2 briefs + **P merged** (provider-profile boundary).
- Real provider calls have begun: 4 probe sessions total (P's two + parent re-runs of both arms) — the
  first counted live activity; §10 fix-loop budget now applies.
- J still working (goal running, HEAD `e3ea7694`, no handback yet).

**Next sequence**

1. On J's handback: independent verification (real browser journey + runner dry index; no
   green-skip paths), merge accepted lane, cleanup.
2. Then W3 fix loop (parent-led, bounded correction children) → W4 campaign + read-only reviewer +
   verdict.

**Open questions:** none.
**Backstops:** `deadline-e43f805c-2817-4db6-a5fb-f847bee73570` until 02:14:14Z (J window); watch
`ww_5` primary. P is settled and cleaned up.
