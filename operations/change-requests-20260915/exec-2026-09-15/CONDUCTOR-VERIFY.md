# CONDUCTOR VERIFICATION — how a child's claim becomes an accepted outcome

Acceptance is **my verdict**, never a child's receipt. A `goal_end`, a green
handback, and an HTTP 202 are all claims. Run this per child, in the child's
worktree, before signing anything off.

## Ladder, every child

1. **Read the goal back** — `GET /sessions/:id/goal`. `achieved` is a transition,
   not proof. Note the objective and turn count against `maxTurns`.
2. **Read the receipt** — the child's latest `runId` from `children.json` →
   `GET /runs/:runId`. Check terminality, `servedModel` (must be
   `zai/glm-5.3-flash` — a silent rebind is a real failure mode), and
   `outputEvidence`.
3. **Read the handback** — `exec-2026-09-15/<TAG>-*-complete.md`. If it is missing
   or lacks RED evidence, that is a finding, not a formality: **a test that never
   failed proves nothing.**
4. **Inspect the diff myself** — `git -C <worktree> log --oneline master..HEAD`,
   `git diff master...HEAD`. Compare against the owned-path list: anything touched
   outside it is a violation to report, not to quietly absorb.
5. **Re-run the verifiers myself, in the worktree.** Not a re-read of their
   output — an independent execution. For A and B at minimum:
   - the named test file(s), `npm run typecheck`, `npm run lint`
   - for B additionally `npm run build`, and the browser harness driven by me
6. **Probe the claim that matters most**, with a **positive control** that
   reproduces the original defect. This is the step that caught a false "fixed"
   earlier in this programme: a probe that cannot fail proves nothing.

## Per-child specifics

**A (restart path)** — the load-bearing claims: does it *refuse* on a busy
session, and does it *name itself* when it restarts? Prove both with a fake
sessions response (busy → no restart) and a dry run through
`restart-pi-web-ui.sh --dry-run` (restart path taken, reason recorded). Confirm
`--dry-run`/`--no-restart` still short-circuit. **Never** exercise the real
restart.

**B (lanes + correlation)** — the load-bearing claims: nothing speaks over the
operator; a stale/foreign result cannot populate the active lane's card; a
fourth lane asks; single-lane behaviour is unchanged. Unit tests are not
sufficient for a user-facing change — **I drive the harness myself** and watch
that the operator's capture is never gated and their floor is never interrupted.
Pin the single-lane "unchanged" claim against the pre-change behaviour.

**C (investigation)** — I spot-check at least three cited `path:line` claims
against the real files. An investigation is only as good as its citations; a
fabricated or drifting line reference invalidates the section.

## Then, and only then

- Record the verdict in `STATE.md` with the evidence, and say plainly what is
  **not** verified.
- **Owner gates hold:** no merge into pi-web-ui master, no production restart,
  without explicit owner approval in the conversation. Merge stays a proposal
  until the owner closes the gate — prepare it (branches, diffstat, a merge plan),
  do not take it.
