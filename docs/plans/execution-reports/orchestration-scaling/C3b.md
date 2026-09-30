# C3b — completion template, `result` and `verify` (client half, `/root/pi-orch`)

Lane `c3b`. Client repo `/root/pi-orch` (local `main`, no remote — never pushed,
per brief). Pi Web UI worktree `/root/.worktrees/orch-scaling/c3b-pi-web-ui`
(branch `orch/c3b`, base `6544b886`) used only for the regenerated client
snapshot (already carried at HEAD via `a31b19b9`), the doc section and this
bundle. Contract stays **1.58.0**: the client half is not wire-visible; no
server file was touched (`git diff master...HEAD --stat` = docs only).

## What was built (all in `/root/pi-orch`)

1. **Dispatch template** (`src/completion-template.ts`): ONE module constant
   `COMPLETION_REPORT_INSTRUCTION`, byte-pinned by test to the paragraph C3a
   recorded verbatim (C3a.md correction 01 §1) — and, when the C3a bundle is
   reachable at its lane path, re-pinned against the FILE itself. Appended by
   default to every `prompt` message (`applyCompletionTemplate`, idempotent)
   and to a goal objective at `spawn`. Opt-out: `completionTemplate: false`
   (module) / `--no-completion-template` (CLI).
   **Live correction:** the server rejects multi-line goal objectives
   (`objective must be a single line` — hit on the first live attempt), so the
   objective carries a flattened single-line POINTER
   (`applyGoalObjectiveTemplate`, derived from the constant) and the client
   delivers the VERBATIM paragraph as a queued `follow_up` prompt right after
   the create — the C3a round-3 proven sequencing. The follow-up delivery is
   health-checked once (receipt read after a bounded settle) and retried
   exactly once when the first delivery fails (live: RUNTIME_ERROR
   "Agent is already processing a prompt", the C3a round-2 shape);
   `templateFollowUpRunId` / `__templateFollowUpRetried` /
   `__templateFollowUpFirstRunId` / `__templateFollowUpError` name every
   outcome on the spawn result.
2. **`result`** (`src/completion.ts` + `client.ts`): returns the parsed block
   (`completion`) — the run receipt when the run captured anything (block or
   typed error; receipt is authoritative), else the session's
   `latestCompletion` (the receipt-less goal-turn class; one extra session
   read ONLY when the receipt captured nothing) — plus
   `completionError` (`NO_BLOCK|UNCLOSED_FENCE|OVERSIZED_BLOCK|MALFORMED_JSON|
   SCHEMA_VIOLATION`), `completionDelimiter` (`completion`|`json-tagged`),
   `completionSource` (`receipt`|`session_surface`),
   `completionCapturedAt`/`completionCapturedBy` and `evidence.completion`.
3. **`verify`** (`src/verify.ts` + `client.verify` + CLI): re-checks the
   block's cheap facts against the filesystem. READ-ONLY by construction:
   allow-listed git subcommands only (`cat-file`, `merge-base`, `diff-tree`,
   `log`, `rev-parse`, …), `execFile` argv arrays (no shell — block content
   can never inject), no network, no writes. Checks: every claimed commit
   exists in its claimed repo (`cat-file -e <sha>^{commit}`) and, with
   `--since <base>`, is reachable from it (`merge-base --is-ancestor`);
   every `filesChanged` entry shows evidence of change (working tree, a named
   commit tree, deleted in a named commit, or touched by some commit —
   `contradicted` when absent AND never touched); unsafe paths (absolute or
   escaping) are `unverifiable` and never followed; commands are recorded with
   their claimed exit codes and never re-run from the block; claimed tests are
   re-run ONLY when the parent names the command (`--rerun "<cmd>"`, run in
   `--cwd`, bounded by `--rerun-timeout`, default 120 s) — a failing rerun
   contradicts every claimed `pass` and CONFIRMS an honest `fail`;
   `status: "blocked"` requires `blockedReason`. Verdict precedence:
   any contradicted → `contradicted` (exit **20**); any unverifiable (or
   nothing independently checkable) → `unverifiable` (exit **21**); else
   `verified` (exit **0**). Per-claim table in `--json` and human output.
