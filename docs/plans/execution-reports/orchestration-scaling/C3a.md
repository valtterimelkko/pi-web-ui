# C3a — Child completion receipt, server half (contract 1.58.0)

Lane `c3a`, worktree `/root/.worktrees/orch-scaling/c3a-pi-web-ui`, branch
`orch/c3a`, base `8fc0579c` (master with C2 at contract 1.57.0). No push, no
merge, no rebase. **N was stated as 12 before the live run** (the driver file
`/tmp/c3a-live/driver.mjs` declares 8 plain + 4 goal-armed children and 1
planted malformed control; N ≥ 10 per the plan's DoV).

## What was built

1. **Schema** (`server/src/internal-api/completion/completion-schema.ts`):
   `pi-completion/v1` — a fenced code block whose info string is `completion`,
   holding one JSON object: `status` (`done`/`blocked`/`partial`, required),
   `summary`, `commands[]` (`command`, `exitCode`, `note`), `tests[]`
   (`name`, `result: pass|fail|skip`, `note`), `commits[]` (`sha`, `repo`,
   `subject`), `filesChanged[]`, `openIssues[]`, `blockedReason` (required iff
   `blocked`). Strict (unknown fields are `SCHEMA_VIOLATION`s), bounded
   (block content ≤ 16,384 chars; ≤ 50 commands/commits/issues, ≤ 100 tests,
   ≤ 200 files; sha `/^[0-9a-f]{7,64}$/i`). **Delimiter choice: a fenced block
   whose info string names the schema** — models copy fence templates reliably,
   and a line-anchored opening fence (3+ backticks at line start, exact info
   string) cannot be confused with backticks inside prose or quoted template
   strings, which the parser tests pin.
2. **Parser** (`completion-parser.ts`): pure, bounded, never throws. Finds the
   **last** complete block in the last 65,536 chars (state cap
   `COMPLETION_PARSE_WINDOW_CHARS`; block cap 16,384 — ≥ 4× headroom so
   trailing prose never pushes a compliant block out of the window). Typed
   errors: `NO_BLOCK`, `UNCLOSED_FENCE`, `OVERSIZED_BLOCK`, `MALFORMED_JSON`,
   `SCHEMA_VIOLATION` (with dotted `fieldPath`, e.g. `commits.0.sha`).
   Delimiter rules: closing fence = next backticks-only line at least as long
   as the opening (so a 4-backtick outer fence closes an inner block); a new
   `completion` opening while a block is open abandons the prior attempt (a
   model retry — the complete later block wins).
3. **Receipt capture** (`run-receipt-manager.ts`, `run-receipt-store.ts`):
   each run keeps a wider final-text tail (65,536 chars, same segment
   semantics as the 1.47.0 `finalText` tracker — which stays at 4,096 for the
   receipt's `finalText`); at `agent_end` and at terminalisation the run's
   **full final assistant text** is parsed and the receipt gains additive
   `completion` or `completionError` (both absent when no block: additive
   nothing-changes for existing callers). Store allow-list, first-wins
   persistence and defence-in-depth bounds match the `finalText` precedent.
4. **Receipt-less turns** (`completion/session-completion-tap.ts`,
   `session-completion-registry.ts`, one option on `InternalApiEventBroker`):
   a tap at the broker's `publish()` entry — **pre-rate-limit, pre-coalescing**,
   so the full delta stream is visible — feeds a bounded latest-completion
   registry (256 entries LRU, turn-scoped trackers ≤ 64, each ≤ 64 KiB, parsed
   and dropped at every `agent_end` regardless of who started the turn:
   browser, goal-engine continuation, any extension). Surfaced as additive
   `latestCompletion` on `GET /sessions/:id` and `/info` (`finalizeSessionDetail`
   + `commandCodeSessionDetail`): `{ source, capturedAt, runtime?, completion?
   | completionError? }` with `source` = `{ runId }` (receipted run, via a
   manager completion listener) or `{ kind: "session_turn", agentEndAt }`.
   Newest capture wins across aliases (registry id + Pi session path).
   **Smallest-shape choice:** one additive detail field mirrors the receipt's
   field names; parents already poll `GET /sessions/:id` (goal/ownership
   precedent), so no new route and no new poll target for C3b's `verify`.
5. **Export for C1:** `capabilities.features.runCompletionBlock` =
   `{ schema, fenceInfo, receiptFields, sessionSurfaceField, maxBlockChars,
   parseWindowChars }` — the contract snapshot can carry the dispatch template
   without a server change. Wire types live in `internal-api/types.ts`
   (contract 1.58.0).

## Commits

| sha | subject |
|---|---|
| `a5047c94` | feat(internal-api): C3a child completion block — schema, parser, receipt capture, per-session surface (contract 1.58.0) |
| `b28a7f1d` | test(internal-api): C3a completion parser, receipt capture and session-surface tests; contract pins to 1.58.0 |
| `4f18212d` | docs(internal-api): contract 1.58.0 — child completion block, receipt fields, latestCompletion surface |

`git diff --stat 8fc0579c..HEAD` → 18 files changed, 1611 insertions(+), 8
deletions(-) (server src, server tests, docs; no client/shared changes).

## TDD receipts (RED before fix, GREEN after)

New test files: `server/tests/unit/internal-api/completion-parser.test.ts`
(27), `run-receipt-completion-capture.test.ts` (9),
`session-completion-surface.test.ts` (13).

```
cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test npx vitest run \
  tests/unit/internal-api/completion-parser.test.ts
→ RED exit 1 — "Test Files  1 failed (1) / Tests  no tests" (module absent)
→ GREEN exit 0 — "Tests  27 passed (27)"   (after 3 intermediate failures were
  fixed: window-cut oversized test input, reopen-on-new-opening semantics,
  unrecognized_keys field paths)

… npx vitest run tests/unit/internal-api/run-receipt-completion-capture.test.ts \
  tests/unit/internal-api/session-completion-surface.test.ts
→ RED exit 1 — "Tests  7 failed | 2 passed (9)" (the 2 passes are additive-absence pins)
→ GREEN exit 0 — "Tests  49 passed (49)" (three files together, final)
```

## Gates (all from the worktree, after the last source change)

```
npm run lint            → exit 0 — "294 problems (0 errors, 294 warnings)"
npm run lint:ratchet    → exit 0 — checkedChangedFiles 18, violations []
npm run typecheck       → exit 0 (shared + internal-api-mcp + server)
npm run build           → exit 0
npm run docs:check-links        → exit 0 — "OK: 1310 internal link(s) … 330 Markdown files"
npm run docs:check-agent-guides → exit 0 — "AGENTS.md and CLAUDE.md are byte-identical"
cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test npx vitest run tests/unit
  → exit 0 — "Tests  5990 passed | 3 skipped (5993)" (492 files)
```

Client suite not run: server-only change (`git diff --stat` shows no files
outside `server/` and `docs/`).

## Live validation (disposable server, realistic child pattern)

Run dir `/tmp/c3a-live/` (preserved). Boot:
`systemd-run --scope --collect --unit=c3a-live-main /tmp/c3a-live/boot.sh` →
`npx tsx scripts/validation-server.ts --dir /tmp/c3a-live/val --compiled
--port 19473` from THIS worktree, with the heap-soak isolation pattern:
private `PI_AGENT_DIR`=`PI_CODING_AGENT_DIR=/tmp/c3a-live/agent`, fake `HOME`,
agent-os PATH stub + `AGENT_OS_BIN`, `BOARD_STORE_DIR`, `AGENT_OS_VAULT_ROOT`,
`PI_WEB_UI_GOAL_HOME`, `PI_COMPACTION_LOG`, `PI_BG_TASKS_DIR`,
`NOTIFICATIONS_DIR=/tmp/c3a-live/notifications` (isolated by the lane),
watch-wake socket/token → the validation dir. `SESSION_DIR` not set.

Build freshness: `npm run build` at HEAD immediately before the run;
`GET /api/v1/health` → `buildIdentity.revision
"4f18212d1456f08ada023c41f03f1290940e1c6f"` (lane HEAD), `buildMode
"compiled"`, `contract 1.58.0`; `GET /api/v1/capabilities` →
`runCompletionBlock` advertised.

Deployed-extension identity: the FULL deployed extension set (16 extensions,
including goal-engine) plus `agents/`, `settings.json`, `models-store.json`,
`models.json`, `trust.json` copied with `cp -a` — **102/102 files sha256
MATCH** against `/root/.pi/agent` (loader refuses symlinks; no symlinks used).
Model `zai/glm-5.3-flash`, thinking `low`, per routing. Child cwds: fresh
plain directories `/tmp/c3a-live/ws-plain-{1..8}`, `ws-goal-{1..4}`,
`ws-malformed` (worktree-LIKE fresh cwds; a real second git worktree was
deliberately NOT created because `git worktree add` writes metadata into the
shared production `.git` — same disclosed deviation as C2).

**The fixed instruction paragraph every child received** (verbatim; C3b makes
this the client's dispatch template; for goal children it is appended to the
single-line objective, for plain children it is its own paragraph after the
task):

> COMPLETION REPORT (required): when the task is finished, end your final message with exactly one fenced code block whose info string is completion, containing one JSON object for schema pi-completion/v1 with these fields: "schema":"pi-completion/v1", "status" ("done", "blocked" or "partial"), "summary" (one line), "commands" (array of {"command","exitCode"} with the integer exit codes of the shell commands you ran), "tests" (array of {"name","result"} where result is pass, fail or skip), "commits" (array of {"sha","repo"} with the absolute repo path), "filesChanged" (array of changed file paths), "openIssues" (array of strings), "blockedReason" (required only when status is "blocked"). Include only the fields that apply, and write nothing after the closing fence except at most one short sentence.

Trials (driver `/tmp/c3a-live/driver.mjs`, Internal API over the unix socket):

- **8 plain children**, one detached prompt each, short varied shell tasks.
- **4 goal-armed children** (`POST /sessions/:id/goal {action:"start",
  objective: <task + instruction>, maxTurns: 3}`) — the work happened in
  goal-engine continuation turns, which hold **no receipt**; all four reached
  `goal.status: "achieved"`.
- **1 planted malformed control**: instructed to emit `{"status":"done"}`
  (schema field deliberately omitted).
- A pre-wave smoke child (1 further small call) validated the path before the
  measured run.

### Results — counted from the server's captured fields by a script

`node /tmp/c3a-live/count-parse-rate.mjs` → exit 0, item-level enumeration of
12 children reconciled against the 18 durable receipt files:

- **PARSE RATE: 12/12 = 100.0%** (DoV bar: ≥ 90% of N=12 → ≥ 11).
- 7 plain children: parsed block on the **receipt** (`completion.status=done`)
  and surface source `{runId}`.
- **plain-6 (live proof of the receipt-less requirement):** its receipted
  turn ended with NO assistant text (auto-compact mid-run abort+resume shape,
  C2's accepted boundary) and no block; the extension's continuation turn did
  the work and emitted the block, which the session surface captured with
  `source {"kind":"session_turn","agentEndAt":"2026-09-30T00:54:09.976Z"}` —
  exactly the goal/extension-turn class receipts alone would miss.
- 4 goal children: parsed block on the session surface with `session_turn`
  source; goal arming/clearing receipts carry no block (empty finalText), the
  work turns were receipt-less — the surface is the only capture path, and it
  worked 4/4.
- **Malformed control:** receipt `completionError.code=SCHEMA_VIOLATION`,
  `fieldPath="schema"`; session surface shows the same typed error. No throw,
  no silent pass.
- Receipt-store reconciliation: 18 receipts = 1 smoke + 8 plain + 4 goal
  starts + 4 goal clears + 1 malformed; 8 receipted blocks + 1 typed error;
  5 blocks captured receipt-less via the surface (plain-6 + goal 1–4).
- Journal `/tmp/c3a-live/logs/server-boot.log` (784 lines): 0 matches for
  TURN_STALLED, NEVER_STARTED, "never executed", "cannot submit",
  RUNTIME_ERROR, RUN_TRANSPORT_LOST, "error".

Teardown: the boot scope ended with the nohup'd processes surviving it; the
exact server process chain was stopped by PID (`kill 4189375 4189391
4189392 4189403`), then verified: `pgrep -fa "validation-server.ts --dir
/tmp/c3a-live" | grep -v "bash -c" | wc -l` → `0`, socket file gone
(`ls: cannot access '/tmp/c3a-live/val/internal-api.sock': No such file or
directory`). The copied `auth.json` was **deleted** from the isolated agent
dir (listing shows only agents, extensions, models.json, models-store.json,
settings.json, trust.json); no heap snapshots taken; run area preserved under
`/tmp/c3a-live` only.

## Definition of victory (plan §6 C3, server half + brief), item by item

- **"Schema and parser tests, including malformed blocks."** MET — 27 parser
  tests (bad JSON, missing required fields, wrong types, two blocks last-wins,
  block inside a quoted template, block inside a 4-backtick outer fence,
  oversized, unclosed, no block) + 9 capture + 13 surface tests; RED→GREEN
  receipts above.
- **"Disposable live proof: at least 90% of N real GLM 5.3 Flash children
  produce a parseable block (N set by the executor and stated in advance)."**
  MET — N=12 stated before the run; 12/12 = 100% from the server's captured
  fields (receipt `completion` or session `latestCompletion`), counted by
  `count-parse-rate.mjs` over the durable receipt store + session reads.
- **"Positive control: a planted false claim … is caught by `verify`."** The
  `verify` verb is C3b's (client half, `/root/pi-orch`) — the brief for THIS
  lane states it "is not in your DoV". The lane's own negative control — a
  planted malformed block surfacing as `completionError` — is MET (above), and
  the schema carries the exact structured claims (commit shas + repo paths,
  test results, exit codes) C3b's `verify` re-checks, wire-published via
  `capabilities.features.runCompletionBlock`.
- **"Docs"** — `docs/INTERNAL-API.md` (block, receipt fields, per-session
  surface, capabilities), `docs/INTERNAL-API-CONTRACT.md` (1.58.0 changelog
  above 1.57.0), this bundle. MET.
- **Design-for-C3b:** the wire shape needs no further server change for
  `verify`: the block's `commits[]`/`commands[]`/`tests[]`/`filesChanged[]`
  are typed and bounded; the receipt and the per-session surface expose it;
  the capabilities export names every constant. C3b builds on contract 1.58.0.

## Runtime coverage (per the brief's "make it work or document the gap")

- **Pi**: both paths live-proven (8 receipt captures; 5 session-turn captures
  incl. an auto-compact resume turn and 4 goal continuations).
- **Claude / Antigravity**: receipt capture applies (their goal continuations
  go through the detached receipt pipeline — C2 evidence; same
  runtime-neutral event shapes). Session-turn surface applies where their
  events publish to the broker (Internal API dispatch path, goal sweep
  publishes). **Documented gap:** browser-started Antigravity turns have no
  long-lived broker observer attach point in this base, so a browser-driven
  agy turn's block is captured only if a receipt path observed it.
- **OpenCode / Command Code**: both paths by code reading — long-lived
  observers (`attachOpenCodeObserverIfNeeded`,
  `attachCommandCodeObserverIfNeeded` publishing every journaled event) feed
  the tap; receipts via the shared manager. Not live-exercised in this lane
  (Pi children only; no lane budget for a third runtime).

## Contract (1.58.0) — what the parent must mirror in Agent OS

- `INTERNAL_API_CONTRACT_VERSION` 1.57.0 → **1.58.0** (constant + contract
  doc; the mirror constant at merge).
- Additive receipt fields `completion`, `completionError`; additive session
  detail field `latestCompletion` (on `/sessions/:id` and `/info`); new
  capabilities feature object `runCompletionBlock`. No new error codes in the
  HTTP `ErrorCode` namespace; completion parse error codes
  (`NO_BLOCK|UNCLOSED_FENCE|OVERSIZED_BLOCK|MALFORMED_JSON|SCHEMA_VIOLATION`)
  live inside `completionError.code`. No new env vars.
- The Agent OS mirror edit was NOT made (negative exclusion) — the parent
  updates the mirror + pin test at merge.

## Design decisions

- **Fence-with-info-string delimiter** over a bare sentinel line: models copy
  fence shapes reliably; line-anchored scanning makes quoted templates and
  inline backticks non-openings (pinned by tests); last-block-wins absorbs
  model retries.
- **Parse the full final text via a second, wider tail tracker** (65,536) in
  addition to `finalText` (4,096): the receipt's public `finalText` stays
  payload-bounded, while the parse cannot be cut by tail truncation
  (test-proven with a block early in a >4,096-char final message).
- **Tap at `publish()` entry, not `deliver()`**: rate-limit coalescing (200/s
  per session, burst 400) and shed-trimming happen between the two; a
  `deliver()` tap would lose delta text exactly when the loop is busy — the
  receipt path (pre-broker) already proved the pre-limit seam.
- **Session surface = one additive detail field** mirroring receipt field
  names: smallest shape, no new route, alias resolution (id + Pi path) inside
  the read, never fatal.
- **A turn with no block records nothing** on the surface (absence = no
  claim), matching the receipt's additive-absence semantics.

## Not done and why

- C3b's `verify` verb and the planted-false-claim `verify` control: C3b's DoV
  (explicitly out of this lane's brief).
- Live trials for Claude/OpenCode/Command Code/Antigravity children: the
  brief's live proof names GLM 5.3 Flash children (realistic pattern =
  owner's Pi pattern); runtime generality is covered by runtime-neutral unit
  tests (event shapes from all adapters) and code reading (coverage table
  above). The Antigravity browser-turn gap is documented, not fixed (owned
  seam ends at the broker).
- Agent OS mirror edit: excluded by the brief (parent applies at merge).
- Real second git worktree as child cwd: replaced with fresh plain
  directories (production `.git` metadata; same disclosed deviation as C2).

## Residual risks / blind spots (for §4 intent-check adjudication)

1. **Broker rate-limit coalescing** can drop intermediate delta text on the
   session-turn path when a session streams >200 updates/s (burst 400): the
   tap would then see a text-truncated turn and may miss a block. The receipt
   path is immune (pre-broker). Mitigation in depth: Pi's authoritative
   `message_end` full-content event is not rate-limited-coalesced.
2. **In-process only:** the latest-per-session registry and tap live in the
   server process; a restart clears the surface (receipts stay durable on
   disk). A parent reading `latestCompletion` after a restart sees absence —
   same as "no block observed", not a false claim.
3. **Scan window bound:** a block whose opening lies >65,536 chars before the
   end of the final text is not found (`NO_BLOCK`). With the 16,384-char
   block cap this needs >48 KiB of trailing prose after the fence — protocol
   non-compliance, and the parent still sees "no claim".
4. **plain-6's underlying cause is C2's accepted auto-compact boundary**, not
   this lane's: a mid-run compaction abort leaves the receipted turn textless
   while the extension resume does the work. C3a's surface is what makes that
   work visible; the boundary itself remains C2's recorded residual.
5. **Turn-scoped parse only:** nothing is captured for a session killed
   mid-turn (no `agent_end`), and a run cancelled before its turn ends keeps
   only what its events carried. A child that emits the block and is then
   cancelled may still show the block (observational), with the receipt's
   terminal status telling the honest story.
6. Live trials consumed ~15 small zai/glm-5.3-flash model calls (12 children
   + smoke + goal continuation turns, thinking low; well within the routing
   and peak-window rules).
