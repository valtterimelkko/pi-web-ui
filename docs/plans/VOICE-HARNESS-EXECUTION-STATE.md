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
| ~~**H1** talker harness~~ | `01a096a8-81e9-72aa-93c7-bbbca093c60a` | merged to master | `zai/glm-5.3-flash` @ max | left | fired |
| | | **✅ COMPLETE** — committed `de6cafe`, parent-verified | | | |
| ~~**H2** Pi input routing~~ | `01a096a8-84c3-72aa-93c7-bbbef32af902` | merged to master | `zai/glm-5.3-flash` @ max | `voice-h2-pi-input-routing` | fired |
| | | **✅ COMPLETE** — merged `5c17304`, worktree removed, branch deleted | | | |

Run receipts: H1 `6c30f51e-07f3-4a72-859d-e637a13f4b24`, H2 `39b18fd7-811a-4361-912d-c990ea583d90`.

Briefs: `docs/plans/briefs/H1-talker-harness.md`,
`docs/plans/briefs/H2-pi-input-routing.md` (also staged inside the H2 worktree).

**Backstop:** `deadline-d955496a-543e-4254-985b-15370ff7070e`, armed 2026-09-12T17:27Z, fires 18:07Z.

## Parent verification log

### 2026-09-12 ~18:10 — backstop reconciliation (window 1, 40 min)

Both children were **alive and progressing** when the backstop fired; the watch
had not fired because neither had ended a turn.

| | H1 | H2 |
|---|---|---|
| session status | running, 184 msgs | running, 320 msgs |
| artefacts | `server/src/talker/` (10 modules incl. `pending-proposal`, `delivery`, `ack`, `history`, `state-view`), `server/tests/unit/talker/` (9 files incl. a 297-line `talker-gate.test.ts`), `scripts/talker-harness.ts`, `scripts/talker-prompts/v3-harness.txt` | `server/tests/unit/pi/pi-input-event-steer.test.ts` (434 lines), both target files modified (23-line diff) |

**Parent independent verification of H2's work (partial — child still running):**

- Read the actual fix. It routes mid-run input through
  `prompt(message, { streamingBehavior: 'steer' })` when streaming, falling back
  to `steer()` when idle, at both call sites. The comment records that
  `prompt()` reaches the same `_queueSteer` primitive, so queue semantics are
  preserved — the reasoning is sound.
- **Ran its test suite myself**: `npx vitest run
  server/tests/unit/pi/pi-input-event-steer.test.ts` → **8/8 pass**, including
  the defect-proof assertions and the four pinned-behaviour tests.
- **Ran the server typecheck myself**: clean (exit 0) after fixing the worktree
  environment (below). No errors attributable to H2's change.

**Worktree environment defect found and fixed by the parent** (this would have
blocked H2 when it ran checks):

The worktree had no per-package `node_modules` shadows, so TypeScript resolution
fell through to the **root** `node_modules` and picked up **zod 4** instead of
the `server`/`shared`-scoped **zod 3.25.76**, producing 11 spurious
`ZodError.errors` errors in files H2 never touched. Fixed by creating targeted
shadows: `server/node_modules/zod` and `shared/node_modules/zod` symlinked to the
main tree's zod 3 copies. Server typecheck then passed cleanly.

Note for future worktree use: symlinking only the top-level `node_modules` is
**not sufficient** in this repo — hoisted version conflicts (zod 3 vs 4) make
per-package shadowing necessary.

**Backstop re-armed** for window 2.

### 2026-09-12 ~18:17 — H1 wake (turn end); both still running

The watch fired on H1's turn end, but H1 was **still running** (247 msgs) and had
no pending approvals — it had simply ended a turn to continue working. H2 was
still running (370 msgs).

**Parent independent verification of H1's work (against the tree, not its report):**

- **Ran the talker suite myself: 9 files, 97/97 tests pass**, including
  `talker-gate.test.ts` (25 tests). Not a claim from the child — observed.
- Read `pending-proposal.ts`: the pending proposal, the verbatim utterance it
  refers to, and release history live in harness state that **the model has no
  write access to**. `takeForRelease()` is atomic (clears before returning) and
  computes staleness **at release time from the caller's turn**, so no caller can
  release an aged proposal even if it never ticked. Which instruction a "yes"
  refers to is resolved by object reference — never from conversation history.
- Read `delivery.ts`: per-runtime adapters degrade honestly. Claude refuses on a
  non-SDK backend **with the reason**; Antigravity reports queuing as a
  first-class outcome; an unwired Pi refuses rather than guessing; delivery
  outcomes carry a `disclosure` field so nothing is hidden.
- Read the gate ordering in `talker.ts`: `release()` is **private by
  construction** — reachable only from the confirm branch — and takes **no relay
  text**. The text comes solely from `takeForRelease()`. A forced direct call
  still cannot relay anything that was not a recorded, unexpired, live proposal.
  This is the strongest structural form of non-negotiable #1.
