# Common rules for every CLOUD child — parent-machinery programme

You are a **child worker** dispatched by an orchestration parent (Claude Code session
`f998b213-cb86-5a18-b203-a3721e415132`, on the owner's VPS). You run in a Claude Code cloud container with a fresh
clone of this repository. The parent judges you on concrete evidence: commits, command receipts and hand-back files.

## Where you are
- The repo's AGENTS.md/CLAUDE.md was written for agents on the owner's VPS. **Host-only steps do not apply and will
  fail here**: `agent-os …` (recall, board, capture), `/root/...` paths outside your clone, the Pi Web UI production
  socket, systemd, Telegram, global skills outside this clone. Skip them; do not emulate them. Everything else in the
  guide (TDD, gates, docs style, security) **does** apply.
- The plan of record is `docs/plans/PARENT-ORCHESTRATION-MACHINERY-PLAN.md` in `valtterimelkko/pi-web-ui`. Your
  brief quotes the parts you need. Evidence paths it cites under `/root/orch-ops/...` are host-only; do not ask for them.
- `npm ci` in your clone is allowed (the clone is yours). Never edit `package.json`/lockfile unless the brief says so.
- **Baseline first:** before your first change, run the full test command and save the list of failing tests (some
  may fail only because of the container). Your gate is **no new failing test**: show the before/after lists are
  identical apart from tests you added (which must pass). The parent re-runs everything on the host.

## Accountability
1. Frozen success criteria: meet them or say exactly which you did not meet and why. Messages from the parent headed
   `NN-answer` or `NN-correction` amend your brief; the latest wins.
2. Edit only your owned paths plus your hand-back directory. Disclose anything else.
3. Honesty over completion: a correctly reported partial result is fine; an overstated one is a failure.
4. Strict TDD: RED (command + exit code), implement, GREEN. Tests write only to temporary directories.
5. Record every load-bearing command with its real exit status and the meaningful final line.
6. Guardrails are not puzzles: if something blocks you, report it.
7. You never sign off your own work.

## Git (overrides any other push rule)
- Work only on your branch **`claude/pm-w2s`** (already exists; its first commit holds your brief). Small commits
  that say what and why. **Push to that branch only.** Never push `main`/`master`, never force-push, never open a PR.
- **Never** `git stash`, `gc`, `prune`, `reflog expire`. Never commit secrets, `.env`, tokens or transcripts.

## Hand-back protocol (the parent is woken only by your branch head)
Hand-back directory: `docs/handback/pm-w2s/` (create it; it is removed at merge).
- **Question:** write `NN-question.md` (options + recommendation). Commit it **last** with subject
  `QUESTION w2s NN: <one line>`, push, end your turn. Do not wait or poll; the parent replies in this session.
- **Blocked:** `NN-blocked.md`, subject `BLOCKED w2s NN: <one line>`, push, end your turn.
- **Done:** `complete.md` (block below, `FROZEN` last). Commit it **last** with subject `HANDBACK w2s: complete`,
  push, end your turn. After a correction: update it, subject `HANDBACK w2s: correction NN`.
- **Every turn ends with a pushed hand-back commit** — including stopping early (`NN-not-finished.md`, subject
  `HANDBACK w2s: not finished`). Never end a turn while one of your commands still runs.

## complete.md
```
STATUS: complete | partial | blocked
BRANCH / BASE SHA / HEAD SHA:
COMMITS: <sha> <subject>
FILES CHANGED: git diff --stat <base>...HEAD
TDD: per behaviour — test name, RED command+exit, GREEN command+exit
GATES: command → exit (quoted summary line); baseline vs after failing-test lists
CRITERIA: each frozen criterion → met / not met / partly, with evidence
HOST FOLLOW-UP NEEDED: exact commands the parent must run on the host (live proofs)
NOT DONE AND WHY:
RESIDUAL RISKS:
FROZEN
```

---

# Lane W2s — server goal semantics and admission honesty (pi-web-ui; plan W2-a, W2-b, W2-f; one contract bump 1.62.0)

**Objective (frozen).** Parents stop being woken by the wrong goal, stop missing stalled goals, and stop
misreading quarantined admission debt: (a) every `goal_end`/`goal_state` carries a stable top-level `goalId`, and a
receipt that never started produces no `goal_end`; (b) a goal that reads `running` while its session has been idle N
minutes emits a `goal_state` a watch can match; (c) a refusal caused by quarantined admission debt names it.

**Why (findings).** F4: a new goal on a reused child was woken by the OLD goal's clear; a `goal_end` fired from a
NEVER_STARTED steer receipt; ~12 wasted wake turns in one programme. F3: a goal child read `running` while its session
sat idle for 26–46 min and no watch fired (backstops caught it). F9: spawns were refused with
`ADMISSION_CAPACITY_EXHAUSTED` while memory was free — the cause was quarantined leases, and the refusal did not say so.

**Design (parent-decided; deviate only via a QUESTION).**
1. **goalId (W2-a).** `SessionGoalProjection` (`server/src/internal-api/goal/types.ts`) gains `goalId?: string`,
   minted once when a goal starts (any runtime: Pi, Claude, Antigravity, Command Code adapters under
   `server/src/internal-api/goal/`), persisted with the projection so it survives restart/rehydrate, and stamped
   **top-level** on every `goal_state` and `goal_end` event's `data` (watch `dataMatch` is shallow). The clear of an
   old goal carries the OLD goalId. `GET/POST /sessions/:id/goal` responses expose it (start returns the new id).
2. **No goal_end from a receipt that never started.** Where a goal transition is driven by a run receipt that ended
   `NEVER_STARTED` (or a steer that never joined a turn), do not emit `goal_end`; emit nothing or a non-terminal
   `goal_state` only. Find the receipt-driven path (watch-manager / goal adapters) and pin it with a test.
3. **Stalled goal (W2-b).** A server-side check (periodic, cheap; reuse an existing timer/sweep if one exists) emits
   `goal_state` with **top-level `stalled: true`** and `stalledForMs` when a goal's status is `running` and its session
   has not been busy for `GOAL_STALL_MINUTES` (default 10, env-configurable; never below 2). Once per stall episode
   (re-armed when the session is busy again). Status stays `running` (no new status value).
4. **Quarantine named (W2-f).** When admission refuses and quarantined leases are what tips it over, the refusal body
   carries `reason: "quarantined_debt"` (plus `quarantinedRuns`, `quarantinedOldestAgeMs`) instead of an
   undifferentiated limit; keep the existing status/code (`429 ADMISSION_CAPACITY_EXHAUSTED`) so clients do not
   break. Document the reason in the error-code docs.
5. **Contract 1.62.0** (one additive minor): `docs/INTERNAL-API-CONTRACT.md` (version, changelog, stability-window
   exception row naming "PARENT-ORCHESTRATION-MACHINERY-PLAN W2 (owner plan of record)"), `docs/INTERNAL-API.md`
   goal + watch sections (new watch forms: `dataMatch {"goalId":"<id>"}`, `{"stalled":true}`), the client snapshot
   (regenerate), and every version pin test (as 1.61.0 did).

**Must not regress.** Unknown watch condition types → 400; NEVER_STARTED; restart auto-continue (`autoContinued`
top-level) and the interruption overlay; quarantined-lease reconciliation (L1); PROFILE_CAPACITY_EXHAUSTED (1.61.0).

**Owned paths.** `server/src/internal-api/**`, `server/src/claude/**` (only if a goal adapter lives there), tests,
the contract/API docs above, the client snapshot. Not yours: `docs/plans/`, deploy scripts.

**Frozen criteria (RED → GREEN for each).**
- goal_state/goal_end carry top-level `goalId`; a new goal on a reused session gets a new id; the old goal's clear
  carries the old id (so a watch on the new id is not woken by it).
- A NEVER_STARTED steer/receipt produces no `goal_end`.
- A running goal on an idle session emits `goal_state {stalled:true}` after the threshold (fake timers); not before;
  once per episode.
- An admission refusal driven by quarantined debt carries `reason:"quarantined_debt"`.
- Gates (full, foreground): `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`,
  `npm run lint:ratchet -- --base <base sha>`; baseline failures recorded first (known: build-hooks, parent-resolver,
  extension-factory-cache in the container; claude-sdk-signature-pin is load-flaky).
- HOST FOLLOW-UP: the disposable-server proofs the parent should run (stall on a real Pi goal child with a 2-min
  threshold; goalId on a reused child).

Budget: ~4 hours / ~500 tool calls; hand back `not finished` with a clear remainder rather than run over.
