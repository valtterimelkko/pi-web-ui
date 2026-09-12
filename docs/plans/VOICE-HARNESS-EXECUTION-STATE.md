# Voice harness execution — live state (parent)

> Parent keeps this current. If a different agent picks this up, read this file
> first, then `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md`.
> Written 2026-09-12. **Update on every wake.**

## Goal

Execute the agreed two-lane voice scope end-to-end with children, using TDD and
live validation, developing additional validation methods, cleaning up worktrees
afterwards.

## Parent

- Session: `01a0920a-55bc-7367-8281-00dc765d8225` (bare Pi CLI)
- Board entry: `pi-01a0920a`
- Wake path: `watch_wake_register` (bare CLI ⇒ server-side `onFire` cannot reach me)

## Children in flight (wave 1)

| Child | Session id | Tree | Model | Board | Watch |
|---|---|---|---|---|---|
| **H1** talker harness | `01a096a8-81e9-72aa-93c7-bbbca093c60a` | `/root/pi-web-ui` (main) | `zai/glm-5.3-flash` @ max | `voice-h1-talker-harness` | `ww_1_1789234031763` |
| **H2** Pi input routing | `01a096a8-84c3-72aa-93c7-bbbef32af902` | `/root/pi-web-ui-wt-h2` (branch `talker/pi-input-routing`) | `zai/glm-5.3-flash` @ max | `voice-h2-pi-input-routing` | `ww_2_1789234035294` |

Run receipts: H1 `6c30f51e-07f3-4a72-859d-e637a13f4b24`, H2 `39b18fd7-811a-4361-912d-c990ea583d90`.

Briefs: `docs/plans/briefs/H1-talker-harness.md`,
`docs/plans/briefs/H2-pi-input-routing.md` (also staged inside the H2 worktree).

**Backstop:** `deadline-d955496a-543e-4254-985b-15370ff7070e`, armed 2026-09-12T17:27Z, fires 18:07Z.

## Queued, not yet dispatched (blocked on H1)

- **H3** — retest the top five Benchmark 3 finalists against the *real* harness,
  in this repo rather than the benchmark repo. Candidate list pending operator
  confirmation of the marker-penalised fifth pick.
- **H4** — long-session check (100+ turns, repeated window cycling) against the
  real harness, proving the bounded window and the pending-proposal rule.

## Decisions already settled (do not relitigate)

- Talker model: `openrouter/google/gemma-4-26b-a4b-it`, **thinking off**.
- Send acknowledgement is exactly **"sending that now"**, spoken only after the
  harness confirms the send succeeded.
- The gate is **structural**: the talker cannot send; only the harness sends, from
  a confirmed pending proposal, using the operator's **raw utterance** by id.
- The prompt **justifies** the gate; the pushback turn is a mandatory test.
- No LLM summariser in v1; bounded rolling window, turn-boundary trimming, never
  trimmed mid-exchange.

## H3 — approved candidate list

Operator approved 2026-09-12. Retest against the **real harness** in this repo:
1. `openrouter/google/gemma-4-26b-a4b-it` (thinking off) — the incumbent
2. `google/gemini-3.6-flash` (minimal)
3. `deepseek/deepseek-flash` (off)
4. `openai/gpt-4o-mini` (off)
5. **`openai/gpt-5-nano`** (minimal — provider floor; no thinking-off exists)

**Why #5 is `gpt-5-nano`:** it is marker-penalised (1 hard fail in the earlier
sweep), and its documented failure was specifically a *propose-and-relay-in-the-
same-turn* pattern — which is exactly what the structural gate should make
impossible once the model no longer owns the send. It is also the fastest
candidate after gpt-4o-mini. It therefore tests the harness change rather than
merely re-running the field.

## Supervision standard set by the operator (2026-09-12)

- **Independently verify each child's work** after it stops — not to the deepest
  depth, but genuinely: check claims against the tree, run the key evidence
  yourself rather than trusting the report.
- **Rework is allowed**: the same model may be asked to redo a section that is
  not up to standard, rather than the parent silently fixing it.
- **Operator does not need code review.** They are needed when **usage testing**
  starts, not before. Keep them informed by Telegram; questions go to Telegram or
  they will not be seen.
- Milestones go to Telegram as well as this file.

## Outstanding operator question (non-blocking)

None. The H3 fifth-candidate question was answered 2026-09-12 (gpt-5-nano).

## Cleanup owed at the end

- Merge or discard H2's branch `talker/pi-input-routing` and remove
  `/root/pi-web-ui-wt-h2` once its regression evidence is accepted.
- **9 stale worktrees from a previous execution** under
  `/root/.pi-web-ui/operations/four-angle-20260908/children/*` plus
  `/root/pi-capacity-release-20260907` — confirm they are unreferenced, then
  remove (operator instruction: clean up unneeded worktrees/branches).
