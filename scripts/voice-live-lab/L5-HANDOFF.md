# L5 Handoff — Tier 3 Live Model as Orchestrator & B2-Short Fixtures

**Child C, Voice Live Lab build sequence (plan §23 L5 row; intent §17).**
Committed on `master`; the parent independently verifies and signs off.

## What was delivered

| Deliverable | Path | Status |
|---|---|---|
| Tier-3 tool surface | `scripts/voice-live-lab/lib/tier3-tools.ts` | NEW |
| Tier-3 orchestrator harness | `scripts/voice-live-lab/lib/harness/tier3-orchestrator.ts` | NEW |
| B2-short driver (dry + measured) | `scripts/voice-live-lab/lib/b2-short-driver.ts` | NEW |
| CLI `tier3-dryrun` / `tier3-run` | `scripts/voice-live-lab/cli.ts` | additive |
| README (tier-3 usage) | `scripts/voice-live-lab/README.md` | updated |
| Tool-surface contract tests | `server/tests/voice-live-lab/tier3-tools.test.ts` | NEW (29) |
| Orchestrator + B2-short tests | `server/tests/voice-live-lab/tier3-orchestrator.test.ts` | NEW (23) |
| B2-short benchmark | `/root/agent-benchmarks/benchmarks/04-voice-live-lab/b2-short/**` | NEW (separate repo) |

Nothing in `server/src/**` was touched; the two mandatory skills are *described*
in the system instruction, not re-implemented. Attempt records and testbeds are
written only outside the repositories (`…/04-voice-live-lab/runs/…`, gitignored).

## 1. `tier3-tools.ts` — the tool surface (§17.2)

Seven declared functions, all `NON_BLOCKING`, every response scheduled
`WHEN_IDLE` (`FunctionResponse.scheduling`; `scheduling` is a *response* field in
`@google/genai` 1.52.0, not a declaration field — the declarations carry
`behavior: NON_BLOCKING`):

`create_child`, `prompt_child`, `child_status`, `read_child`, `wait_for`,
`run_checked`, `notify_owner`.

- **Zod-validated arguments.** A bad argument is a *refusal with a reason*, never
  a throw: e.g. `brief` > 4000 chars, `tail` > 40 lines, `timeoutS` > 600,
  `wait_for condition=text-contains` without `text`, `notify_owner` > 300 chars.
- **`create_child`** forces the child invariant (`pi` / `zai` /
  `zai/glm-5.3-flash` / `high`), or the GLM peak-window twin
  (`commandcode/z-ai/glm-5.3-flash`) when `peakWindow` is explicitly declared —
  the host never guesses a route. `cwd` must be inside the run directory. The
  first child of a run needs the owner's confirmation; later children do not.
  The brief's bytes and SHA-256 are recorded for fidelity scoring.