- Confirmed `history.maybeTrim(this.proposals.pending !== null)` — the
  never-trim-while-pending rule (non-negotiable #6) is implemented, not merely
  documented.
- Confirmed `ackForOutcome(delivery)` — the acknowledgement is derived from the
  actual delivery outcome, so "sending that now" cannot be spoken for a send that
  did not happen (non-negotiable #7).

**Verdict so far:** the structural claims hold under direct inspection. H1 has not
yet reported completion, so this is not acceptance — it is verification of the
artefacts present at this point.

**H1's own open item, to verify at completion:** it observed 4 test failures it
attributes to the environment (`OPENCODE_ENABLED=false` in its session shell vs
`true` in the repo `.env`), claiming the file passes 31/31 with the variable
unset. **The parent has not yet verified that attribution** — do not accept it
until the mechanism is checked.

**Backstop re-armed** for window 3.

### 2026-09-12 ~18:18 — H2 COMPLETE, verified, merged, cleaned up

H2 reported complete. Parent verification before acceptance:

- **Ran its suite myself: 8/8 pass.**
- **Checked its "pre-existing failures" claim rather than believing it.**
  Ran `tests/unit/internal-api/session-routes-orchestration.test.ts` in
  isolation: **89/89 pass** — so those 2 failures are order-dependent in the
  full-suite run, not caused by H2, and H2 had already verified them against
  base with `git stash`. Claim holds.
- Read the diff: 23 lines across two files, no secrets, no scope creep.
- Confirmed the fix reaches the **talker's** Pi delivery path:
  `delivery.ts` wires `manager.steer`, which is one of the two fixed call sites.

**Merged** (`5c17304`, `--no-ff` so the work stays attributable), then
**post-merge verification in the main tree: 105/105 pass** (H2's 8 + H1's 97) —
the two children's work coexists correctly. Worktree removed, branch deleted.

### Follow-up queued from H2's honest "what I could NOT do"

H2 surfaced two call sites with the **same defect shape**, outside its owned
files and correctly left out of scope:

- `server/src/internal-api/routes/sessions.ts:872` — the Internal API steer route
  for Pi
- `server/src/internal-api/routes/sessions.ts:5604` — the prompt/dispatch handler
- plus the worker/RPC path (`SessionRPCClient.steer` → SDK rpc-mode `steer`)

**Not a blocker for the talker**: its Pi delivery goes through
`manager.steer` (fixed). But it is a real consistency gap — anything reaching a
busy Pi session via the Internal API still cannot be observed by an extension.

**Preferred fix is consolidation, not more call-site patches:** move the
streaming-vs-idle decision inside `MultiSessionManager.steer()` so *every* caller
inherits it, and have the Internal API/RPC call sites go through that method.
That removes the defect *class* instead of patching the next site someone adds.
Queue as **P2** — after H1 lands and H4 runs.

### 2026-09-12 ~19:16 — H1 COMPLETE (verified, committed) + wave 2 dispatched

**H1 accepted after independent verification.** Its report was thorough and, more
importantly, its own tests caught four real defects during development —
including a **double-send bug** (the release path never consumed the proposal, so
a previous relay could authorise a second send), a relay-before-proposal path via
greeting questions, and a meta send question wrongly replacing the pending
proposal. That is TDD doing real work, not ceremony.

**Parent verification of the environmental claim — CONFIRMED, not assumed.**
H1 attributed 4 test failures to environment leakage. Verified directly:

- the mechanism is real: `opencode-service-expanded.test.ts` asserts
  `/not available/` at line 729, but with `OPENCODE_ENABLED=false` in the shell
  the service fail-closes earlier with "OpenCode is disabled", taking a different
  branch. The repo `.env` says `true`, so a leaked shell value shadows it.
- ran that file in a **clean** parent environment: **31/31 pass**.
- ran the **whole suite** in the clean parent environment with H1+H2 work
  present: **exit 0, 3877/3877 in the server workspace, zero failures** — better
  than H1's own 3,868/3,869, because my shell has no leaked variables at all.
- `npm run typecheck` exit 0; `npm run lint` exit 0 (warnings only, pre-existing).

**Committed `de6cafe`** — 21 files, 2,631 insertions. Board entries for H1 and H2
left. Working tree clean.

### Wave 2 dispatched (H3 + H4), each in its own worktree

Both write to this repo, so single-writer discipline applies: each got an
isolated worktree with the **zod-shadow fix applied up front** (top-level
`node_modules` symlink plus per-package zod shadows), and H4's server typecheck
was verified clean before dispatch.

| Child | Session id | Worktree | Brief |
|---|---|---|---|
| **H4** long-session validation | `01a0970c-944c-72aa-93c7-bbc089136e0c` | `/root/pi-web-ui-wt-h4` (branch `talker/h4-long-session`) | `docs/plans/briefs/H4-long-session.md` |
| **H3** model retest | `01a0970c-a362-72aa-93c7-bbc265ebeea4` | `/root/pi-web-ui-wt-h3` (branch `talker/h3-model-retest`) | `docs/plans/briefs/H3-model-retest.md` |

Watches `ww_3_1789240593701` (H4) and `ww_4_1789240598032` (H3); backstop
`deadline-c59cf991-8123-4356-a06d-9ec8ffc75034`.

**H4 is the design-claim test**: does the bounded window with no summariser hold
the gate over 100+ turns and repeated cycling, and is never-trim-while-pending
actually enforced? A fiduciary instruction was given: **if the claim is
falsified, report it and do NOT fix it** — a falsification is the valuable
outcome.

**H3 is the proxy test**: the model was selected on a marker-based benchmark we
are not shipping. Its headline question is whether `gpt-5-nano` still
propose-and-relays now that the gate is structural.

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
