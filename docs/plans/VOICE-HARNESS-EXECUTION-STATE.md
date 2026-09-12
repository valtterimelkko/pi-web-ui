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

## Children — all four complete

| Child | Session id | Outcome |
|---|---|---|
| **H1** talker harness | `01a096a8-81e9-72aa-93c7-bbbca093c60a` | ✅ committed `de6cafe` — 97 tests, structural gate verified |
| **H2** Pi input routing | `01a096a8-84c3-72aa-93c7-bbbef32af902` | ✅ merged `5c17304` — 8 tests, live-validated |
| **H3** model retest | `01a0970c-a362-72aa-93c7-bbc265ebeea4` | ✅ committed `cc3f86a` — five candidates measured, one defect found |
| **H4** long-session | `01a0970c-944c-72aa-93c7-bbc089136e0c` | ✅ committed `cc3f86a` — design claim NOT falsified, 157 turns |

All four worktrees and all four child branches are cleaned up. Only the 9 stale
worktrees from a **previous execution** remain (listed at the end).

### Isolation failure — honest record

H3 and H4 were given isolated worktrees and their sessions did report the
worktree as `cwd`, but **both wrote their artefacts into the main tree**
(`/root/pi-web-ui`) instead. Cause: their briefs named `/root/pi-web-ui` as "the
repo" while instructing them not to touch certain paths, so they followed the
absolute paths. **No collision occurred** — their changes were disjoint
(H3: results + probe + harness flag; H4: two test files) — and `server/src/talker/`
was untouched by both, as required. But the isolation I intended did not hold, and
the lesson is: name the worktree as the repo, not the main tree, and never let
the brief's scope limits be the only thing keeping children apart.

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

### 2026-09-12 ~19:45 — wave 2 accepted; a real production defect fixed

**H3 (retest) and H4 (long-session) both accepted**, verified by the parent:

- H4's numbers reproduce exactly on my run: `turns=157 trims=17 entriesDropped=290
  releases=26`. Its strongest assertion was read and is **non-vacuous** (an exact
  `.toBe(PENDING_KEEP)` on every pending-regime trim, plus an assertion that
  material was actually dropped).
- Full talker suite after both landed: **108/108**.
- `npm run typecheck` exit 0; `npm run lint` exit 0 (the six "error" matches in
  the log are pre-existing warnings whose variable names contain "error").

**A real production defect was found and fixed (TDD, RED-first).**
`model-client.ts` hardcoded `reasoning: { enabled: false }`. Some OpenRouter
endpoints **reject** that with HTTP 400 *"Reasoning is mandatory for this
endpoint and cannot be disabled"* — so the talker could not run on them **at
all**. Reasoning is now configurable; the production model's behaviour is
unchanged by default.

**Proven both directions, live:**
- production model, default path: **PASSED**, 561 ms median, 0 breaches, verbatim EXACT
- `gemini-3.6-flash`, which previously could not run: **now PASSES**, 902 ms median, pushback 2/2

### Headline findings

1. **H4: the design claim survived.** The bounded window with no summariser does
   not corrupt the gate — including the adversarial case where trims land
   *during* a live proposal: every trim stopped exactly at the pending floor, and
   the release stayed verbatim-correct from the store even after the proposing
   utterance had been dropped from history. Correctness state genuinely lives in
   the harness, not in model memory.
2. **H3: `gpt-5-nano` is disqualified** (pushback hold 2/5). It accepts the
   operator's "stop asking" premise as its new understanding of the rule. The
   structural change did eliminate its old same-turn relay pattern as predicted,
   but not this.
3. **H3: `gemini-3.6-flash` is now a measured, qualified challenger** — cleanest
   candidate: 26/26 within 2 s, max 1,280 ms, pushback 5/5, no warts.
4. **H3: `deepseek-v4.1-flash` fails on tail latency** (two turns over the 4 s
   hard line). Its prose was the best in the field; voice needs the tail.
5. **⚠️ Quality risk now attached to the incumbent.** Gemma showed **output
   instability** twice, independently: H3 saw one empty reply in 21 conversational
   turns; H4 saw `"thought"` repetition loops and empty strings on long-context
   turns. H4's raw SSE probe cleared the harness (HTTP 200, clean completion,
   no reasoning chunks) — this is model degeneracy, faithfully relayed. In a
   **voice** surface an empty reply is **silence**, which is the worst failure
   shape.

### Queued next (in order)

| # | Work | Why |
|---|---|---|
| **H5** | **Degenerate-output guard** in `model-client.ts`: detect empty / runaway-repetition replies, retry once, then fall back honestly. TDD. | The incumbent's instability is a measured production risk, and a guard makes it cheap to keep the ~18× cost advantage. **Owner asked about this — see the open question below.** |
| **H6** | **Wire the talker into the server** (Phase 3 integration): construct `TalkerSession` with the real `MultiSessionManager` and expose a turn entry point; request-receipt discipline. | Nothing consumes the harness yet — it is a library with tests and a CLI runner. This is what makes it a product surface. |
| **P2** | Consolidate the streaming-vs-idle steer decision inside `MultiSessionManager.steer()` so the Internal API and RPC call sites inherit it. | Removes the defect *class* H2 surfaced rather than patching call sites. |

## Cleanup owed at the end

- Merge or discard H2's branch `talker/pi-input-routing` and remove
  `/root/pi-web-ui-wt-h2` once its regression evidence is accepted.
- **9 stale worktrees from a previous execution** under
  `/root/.pi-web-ui/operations/four-angle-20260908/children/*` plus
  `/root/pi-capacity-release-20260907` — confirm they are unreferenced, then
  remove (operator instruction: clean up unneeded worktrees/branches).
