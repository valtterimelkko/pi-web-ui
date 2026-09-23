# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 · W2 complete · **W3 fix loop RUNNING** — pass 1 diagnosed; pass 2 INVALID (stale served
build; runner fixed `d23cbac5`); **pass 3: 5/12 pass** (C09/C15/C16/C17/C21); **correction round 3 in
flight** (H3 binding race, J3 synthetic-TTS seam).

**Active children**

| Child | Session | Worktree · branch | Lease | Watch | Scope |
|---|---|---|---|---|---|
| H3 binding | `01a0cc4e-9210-73f0-b149-c132a724cea8` | `wt-voice-bind` · `task/voice-native-bind` | `5c491fe8…` | `ww_8_1790134105805` | bounded transcription grace before `unbound_source` |
| J3 TTS seam | `01a0cc4e-95e1-73f0-b149-c13402ba67af` | `wt-voice-tts` · `task/voice-native-tts` | `fae2d672…` | `ww_9_1790134105905` | labelled `--tts synthetic` journey seam + verifier byte equality |

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

- master `187a09aa`: W1/W2 + H2 + J2 + runner freshness fix + H3/J3 briefs.
- **Pass 1: 1/12** (diagnosed) · **Pass 2: INVALID** (stale served build; fixed) · **Pass 3: 5/12** —
  remaining classes: binding race (H3), journey TTS absence (J3), C05 relay variance, C14 slot.
- Live accounting: passes 1–3 (~27 min) + probes; inside §10.

**Next sequence**

1. On H3/J3 handbacks: verify, merge, cleanup; run **pass 4** (all 12) and iterate until two
   consecutive clean passes.
2. Freeze code/prompt/corpus/scorer; cost the §8 matrix (adapt rule).
3. W4: campaign + read-only reviewer + verdict; canonical docs; Agent OS capture.

**Open questions:** none.
**Backstops:** watches `ww_8`/`ww_9` primary; `wake_deadline` armed for the round-3 window.
