# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 · W2 complete · **W3 fix loop COMPLETE — GATE G4 ACHIEVED** (11 passes; pass 10 and
pass 11 both **12/12 clean**; freeze at `f7c43bc9`) · **W4 (Phase 5) opening**.

**Active children**

| Child | Session | Worktree · branch | Lease | Watch | Scope |
|---|---|---|---|---|---|
| L5 W4 seams | `01a0cd4e-d532-…` | `wt-voice-w5` · `task/voice-native-w5` | `89705e73…` | `ww_13` | auth-store seed fix + 1 real C22 run + 1 real soak run, then freeze handback |
| M product fix | `01a0cddb-1612-…` | `wt-voice-m` · `task/voice-native-m` | `9b1b21a7…` | `ww_14` | worker-switch proposal resolution (server/client, RED-first) |

**W4 status:** holdout freeze complete (`8c4ed67e`); evaluator package (`ba88bcdd`) + reviewer brief
(`18e2b4c5`) ready; campaign script ready. L5 handback received and its two blockers grounded +
answered (auth store for the worker; product seam for C24).

**Watching (zero-token):** primary wakes `ww_13` (L5) and `ww_14` (M), fresh conditions each.
Model-free backstop: armed below. No independent process backstop (background-task cap saturated).
