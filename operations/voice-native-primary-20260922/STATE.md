# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W0 complete (G0 passed) · **W1 running** — three children active.

**Active children**

| Child | Session | Worktree · branch | Lease | Watch | Status |
|---|---|---|---|---|---|
| L lab | `01a0caf6-943c-73f0-b149-c1154832eb5d` | `wt-voice-lab` · `task/voice-native-lab` | `ee53d6a8…` | `ww_1_1790111565332` | running (goal armed) |
| C client | `01a0caf6-9844-73f0-b149-c1177fcd57a2` | `wt-voice-client` · `task/voice-native-client` | `5377dcd6…` | `ww_2_1790111565360` | running (goal armed) |
| H host | `01a0caf6-9c9f-73f0-b149-c118b03a5f7d` | `wt-voice-host` · `task/voice-native-host` | `4687bf27…` | `ww_3_1790111565415` | running (goal armed) |

All three: `zai/glm-5.3-flash` high · briefs at `children/<X>/brief.md` · handbacks
`/root/voice-native-20260922/coordination/<X>/complete.md`.

**Current truth**

- master `564efcc5` (= origin) holds Phase 0 evidence, acceptance manifest and briefs; worktrees
  based on `57efe420`.
- **Phase 0 RED confirmed 4 defects** (punctuation-free relay strip, correction accumulation,
  original-wording loss, async source binding); **casual-yes already green** (regression control).
- Sibling lineage settled (SDK bump `41c60d8a`, tree clean); merge authority granted for accepted,
  verified lanes.
- zai pool ample (off-peak) at preflight; contract 1.44.0; capacity healthy.

**Next sequence**

1. On wake: reconcile all three children (goal state, receipts, handback), independently verify
   gates G1/G2/G3 on frozen commits, then merge accepted lanes (Q1) and clean up.
2. Open W2: children P (provider profiles for standard vs ET-HIGH) and J (primary-mic journey +
   campaign runner) after W1 merges; parent integration gates between.
3. Then W3 fix loop (parent-led, bounded corrections) → W4 campaign + read-only reviewer + verdict.

**Open questions:** none.
**Spend:** US$0.00 / 8 h live (GLM child tokens are inside the zai subscription allowance; counted at
review).

**Backstop:** `wake_deadline` armed for this waiting window (recorded at arm time).