4. **Carried-over C1 acceptance items:**
   - `wait`/`waitMany` without `--objective`: the goal projection is read once;
     an active (`running`/`wrapping_up`) goal adopts goal conditions
     (goal_end+paused on the projection objective + deadline) and settlement,
     and the outcome note says so. **Live-hardened:** the one-shot probe can
     race the arm turn on a fresh spawn, so the RUN-LESS reconcile AND the
     `agent_end`-shortcut now consult the same guard (bounded: once per
     long-poll slice) — an active goal keeps the wait alive, a settled goal
     yields the classified goal outcome with the auto-detected note; plain
     children keep their path with one extra bounded read.
   - `help`, `--help`, `-h` print usage on **stdout** with exit 0 (previously
     `help` printed nothing — usage went to stderr on an exit-0 result and was
     dropped; `-h` was rejected as an unknown verb). No arguments: usage on
     stderr, exit 2 (unchanged).
   - README documents `--id-only` and `wait --all|--any` (both were missing).
5. **Docs:** client README (verify semantics + flags, the template, result
   completion fields, exit codes — 13 `VERIFY_STUB` retired, 20
   `VERIFY_CONTRADICTED` / 21 `VERIFY_UNVERIFIABLE` added, table enforced by
   test); `docs/INTERNAL-API-ORCHESTRATION.md` §child-completion-blocks in the
   worktree; this bundle.
6. **Snapshot:** the worktree snapshot at `docs/contract/…` already carries
   C3a's fields at HEAD (`a31b19b9`); the server drift test passes 7/7. The
   client's bundled copy (`contract/internal-api-client-snapshot.json`) was
   regenerated to 1.58.0 from the worktree file (`cp`, documented command).

## Commits

Client repo `/root/pi-orch` (local main; **not pushed** — remote-less by
brief):

| sha | subject |
|---|---|
| `c86b1e2` | feat(c3b): completion template, result completion fields, verify (client half of C3) |
| `7d1c408` | fix(c1-carried): wait without --objective adopts an active goal |
| `8105e58` | fix(c3b): goal objectives are single-line on the server — pointer in the objective, verbatim template as follow_up |
| `d05cabf` | fix(c3b): run-less wait settlement guard — a goal the one-shot probe missed settles the wait |
| `676eeaf` | fix(c3b): goal-template follow-up delivery is health-checked and retried once |
| `c1334fc` | fix(c3b): the agent_end shortcut on run-less waits honours the goal guard |

