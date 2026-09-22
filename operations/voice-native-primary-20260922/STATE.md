# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`).

**Stage:** `EXECUTING` — owner activated the goal engine and answered both gates
(**Q1 merge authority granted; Q2 plan confirmed**).

**Wave:** W0 Phase 0 running · **Active children:** none yet · **Watches/backstops:** none armed.

**Current truth**

- master `4a1c1a25` (= origin), ledger + STATE committed. Another lineage owns
  `server/tests/unit/pi-ai/frontier-models.test.ts` + modified manifests (`package.json`,
  `package-lock.json`, `server/package.json`, `shared/package.json`,
  `scripts/patch-pi-ai-toolstream.mjs`) — **NO-TOUCH**; merges wait for that lineage to settle.
- zai pool ample (off-peak); contract 1.44.0; capacity healthy.
- Owner answers recorded: Q1 GRANTED (merge feature/docs lanes + push; production untouched),
  Q2 CONFIRMED (≤US$8 fix loop / ≤US$12 campaign / US$25 + 8 h all-in).

**Next sequence**

1. W0: baseline recheck vs source (§2 drift), RED reproductions of the five defect classes,
   acceptance manifest + campaign schedule, machinery + quota checks, worktree setup.
2. Dispatch W1 children L (lab), C (client), H (host): goals + retention + watches armed before
   dispatch; briefs under `children/<child>/brief.md`; handbacks under
   `/root/voice-native-20260922/coordination/<child>/`.
3. On handback: independent verification of G1/G2/G3 on frozen commits → merge (Q1 granted) →
   W2 children P (provider) and J (journey/runner).

**Open questions:** none.
**Spend:** US$0.00 / 8 h live.
