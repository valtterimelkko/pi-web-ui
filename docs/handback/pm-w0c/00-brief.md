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
- Work only on your branch **`claude/pm-w0c`** (already exists; its first commit holds your brief). Small commits
  that say what and why. **Push to that branch only.** Never push `main`/`master`, never force-push, never open a PR.
- **Never** `git stash`, `gc`, `prune`, `reflog expire`. Never commit secrets, `.env`, tokens or transcripts.

## Hand-back protocol (the parent is woken only by your branch head)
Hand-back directory: `docs/handback/pm-w0c/` (create it; it is removed at merge).
- **Question:** write `NN-question.md` (options + recommendation). Commit it **last** with subject
  `QUESTION w0c NN: <one line>`, push, end your turn. Do not wait or poll; the parent replies in this session.
- **Blocked:** `NN-blocked.md`, subject `BLOCKED w0c NN: <one line>`, push, end your turn.
- **Done:** `complete.md` (block below, `FROZEN` last). Commit it **last** with subject `HANDBACK w0c: complete`,
  push, end your turn. After a correction: update it, subject `HANDBACK w0c: correction NN`.
- **Every turn ends with a pushed hand-back commit** — including stopping early (`NN-not-finished.md`, subject
  `HANDBACK w0c: not finished`). Never end a turn while one of your commands still runs.

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

# Lane W0c — Claude profile concurrency: raise the default, advertise it, refuse before the run (pi-web-ui)

**Objective (frozen).** A Claude SDK profile at its concurrency cap must refuse new work *up front* with a typed reason
naming the profile and its cap, never accept a run that then dies as `RUNTIME_ERROR`; the schema default rises from 2
to 8; `/capacity` (and the `/models` profile entries) advertise each profile's `maxConcurrent` and current use.

**Why (plan W0-c, finding F8).** All 11 production profiles sit at the default 2. A parent's third Sonnet spawn was
accepted, then failed instantly with `RUNTIME_ERROR` — no parent could see the cap. Enforcement today:
`server/src/claude/claude-sdk-service.ts:282-292` (throws inside the prompt path after the run is accepted);
schema default `server/src/claude/claude-profiles.ts:74`; profiles hot-reload (`claude-profiles.ts` ~L111-141).

**Design (decided by the parent; deviate only with a QUESTION).**
1. Schema default `maxConcurrent` 2 → 8. Keep the per-profile override.
2. Add a read-only accessor on the Claude service: per profile `{ profileId, maxConcurrent, active }`.
3. Internal API admission: a `prompt`/`follow_up` that would start a new turn on a `claude` session whose profile is
   at its cap is refused **before a run receipt is created**, as `429` with a new typed code
   `PROFILE_CAPACITY_EXHAUSTED` (body names `profileId`, `maxConcurrent`, `active`; `Retry-After` set). The same check
   applies to create-with-initial-prompt/goal and batch prompt entries. `steer` (joins a live turn) is exempt.
   Keep the in-service throw as the last-line guard.
4. `GET /capacity` gains additive `claudeProfiles: [{ profileId, maxConcurrent, active }]`; `/models` Claude profile
   entries gain additive `maxConcurrent`.
5. Contract **1.61.0** (additive minor): update `docs/INTERNAL-API-CONTRACT.md` (version, changelog row, the new
   code in the error-code list, the two additive fields) and `docs/INTERNAL-API.md` where the cap/capacity are
   described. Follow how 1.59.0/1.60.0 were recorded. Do not touch the Agent OS mirror (the parent does).

**Owned paths.** `server/src/claude/**`, `server/src/internal-api/**`, the contract/API docs above, tests next to the
code you change. **Not yours:** `~/.pi-web-ui/claude-profiles.json` (host config; the parent raises it), deploy
scripts, anything under `docs/plans/`.

**Frozen criteria.**
- RED→GREEN unit/integration tests: (a) default is 8; (b) with a profile at `maxConcurrent: 2` and two active turns,
  a third prompt is refused 429 `PROFILE_CAPACITY_EXHAUSTED` with no run receipt created; (c) `/capacity` and
  `/models` carry the fields; (d) steer on a busy session at cap still works.
- Existing contract tests and the error-code list tests green; `must not regress`: unknown watch condition types
  still 400; NEVER_STARTED and restart auto-continue tests untouched and green.
- Gates (full, foreground): `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`,
  `npm run lint:ratchet -- --base <base sha>`. Baseline failures recorded first.
- `HOST FOLLOW-UP NEEDED` lists the disposable-server live proof the parent will run (3rd and 4th concurrent Sonnet
  child run under a cap of 8; a dispatch beyond a deliberately low cap is refused before creation).

**Budget.** Stop and hand back (`not finished`) after ~3 hours or ~400 tool calls.