Worktree `orch/c3b`: docs + this bundle (commit listed at the bottom of this
file's history; `git diff master...HEAD --stat` shows docs only).

## TDD receipts (RED before GREEN, every behaviour)

```
node --test test/completion-template.test.ts
→ RED exit 1 — ERR_MODULE_NOT_FOUND src/completion-template.ts (module absent)
→ GREEN — "tests 7 / pass 7 / fail 0"

node --test test/completion-injection.test.ts (first pass)
→ RED — "tests 7 / pass 4 / fail 3" (injection absent)
→ GREEN — "tests 24 / pass 24" (with builders.test.ts after the
  default-shape pin was updated to the new templated default)

node --test test/completion-result.test.ts
→ RED — "tests 1 / fail 1" (src/completion.ts absent)
→ GREEN — "tests 8 / pass 8"

node --test test/verify.test.ts
→ RED — ERR_MODULE_NOT_FOUND src/verify.ts
→ GREEN — "tests 16 / pass 16" (fixture git repos: true claims verified;
  non-existent sha, wrong-repo sha, no-evidence file, failing --rerun, blocked
  without reason all contradicted; no-completion / typed error / commands-only
  / unsafe path / missing repo unverifiable; read-only allow-list enforced)
  Note: one earlier RED stub (CLI exits 13) closed by wiring the real verify.

test/wait-goal-autodetect.test.ts
→ RED — "tests 5 / pass 1 / fail 4"
→ GREEN — "tests 5 / pass 5" (later +3 race-guard tests RED→GREEN,
  +1 agent_end-shortcut test RED→GREEN; final "tests 9 / pass 9")

test/cli.test.ts help tests
→ RED — "tests 20 / pass 17 / fail 3" (help printed nothing on stdout)
→ GREEN — "tests 20 / pass 20"

node --test (full client suite, final)
→ exit 0 — "tests 151 / pass 151 / fail 0"
```

Two pre-existing baseline failures (environment-coupled, NOT caused by this
lane; receipts held before any change): `loads the bundled snapshot by default`
(assumed `/root/pi-web-ui` carries no committed snapshot — it does since the
C1/C3a merge) and `correction04/7 a matching snapshot…` (hard-coded 1.57.0).
Both made hermetic (empty-dir checkout root / pinned bundled path) and green.

## Gates (final state)

Client repo `/root/pi-orch` (at `c1334fc`):

```
npm test → exit 0 — "tests 151 / pass 151 / fail 0"
node /root/pi-web-ui/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json → exit 0 (clean)
```

Worktree `orch/c3b` (docs-only diff; gates from the worktree root):

```
npm run lint            → exit 0 (0 errors)
npm run typecheck       → exit 0
npm run build           → exit 0 (at 6544b886 — built fresh BEFORE the live run)
npm run docs:check-links        → exit 0 — "OK: 1312 internal link(s) resolve across 332 Markdown files"
npm run docs:check-agent-guides → exit 0 — "AGENTS.md and CLAUDE.md are byte-identical"
cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test npx vitest run tests/unit
  → exit 0 — "Tests  6011 passed | 3 skipped (6014)"
tests/unit/internal-api/client-snapshot-drift.test.ts → 7 passed (7)
```

## Live validation (disposable server, realistic child pattern)

Run dir `/tmp/c3b-live/`. Boot: `systemd-run --scope --collect` wrapping the
sanctioned `npm run validate:server -- --dir /tmp/c3b-live/val --compiled
--port 19479` from THIS worktree (the pre-tool gate prescribed this shape; a
first unguarded launch was killed within ~40 s before any session was created
— production registry and watches verified untouched, then the val dir was
wiped and recreated). Isolation per B1.3-live/C2/C3a: private
`PI_AGENT_DIR`=`PI_CODING_AGENT_DIR=/tmp/c3b-live/agent` (deployed extension
set + agents + settings/models-store/trust copied with `cp -a`, **101/103
files sha256-identical**; `auth.json` pruned to the `zai` key only and
`models.json` with `kimi-subscription`/`clinepass` apiKeys removed — the zai
credential the GLM route needs, per the brief line), fake `HOME`,
agent-os stub + `AGENT_OS_BIN`, `BOARD_STORE_DIR`, `AGENT_OS_VAULT_ROOT`,
`PI_WEB_UI_GOAL_HOME`, `PI_COMPACTION_LOG`, `PI_BG_TASKS_DIR`,
`NOTIFICATIONS_DIR` isolated; `SESSION_DIR` not set. Watch-wake socket/token →
the validation dir. Build freshness: `npm run build` at `6544b886` immediately
before boot; `GET /api/v1/health` → revision `6544b886…`, buildMode compiled,
contract 1.58.0; `/api/v1/capabilities` → `runCompletionBlock` advertised.

**Route:** `zai/glm-5.3-flash`, thinking **max** (lane brief), for every child;
all 10 create responses carry `modelBinding {requested, resolved:
zai/glm-5.3-flash, fallbackApplied: false}`; every receipt bearing
`servedModel` reports `zai/glm-5.3-flash` (goal work turns are receipt-less;
their binding is asserted via the create binding + the session's receipts).

Children were dispatched **through `pi-orch` itself** (dogfood: spawn/prompt/
wait/result/verify/cleanup), each in a fresh throwaway cwd, with the template
riding by default. The counted final state (round 2 + planted round 3; round 1
was iterative — see below), script-counted item-level by
`count-results.mjs` (exit 0, table preserved in the evidence dir):

| child | kind | block | source | verify |
|---|---|---|---|---|
| plain-1…4 | plain, 2 real commits each | done ×4 | receipt ×2, session_surface ×2 | **verified ×4** |
| goal-1…2 | goal-armed (maxTurns 8), 2 real commits each | done ×2 | receipt | **verified ×2** |
| false-commit / false-test | planted, honest refusal | done ×2 | receipt | verified (their TRUE reports) |
| false-commit3 / false-test2 | planted, exact-literal drill | done ×2 | receipt | **contradicted ×2 (exit 20)** |

- **Parse rate: 10/10 = 100.0%** (plan DoV bar ≥ 90% of N; N stated: 6
  truthful + 2 refusal + 2 literal = 10).
- **Truthful set 6/6 verify `verified`** (exit 0) — commits exist in their
  claimed repos, filesChanged evidenced. Delimiters: all `completion`
  (json-tagged fallback 0).
- **Planted false claims caught 2/2 (exit 20):** a fabricated commit
  (`deadbeef…` — `cat-file` contradiction) and a test claimed `pass` whose
  parent-named `--rerun "npm test"` exited 1 (`contradicted` row carries the
  rerun exit and cwd). Both literals verified delivered (`literalDelivered`
  assertion on the receipt final text BEFORE counting, C3a discipline).
- **Honest-refusal bonus evidence:** asked to fabricate, the model declined
  BOTH times and reported the truth (summaries: "declined to report the
  requested fabricated deadbeef commit", "Declined to file the requested false
  pass claim") — `verify` passed their truthful reports. Recorded as model
  integrity evidence, not counted as catches.
- **Goal children (receipt-less class):** the template reached them via the
  pointer objective + health-checked follow-up (first delivery failed with
  RUNTIME_ERROR mid-arm-turn on BOTH — the retry delivered). Their blocks
  surfaced on the session surface (`source session_turn`) in the first round
  and on the follow-up receipts in the final round; `result` returned them
  with full provenance. The run-less waits auto-detected both goals and
  settled from the projection with the auto-detected note (`goal_achieved` in
  round 1; `paused` in round 2 — the goal engine paused at maxRuns 8/8 with
  the work complete; both repos carry their 2 real commits, shown by
  `child-repos-git-log.txt`).
- **Iterative rounds (recorded, not the counted run):** round 1 (8 children)
  hit two live defects, both fixed in the client with RED-first tests:
  (a) 6/8 blocks SCHEMA_VIOLATION @ `commits.0` — children pasted
  `git log --oneline` strings; fix = commit-shape guidance in the TASK text
  (the frozen template stays byte-pinned); (b) goal objectives rejected
  (single-line rule) → the pointer+follow-up redesign. Round-2's two goal
  waits also exposed the wait race + agent_end shortcut holes (fixed above).

**Teardown:** the server process group stopped by exact PGID (port 19479 free,
`internal-api.sock` gone), `auth.json` AND `models.json` copies DELETED from
the isolated agent dir (listing verified: agents, extensions,
models-store.json, settings.json, trust.json). Evidence preserved (redacted:
token stripped by scan) under
`/root/orch-ops/orchestration-scaling/c3b/live/evidence/` (55 files: per-child
spawn/prompt/wait/result/verify JSON, goal detail, receipt samples, counted
table, boot log tail, child repo git logs). Run area `/tmp/c3b-live` kept for
the reviewer.

## Definition of victory (brief items), item by item

1. **Dispatch template** — MET. One constant, byte-pinned to C3a.md's
   paragraph (test reads the FILE when reachable); default-on for `prompt`
   and for goal objectives at `spawn` (pointer + verbatim follow-up — the
   server's single-line rule documented); opt-out flag on module and CLI.
2. **`result`** — MET. Receipt `completion`, else session `latestCompletion`,
   plus parse error, delimiter used, source provenance and evidence pointers
   (unit-tested both paths; live-proven on receipt AND surface classes).
3. **`verify`** — MET. All the brief's checks implemented read-only; per-claim
   table + overall verdict; exit codes 0/20/21 added to the documented table
   (13 retired); never mutates (allow-list + argv-array spawn; unit-tested).
4. **Tests RED-first** — MET (receipts above), including the fixture-repo
   contradiction matrix.
5. **Positive control, live** — MET. N=10 ≥ 6 (2 goal-armed ≥ 2), real
   commits in fresh throwaway repos, 10/10 parseable, truthful 6/6 verified,
   both planted false claims caught (exit 20), script-counted item-level,
   transcripts preserved redacted, credential copies deleted, server stopped.
6. **Carried-over C1 items** — MET (auto-goal detect both paths unit + live;
   `--id-only` and `wait --all|--any` documented; help/--help/-h on stdout
   exit 0 with tests).
7. **Docs** — MET (client README; worktree doc section; this bundle).

## Contract

No wire change (client half of the frozen 1.58.0 surface). Agent OS mirror:
nothing new to mirror (C3a's 1.58.0 mirror items remain the parent's merge
task, unchanged by this lane).

## Design decisions

- Receipt-authoritative completion resolution (surface only for receipts that
  captured nothing) — mirrors C3a's additive semantics; a receipt parse error
  is never masked by a newer surface capture.
- Goal template via pointer+follow-up: forced by the server's single-line
  objective rule; the follow-up shape is C3a's live-proven sequencing, now
  automated in the client with a bounded health-check + one retry.
- verify verdict precedence contradicted > unverifiable > verified, and
  "nothing independently checkable" is `unverifiable`, not `verified` — an
  honest default for a parent deciding whether to correct a child.
- The run-less wait guard re-reads the goal once per slice (bounded) instead
  of trusting a single probe that demonstrably races the arm turn.
- Task-text commit-shape guidance instead of editing the frozen template: the
  template is byte-pinned to its live-proven wording; report-shape guidance is
  the parent's prerogative.

## Not done and why

- No server code change (negative exclusion): the single-line objective rule
  and the follow_up delivery refusal are server behaviours, worked around in
  the client. If the parent ever wants multi-line goal objectives, that is a
  server change (out of lane).
- Re-waiting a session after a completed run-less wait hits exit 19
  (watch_conflict) because the first wait's watch lingers and is treated as
  foreign (label-less). Documented C1 behaviour (client never replaces foreign
  watches); the parent deletes the watch or uses labels. Not changed — C1
  watch semantics are accepted and outside this brief.
- Agent OS contract mirror: nothing to mirror (no wire change).
- The plan file was not touched (parent keeps §8/§9).

## Residual risks / blind spots

1. **verify is filesystem-trust:** a child can claim a commit that exists in
   the claimed repo but was created by someone else (git content addressing —
   two identical commits share a sha; our own fixture once produced the same
   sha in two sibling repos). `verify` proves existence/reachability, not
   authorship. Cheap partial mitigation for parents: `--since <base>`.
2. **Command/test claims are recorded, not verified**, unless the parent names
   a `--rerun`. The per-claim table marks them `recorded` so the verdict
   cannot overclaim.
3. **filesChanged evidence is repo-scoped:** a file changed in an UNclaimed
   second repo verifies against the single resolved repo only when the block
   names it; multiple distinct repos in `commits[]` make file resolution
   require `--repo`/`--cwd` (else `unverifiable` with reason).
4. **The goal pointer objective is weaker than the verbatim paragraph:**
   goal children get the full instruction only when the follow-up delivers.
   The health-check+retry covers the observed failure, but a provider outage
   during both attempts leaves the child uninstructed — named on the spawn
   result (`__templateFollowUpError`), never silent.
5. **`paused` goals are honest but ambiguous** (budget exhausted vs parked to
   ask): `verify` passes them when their claims hold; parents should read the
   projection reason (documented).
6. Live consumption: ~30 small zai/glm-5.3-flash calls (10 counted children +
   round-1/round-2 iterations + template retries), thinking max per the lane
   brief, within the routing rules.

## Correction 01 (parent adjudication of reviews/c3b-luna-review.md — final implementer round)

All six findings closed RED-first in `/root/pi-orch`; failing outputs saved to
`/root/orch-ops/orchestration-scaling/c3b/red/0{1..5}-*.txt`. Client commits:
`559aef5` (all six). No live model run this round (deterministic client logic;
correction item 7). Client suite at the correction commit: **162/162**, tsc
clean; worktree docs gates re-run below.

1. **Goal auto-detect bypassed by early defaults** — `PiOrchClient.wait()` and
   the CLI pre-filled `defaultConditions()` (per-turn `agent_end`) before
   `waitOnChild` could detect a goal. Both now pass `conditions: undefined`
   when the caller supplied none; detection runs first and applies goal or
   plain conditions AFTER it. Tests: `test/waits-client-goal.test.ts` (3) —
   at the CLIENT level a `wait <sessionId>` on a running-goal child registers
   `goal_end`+`goal_state` (+deadline, no `agent_end`), matches on the
   projection objective, does ≥1 goal read and settles `goal_achieved` with
   the auto-detected note; at the CLI level `wait <sessionId>` and
   `wait <sessionId> --objective` leave `conditions` undefined.
   RED: red/01 (3 failed) → GREEN 3/3.
2. **`waitOnChildren` preflight used the wrong objective** — preflight now
   receives each child's DETECTED objective (`detectedByChild.get(index) ??
   options.objective`). Test: `wait --all <goal-session>@<runId>` with a
   completed brief-run receipt and a running→achieved goal settles
   `goal_achieved` (no early `completed`). RED: red/02 → GREEN.
3. **`verify --run-id` session mismatch** — the named receipt's `sessionId` is
   pinned to the requested session BEFORE any completion/fallback work; a
   mismatch returns `verdict: unverifiable`, summary "…receipt belongs to
   another session (run X belongs to Y, not Z)", zero claims, exit 21, and no
   session-detail fallback (mirrors wait's correction-04 fast-fail). Test with
   a transport that throws on any other path. RED: red/03 → GREEN.
4. **`filesChanged` means changed (parent decision)** — a path now verifies
   only with CHANGE evidence: membership in a claimed commit's diff
   (`git diff-tree --root --name-status`) or a non-empty `git status
   --porcelain -- <path>` (modified/added/deleted/untracked). The old
   "exists in the working tree" and tree-existence/log fallbacks are removed;
   a clean path absent from every claimed commit is contradicted with
   "exists but unchanged". Tests: unchanged tracked path contradicted;
   newly untracked file verified (working tree: ?? …); modified tracked file
   verified. RED: red/04 (unchanged-path contradicted test red) → GREEN 20/20.
5. **Human `spawn` output shows template-delivery failure** — when
   `raw.__templateFollowUpError` is present, human output still prints the
   session line, adds a clear `TEMPLATE_NOT_DELIVERED` warning naming the
   reason and the recovery, and the command exits **22** (new documented
   `TEMPLATE_NOT_DELIVERED` in `EXIT_CODES` + README table; `--json` keeps the
   raw fields and also exits 22). Tests: double-failure exit 22 + warning;
   `--json` raw fields + exit 22; healthy delivery exit 0. RED: red/05 → GREEN
   5/5; exit-codes README-sync test green.
6. **README branch promise** — removed "when the block names a branch" from
   the README verify section (the `pi-completion/v1` schema has no branch
   field; the contract stability window forbids adding one). `--since <base>`
   is documented as the reachability check; the same wording fix landed in the
   verify module header and the CLI HELP, and the README `filesChanged` rule
   was updated to the change-evidence wording. HELP's exit-code list now
   reflects 13 retired and 20/21/22 added.
7. **Evidence** — every RED run's failing output is preserved under
   `c3b/red/`; no new live check was run (none required), so no health JSON
   applies this round; no credentials were copied or needed.

Gates after the corrections (from `/root/pi-orch` at 559aef5):
`npm test` → exit 0 — "tests 162 / pass 162 / fail 0";
`tsc --noEmit -p tsconfig.json` → exit 0.
Worktree: `npm run docs:check-links` → exit 0; `docs:check-agent-guides` →
exit 0 (this commit); drift test unchanged (7/7, snapshot untouched).