- **`run_checked`** is a pure grammar, not a shell: any metacharacter
  (`; & | `` ` `` $ > < \` newline) refuses the command outright, because the host
  spawns **without a shell** — what is validated is exactly what runs. Allowed:
  `git -C <dir inside the run dir> log|status|diff`, `python3 -m unittest …`
  with the run dir as cwd, `bash …/ctl.sh restart|health|status`, and
  `cat`/`ls` of paths inside the run dir. Path traversal is resolved and
  re-checked (`cat <runDir>/../secrets` → refused; `<runDir>/repo-core/../repo-tools/x` → allowed).
- **Polling rule.** `child_status` / `read_child` called twice inside 30 s with
  no intervening `wait_for` counts as one poll; the ledger entry is marked, and
  an event is emitted. A `wait_for` clears the rule.
- **Confirmation protocol (host-enforced).** A consequential call
  (`create_child` first use, `ctl.sh restart`) injects
  "the owner must confirm …" as a context update and holds the tool result until
  a **committed operator utterance classified `confirm`** arrives or 60 s lapse
  (`refused: no-confirmation`). Requests are **serialised, not refused**: two
  concurrent `create_child` calls queue behind one request and share the grant
  (the §17.3 permission table grants each action *once per run*), while a grant
  for one action never satisfies a *different* action. The model's own words
  never grant anything.
- **Ledger.** Every call records `callId`, name, args, status, result, start/end
  wall time, connection generation, poll flag and confirmation flag — this is
  what a reconnect restores orchestration state from.
- **Both real and hermetic seams:** `createHttpTier3Api` (Unix-socket Internal
  API: `POST /sessions`, `POST /sessions/:id/prompt`, `GET /sessions/:id`,
  `GET /sessions/:id/transcript?view=screen`, `POST|GET /sessions/:id/watch`,
  `DELETE`), `createLocalCommandRunner` (spawn, no shell), and
  `createFakeTier3Api` / `createScriptedCommandRunner` for hermetic use.

## 2. `tier3-orchestrator.ts` — lifetime handling (§17.4)

- **Connect config on every connection:** `responseModalities: ['AUDIO']`, both
  transcriptions, `sessionResumption: {}` (or `{handle}` when resuming),
  `contextWindowCompression: { slidingWindow: {}, triggerTokens: 100000 }`, the
  seven declarations, the system instruction.
- **System instruction** ≤ 600 words (v1 is ~570), names both mandatory skills,
  and is versioned + SHA-256'd into the attempt's condition. There are 50
  lines of prompt here and the model cannot read files, so the discipline lives
  in the context.
- **Operator path:** implements `ProviderInputSink`; the 400 ms commit rule
  reuses the L4 `TranscriptCommitTracker`. `activityEnd(atMs)` deliberately
  **ignores** its argument — `SpeechDriver` passes the stream *duration* there,
  not a clock reading.
- **`goAway`:** finish in-flight **response sends** (`drainResponses`), close,
  reconnect with the last `newHandle`, increment `connectionGeneration`, send
  exactly one "Reconnected. Open tool calls: … Children: …" context update, and
  re-issue *as a context update tagged with the original call id* any tool
  result that could not go out while the socket was down. Tool **executions**
  are deliberately *not* awaited before closing: a `wait_for` may legitimately
  run for ten minutes and must survive the reconnect (this was a real defect
  found by test — `drain()` waits for everything, `drainResponses()` for sends).
- A **fourth** reconnection in one attempt is refused
  (`reconnection-budget-exhausted`, §21 budget = 3). Messages from a superseded
  generation are logged as `staleGenerationMessage` and dropped rather than
  mutating current state.

## 3. B2-short (separate repo, `agent-benchmarks`)

Same fixtures, three events and six dimensions as Benchmark 2, smaller work:

- `repo-core`: `tests/test_transfer.py` **pre-written and failing (3 tests)**;
  `tests/test_worker_middleware.py` pre-written for the gated Phase 3 wiring,
  with the loader (`src/worker_bridge.py`) already present.
- `repo-tools`: pre-written failing suites for `TaskQueue` and `ToolRunner`; the
  contract is written down in `AGENTS.md`.
- `mock-service`: unchanged `ctl.sh` (refuses a restart while `activeTurns > 0`).
- `beats.json` is the **single source of truth**: four frozen spoken beats, a
  declarative `triggers` block, the branching beats (including the frozen "you
  don't need to ask me that") and a permission table of exactly two entries
  (create a child once, restart once). Replies are phrased so the talker's own
  classifier reads them as `confirm` ("Yes, go ahead." / "Yes, restart it.").
- `simulator/supervisor.py`: 60 s timeouts (was 90), settle after 3 idle ticks,
  15-minute hard cap, `observer` and `session` modes, dry-run. It evaluates the
  **same declarative trigger objects** the TypeScript driver evaluates, so the
  two implementations cannot drift on intent.
- `scripted-children/`: the hermetic dry run's stand-in children — each writes
  the file a real child would write and commits it, so the triggers, the quality
  gate and the scorer all see real repository state.

## 4. Runner, CLI and the dry run

`tier3-dryrun` is the L5 verification gate made runnable:

```
npx tsx scripts/voice-live-lab/cli.ts tier3-dryrun \
  --runs-root /root/agent-benchmarks/benchmarks/04-voice-live-lab --run-id <id>
```

It walks `B2_SHORT_DRY_SCRIPT` (which *is* the policy, as data, so it is
reviewable): establish both children (with the owner's confirmation) → wait on
a watch, not a loop → route the incident to the child holding repo-core context →
assign the feasibility note → **inspect the commit log and run repo-core's
suite** → un-gate Phase 3 autonomously → check `ctl.sh status` before the
confirmed restart → verify `ctl.sh health`. It survives an injected `goAway`
between beats. What is **scripted**: the live model and the two child sessions.
What is **real**: the repositories, git history and commits, the mock service
and every `run_checked` command (real `git`, real `python3 -m unittest`, real
`ctl.sh` exit codes).

`tier3-run` is the measured entry. It refuses without `GEMINI_API_KEY`, without
an explicit `--socket` + `--token-path` (so it can never silently target
production), and without operator audio fixtures unless `--probe-tone`
explicitly labels an equipment smoke run.

`writeDerivedTranscript` projects the lab event log into
`parent-transcript.txt` so the **unchanged** `score_orchestrator.py` can score a
B2-short run. §17.5 assigns the *canonical* transcript-dimension mapping to
`score_voice.py::tier3_transcript_dimensions`, which is outside this child's
owned paths — the derived transcript is the equivalent projection and the report
labels it as derived.

## 5. Verification evidence (all re-runnable)

| Gate | Command | Result |
|---|---|---|
| Unit tests | `cd server && npx vitest run tests/voice-live-lab/` | **250/250 pass** (198 existing + 52 new; 0 modified) |
| Typecheck | `npm run typecheck` | **exit 0** |
| Lint | `npm run lint` | **0 errors** (warnings only; none new in these files) |
| Build | `npm run build` | **exit 0** |
| Scorer parity | `python3 -m pytest /root/agent-benchmarks/benchmarks/04-voice-live-lab/tests/ -q` | **12/12 pass** |
| B2-short fixture parity | `python3 -m pytest /root/agent-benchmarks/benchmarks/04-voice-live-lab/b2-short/tests/ -q` | **10/10 pass** |
| End-to-end dry run | `cli.ts tier3-dryrun --runs-root /root/agent-benchmarks/benchmarks/04-voice-live-lab` | `verify=ok`, 1081-event record, `children=2 toolCalls=19 polls=0 generations=2`, Benchmark 2 scorecard **100 %** |
| Instrument discriminates | `tier3-orchestrator.test.ts` → *proves the instrument discriminates* | asking to un-gate drops D1 below 100 in a real scored run; a branching preference answer grants nothing (exactly two permitted actions are ever confirmed) |
| Offline verify | `cli.ts verify <attempt>` | `OK`, manifest sha256 OK, dense seq, monotonic times, all mechanical checks passed |

The fixture parity suite proves the instrument before any candidate touches it:
both repositories really start RED, the scripted reference child really turns
them GREEN, the mock service really refuses an uncoordinated restart, the
manifest is in Benchmark 2's shape, `beats.json` really has four frozen beats
and exactly two permitted actions, the declarative triggers really evaluate from
repository state, and the manifest's beats are byte-identical to `beats.json`.

## 6. Known boundaries (for the parent's sign-off)

1. **No measured tier-3 attempt was run here.** Gate 3's live half (standard ×3,
   ET-high ×3, ET-low ×2 plus the two text controls) needs the operator's Live
   window, Supertonic operator-audio fixtures, a disposable server and a quota
   read — all budgeted decisions (§21), not this phase's deliverable. The dry
   run proves the machinery; it proves nothing about any model.
2. **The dry run scores 100 % on Benchmark 2's unchanged scorer.** That is the
   *scripted* parent following a competent script on a real fixture — the
   expected result. It is a machinery proof, not a candidate result, and the
   record is labelled `mode: "dry-run"`, `realProviderCalls: 0`,
   `realServices.liveModel: false`.
3. **`nano`-level detail in `supervisor.py` is not exercised by the dry run**: the
   dry run uses the TypeScript driver's own trigger evaluation. The pytest suite
   covers the Python evaluator's rules, the mock service and the dry-run beat
   loop, but the Python `--mode session` path (prompting a real Pi text-control
   session over a socket) is only exercised when a text control actually runs.
4. **`score_orchestrator.py`'s D2 heuristic** looks for `try:`/`except` in
   `repo-core`. B2-short's documented fix is a one-line `None` guard plus an
   `isinstance` check, which satisfies D2 through its *tests-green* branch, not
   the literal `try:` branch. The dimension is therefore earned by a real test
   run rather than by string-matching, which is the stronger reading.
5. **Two pre-existing TypeScript diagnostics** exist in `scripts/voice-live-lab/`
   outside the workspace `typecheck` gate (they predate this phase and are not
   included in `npm run typecheck`): `cli.ts`'s shared `runAttempts` callback
   type for the baseline/tier-1 commands, and several `handshake.ts` /
   `tier1-*.ts` narrowings. This phase's files typecheck clean under a
   scripts-inclusive `tsc` run; the pre-existing ones were left untouched as
   out of scope.
6. **D6 (milestone discipline) reads `notify.sh`.** §17.2 says `notify_owner`
   *replaces* `notify.sh` for tier 3, so the unchanged scorer sees zero
   `notify.sh` calls and awards the dimension from the absence of verbosity.
   That is the documented substitution, but it means D6 is not really
   discriminating in a tier-3 row; the canonical fix belongs in
   `score_voice.py::tier3_transcript_dimensions`, outside this child's paths.

## 7. For the parent

- Commits: `c0a3ff4` … `6b2192e` on `master` (pi-web-ui, five commits: feature,
  two test/hardening, docs, manifest detail); `afa130e` on `main`
  (agent-benchmarks). Both pushed.
- `docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md` carries the parent's uncommitted
  "Child C Dispatched (Phase L5)" entry and was deliberately left untouched.
- Gate 3's live half (live candidates + the two B2-short text controls) is the
  next step and is a scheduled, budgeted, operator-window run, not a code task.
- An Agent OS capture for this phase is best taken by the parent at sign-off,
  together with the L4 row, rather than duplicated from a child session.

---

FROZEN-HANDBACK: Phase L5 Tier 3 Live Model as Orchestrator Complete.
