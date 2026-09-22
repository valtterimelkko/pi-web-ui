# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`).

**Stage:** `READY, NOT STARTED` — awaiting owner goal-engine activation.

**Wave:** W0 (not started) · **Active children:** none · **Watches/backstops:** none armed.

**Current truth**

- master `a97ca060` (= origin), ledger committed; another lineage owns
  `server/tests/unit/pi-ai/frontier-models.test.ts` (NO-TOUCH).
- zai pool ample (5h 98%, off-peak), contract 1.44.0, capacity healthy (1/16).
- Owner questions Q1 (merge authority) / Q2 (budget confirmation) open — see LEDGER §11.

**Next sequence**

1. On owner goal activation: W0 Phase 0 — recheck baseline vs source; RED the five defect
   classes; write acceptance manifest + corpus/director schema plan; verify machinery; create
   worktrees; then dispatch W1 children L, C, H (goals + watches first).
2. Merge gate after W1: independent verification of G1/G2/G3 on frozen commits, then merge (if
   Q1 granted).

**Open questions:** Q1, Q2 (LEDGER §11).
**Spend:** US$0.00 / 8 h live.
