# Documentation Review & Recommendations — 2026-09-14

> **Type:** Phase 1 investigative & advisory report (no files moved, nothing deleted).
> **Scope:** this repository only. Phase 2 (execution) is owned by the parent conductor.
> **Baseline validation at time of writing:** `npm run docs:check-agent-guides` — PASS (byte-identical); `npm run docs:check-links` — PASS (854 links across 144 Markdown files).

---

## 1. Executive Summary

Pi Web UI's documentation is unusually well-governed on paper — `DOCS-GOVERNANCE.md` defines document classes, a source-of-truth hierarchy, plan status-marker rules, and a documentation-impact checklist — but **compliance has slipped sharply during the September voice-programme sprint**, and the documentation surface has accumulated roughly **320k words (~450k tokens) of Markdown**, of which more than half is completed plans and briefs that agents must read to classify.

Headline findings:

1. **The three freshness anchors are stale.** Root `README.md` ("Latest work: Command Code"), `docs/MAINTAINER-INDEX.md` ("Recent major doc-relevant changes"), and `docs/RECENT-CHANGES.md` contain **zero** mention of the Voice Mode programme, the lint-ratchet re-baseline, or the secrets migration — despite those being ~50 commits and 3 days of work. An agent that trusts the anchor layer receives ~10-day-old truth. This is the single highest-leverage defect.
2. **Current-behaviour facts are trapped in history directories.** The Voice Mode observability field table — referenced as canonical from `OBSERVABILITY.md` — lives at `./plans/VOICE-MODE-OBSERVABILITY-DESIGN.md`. The secrets-migration outcome (where secrets now live) is recorded only in a plan file's append-only log; `DEPLOYMENT.md`, `SECURITY.md`, and `.env.example` documentation do not reflect the new locations. The lint-ratchet policy rationale lives in comments inside `scripts/check-lint-ratchet.mjs`, not in any maintainer doc.
3. **Plan status compliance is 0/45.** Governance requires every plan to carry a visible status block; none of the 45 files in `docs/plans/` has one. Twenty-eight transient execution briefs sit in `docs/plans/briefs/`. Result: ~265k tokens of unclassified history that every navigation-minded agent must either read or distrust.
4. **The Voice Mode feature has no canonical feature doc.** Sixty-three of the last 100 commits are voice/talker work; there is no `docs/VOICE-MODE.md`, and `MAINTAINER-INDEX.md` has no Voice section.
5. **Genuine bloat exists and is precisely identifiable.** A retired runtime design (1,443 lines), four resolved defect observations/briefs, a retired-patch history file, three transient validation-results files, and roughly two dozen completed plans are ready to move to a `docs/archive/` tree with an index.

The proposed Phase 2 (Section 7) is a five-workstream programme: (A) refresh the three anchors and codify a freshness rule; (B) create `docs/VOICE-MODE.md` and promote trapped canonical facts; (C) archive ~35 files into `docs/archive/{plans,briefs,observations}/` with an `INDEX.md`; (D) add a plan-status link-checker extension so compliance is enforced, not hoped for; (E) consolidate the Internal API guide family. Estimated total diff is modest (mostly `git mv` + small edits), and every step is mechanically validated by the existing `docs:check-links` / `docs:check-agent-guides` gates.

---

## 2. Inward-Facing (Agent) vs Outward-Facing Documentation

The repo already declares four reading paths in `docs/README.md` (adopter, API consumer, troubleshooting operator, maintainer/agent). The classification below is the same axis made explicit, with one important extra class the governance file implies but does not name: **research/design records** — internal, historical, "not current behaviour" documents that are neither runbooks nor plans.

### 2.1 Outward-facing (adopter / external integrator)

Audience: someone evaluating, installing, or driving Pi Web UI from outside. Token-efficient, honest about caveats, no host-specific paths that embarrass on a public repo (several current docs violate this — see §2.4).

| File | Role | Notes |
|---|---|---|
| `README.md` (root) | Public landing | "Latest work" line is stale (says Command Code; should lead with Voice Mode) |
| `docs/FIRST-RUN.md` | Single blessed first-success path | Good; distinct class from GETTING-STARTED |
| `docs/GETTING-STARTED.md` | Full adopter menu | Canonical prerequisites |
| `docs/RUNTIME-OVERVIEW.md` | Runtime chooser | |
| `docs/PLATFORM-SUPPORT.md` | Hosting tiers | |
| `docs/FEATURE-MATRIX.md` | Core vs runtime vs companion | |
| `docs/FILES-TAB.md`, `docs/DRIVE-MODE.md`, `docs/GOAL-EXTENSION-UI.md` | Feature docs | DRIVE-MODE is now partially superseded by the Voice Mode two-lane harness — needs a pointer to the new voice surface |
| `docs/NOTIFICATIONS.md`, `docs/SELF-NOTIFICATIONS.md` | Notification features | |
| `docs/DURABILITY-MATRIX.md` | What survives restart | |
| `docs/UPGRADE-MIGRATION.md` | Adopter migration notes | Current through 1.38.0 |
| `docs/PROJECT-STORY.md`, `docs/VISION.md` | Public context | Candidates for a merge (§5) |
| `API.md` (root) | REST/WS/Internal API surface index | Index only — correct |
| `docs/PROTOCOL.md` | WebSocket contract | Canonical |
| `DEPLOYMENT.md`, `SECURITY.md` (root) | Ops runbook, security posture | **Gap: do not mention `secrets.env` / out-of-repo env.dev layout introduced by H8** |
| `docs/INTERNAL-API-QUICKSTART.md`, `docs/INTERNAL-API-RECIPES.md` | External automation consumers | See consolidation options in §5 |

### 2.2 Inward-facing (maintainer / coding agent)

Audience: an LLM agent or human changing this repo, debugging a runtime, or operating it as a live runbook. This is where token efficiency matters most.

| File | Role | Notes |
|---|---|---|
| `AGENTS.md` / `CLAUDE.md` | Agent entry point, byte-identical pair | ~13.4 KB each; good discipline, verified by gate |
| `docs/MAINTAINER-INDEX.md` | Reading order + recent-changes hub | **Stale "recent changes" section; no Voice Mode entries; no lint-ratchet pointer** |
| `docs/CODEBASE-MAP.md` | File→purpose index | Mentions Drive Mode only; voice server modules (talker harness, voice relay routes) under-represented |
| `docs/ARCHITECTURE.md`, `docs/EVENT-PIPELINE.md`, `docs/PROTOCOL.md` | System structure | Canonical |
| `docs/TROUBLESHOOTING.md` + `docs/TROUBLESHOOTING-DECISION-TREE.md` | Evidence ladder + symptom-first tree | Both earn their place; voice Q&A covered via one pointer each |
| `docs/OBSERVABILITY.md` | Logs, namespaces, diagnostics, error codes, Voice Mode observability section | **Its voice field table links out to `plans/` — governance violation** |
| `docs/SHARP-EDGES.md` | Known traps | Healthy |
| `docs/INTERNAL-API.md` (2,994 lines) | Canonical Internal API reference | Large; see §5 |
| `docs/INTERNAL-API-CONTRACT.md` | Version authority (1.42.0) | Canonical |
| `docs/INTERNAL-API-ORCHESTRATION.md`, `docs/ORCHESTRATED-RUN-LIVENESS-AND-RECOVERY.md` | Orchestration guide + liveness intent | |
| `docs/LIVE-VALIDATION.md`, `docs/LONG-HORIZON-VALIDATION.md` | Validation runbooks | Canonical |
| `docs/DOCS-GOVERNANCE.md` | The rules themselves | Needs enforcement (§6, §7) |
| `tests/README.md` | Test layers + commands | Only doc mentioning `lint:ratchet` beyond briefs |
| Runtime deep dives: `CLAUDE-BACKENDS.md`, `CLAUDE-PROVIDER-PROFILES.md`, `OPENCODE-DIRECT-INTEGRATION.md`, `OPENCODE-MODEL-AUTOMATION.md`, `PI-OPENROUTER-MODEL-AUTOMATION.md`, `ANTIGRAVITY-INTEGRATION.md`, `COMMAND-CODE-INTEGRATION.md`, `PROCESS-ISOLATION-DESIGN.md`, `RUNTIME-COMPANIONS.md`, `ADDING-A-RUNTIME.md`, `SESSION-METADATA.md` | Canonical per-runtime | Keep all |

### 2.3 Research / design records (internal, historical — neither runbook nor plan)

These are kept deliberately (governance class "plan/history"), but they currently sit at the same level as canonical docs, which misleads agents. All are archive-or-status-header candidates:

| File | Status | Recommendation |
|---|---|---|
| `docs/KIMI-CODE-RUNTIME-INTEGRATION-DESIGN.md` | Kimi runtime retired 2026-09-09; integration never implemented | **Archive** (1,443 lines — biggest single reclaim) |
| `docs/PI-CODEX-COMPACTION-SESSION-ID.md` | Patch ecosystem RETIRED (upstream fixed) | **Archive** |
| `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` | Findings record; superseded by the shipped voice harness | **Archive after** `docs/VOICE-MODE.md` exists |
| `docs/HEADROOM-TYPE-CONTEXT-LAYER.md` | Design note, researched-not-implemented | Archive (or keep with explicit `Status: dormant` header) |
| `docs/CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md` | Future proposal, not implemented | Keep with status header (plausible near-term work) |
| `docs/STEERING-RUNTIME-RESEARCH.md` | Verified wire research, referenced by LIVE-VALIDATION §Steering | **Keep in place** — load-bearing research |
| `docs/REVERSE-TRANSFER-FEASIBILITY.md` | Complete feasibility investigation, not implemented | Archive (borderline) |
| `docs/MCP-SERVER.md` | Validated experiment, retained-but-disabled | Keep in place; header already states lifecycle clearly |

### 2.4 Honesty problem inside "external" docs

Two outward-facing docs currently carry host-private facts that post-date the H8 secrets migration: `DEPLOYMENT.md` and `SECURITY.md` do not describe the current secret locations (`secrets.env` beside the service, dev env moved out of the repo to `/root/.pi-web-ui/env.dev`, `.env` no longer load-bearing, `.env.production` holding zero secret values). Meanwhile `docs/README.md` itself warns that "many docs intentionally contain concrete paths… because this repository doubles as a live operational manual" — a deliberate trade-off, but secret *locations* policy belongs in `SECURITY.md`/`DEPLOYMENT.md` in redacted, operator-generic form. Phase 2 should add a short "Secrets layout (post-2026-09-13 migration)" section to both, without host-specific values.

---

## 3. Commit Analysis — Past 50 Commits

Range: `20d527e` … `729a222`, **2026-09-12 → 2026-09-14** (three days). Distribution: 25 `docs`, 9 `feat`, 6 `fix`, 5 `chore`, 3 `test`, 2 merge commits. 30/50 are `voice`-scoped. Extending to 100 commits, 63 are voice/talker-related — this is the dominant recent workstream by a wide margin, and it is **entirely absent from the documentation anchor layer**.

### 3.1 Voice Mode (Drive Mode Two-Lane programme)

Feature arc visible in the log:

- **Harness + transport:** talker harness (H1), Pi input routing (H2), transport binding browser→talker (H7, `39752dc`/`c22bb6a`), worker session relay fixed server-side (`ed3ea2f` — every UI relay now delivers).
- **Speech policy:** anti-duet rule as a speech priority ladder (`99d87e4`), client speech arbiter (`0041ecf`), receipt ack ("one short acknowledgement, never an agreement", `5e97bb4`, made real in `0ea0cbf`), dedup fix — "the speech surface can no longer say the same thing twice" (`8b066b3`).
- **Operator surface:** Voice Mode UI with four unmistakable states (`6d9618a`), operator draft surviving interleaving (`fa6550c`), **Stop talker** (`9261aba` — silence, clear queue, don't come back), **reading levels: verbatim / summary / headlines** (`729a222`, latest commit; design agreed 2026-09-14 in `./plans/VOICE-READING-AND-QA-DESIGN.md`).
- **Robustness:** barge-in crash fixed + client-side voice errors surfaced (`3b7b66c`), mobile socket durability (E1, `17d2f1c`/`7cdb147` — resume recovery, no lost sends), server event-loop stall root-caused and fixed (R1/R2, `c2ce523`).
- **Observability:** Voice Mode observability + per-runtime worker state view (P10+P11, `8d9f4ad`), id/path relay fix (P12).

**Documentation consequences (current gaps):**

1. No canonical feature document. `docs/VOICE-MODE.md` does not exist. The feature is discoverable only through `OBSERVABILITY.md` §Voice Mode, one `TROUBLESHOOTING.md` line, `DRIVE-MODE.md` (which describes the older single-lane overlay), and `./plans/VOICE-HARNESS-EXECUTION-STATE.md` (a 1,276-line parent execution log).
2. `OBSERVABILITY.md` §Voice Mode says "Design + field table: `docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md`" — a canonical doc delegating current-behaviour field documentation to the plans directory. This is the clearest governance violation in the repo.
3. `MAINTAINER-INDEX.md` has zero Voice Mode entries; `CODEBASE-MAP.md` mentions `DriveModeOverlay.tsx` but not the talker-harness/voice-relay server modules landed by the programme.
4. `RECENT-CHANGES.md` current highlights stop at 2026-09-11; root `README.md` "Latest work" is Command Code.
5. `docs/TALKER-MODEL-REQUIREMENTS.md` is a self-contained *search brief* for a model-research agent (its own words) — transient tooling, not a feature doc; archive once the talker model choice is settled and recorded in the new feature doc.

### 3.2 Lint ratchet headroom restoration

Three commits: `a880cf7` (1,738 → 1,700 — trim), `b820e3d` (**1,700 → 306** — the real fix), `5743b8c` (merge of the operator's separately-dispatched headroom agent + ceiling re-baseline so the gate stays alive).

Substance (verified in `scripts/check-lint-ratchet.mjs` header comments): ~1,400 of the ~1,700 warnings were `no-explicit-any` / `no-non-null-assertion` in **test files**, where mock stubs and `!` assertions are normal practice. `.eslintrc.json` now exempts test/script globs for those two rules; production rules untouched. The whole-repo ceiling was re-baselined from 1,738 to **306 actual + 20 genuine margin**, with an unusually honest comment explaining why leaving the old ceiling would have turned the ratchet into a dead gate ("headroom is a measurement gap, not safety").

**Documentation consequence:** the *policy* — what the ratchet is, where the ceiling lives, when and how it may be re-baselined, and the dead-gate failure mode — exists only as comments in the script and mentions inside voice-programme briefs. `tests/README.md` references `lint:ratchet` as a command but carries no headroom rules. Phase 2 should add a short "Lint ratchet policy" subsection to `tests/README.md` (single source, next to the test/lint commands) and link it from `MAINTAINER-INDEX.md` §Tests.

### 3.3 Secrets migration (H8, `fec53dd`, 2026-09-13)

Completed outcome, from the commit record: every live secret now sits outside the repository. `.env` was load-bearing (sole home of `CSRF_SECRET`, loaded by `dotenv.config()` without overriding systemd) — deleting it outright would have broken the config check; so `CSRF_SECRET` moved into `secrets.env` first, then `.env` moved out of the repo to `/root/.pi-web-ui/env.dev` (mode 600), and the service restarted with `CSRF_SECRET` still resolving and zero config issues. Audit results: `.env.production` has **0 secret vars**; `.env.example`'s non-empty secret-looking values verified to be placeholders distinct from live values; nothing live was ever committed. Remaining operator-owned items: rotation of three secrets that sat world-readable inside a public-repo directory, and nine stale worktrees.

**Documentation consequence:** none of this is reflected in `DEPLOYMENT.md`, `SECURITY.md`, or `.env.example` commentary. The only record is the plan-log entry in `./plans/VOICE-HARNESS-EXECUTION-STATE.md` (itself an archive candidate). Phase 2 must extract the durable policy (secrets live outside the repo; `.env` is not load-bearing; never reintroduce) into the two root ops docs. `SECURITY.md` should also record the rotation caveat so it isn't lost when the execution state is archived.

### 3.4 Other notable commits in range

- `f67e304` — Command Code weekly catalogue refresh (routine automation, fine).
- `5f05e9c` — disposable-server isolation defect recorded as an accepted limitation (a docs-recorded acceptance — good pattern).
- `20d527e` — intent-file correction (orchestration/relay conflation).
- `fec53dd`/`12bd14b` — H8 restart deployed, production healthy.

---

## 4. Bloat & Archiving Candidates (exact list)

Proposed target layout (Phase 2; nothing moved yet):

- `docs/archive/` — retired top-level docs
- `docs/archive/plans/` — completed/superseded plans
- `docs/archive/briefs/` — the 28 voice-programme execution briefs
- `docs/archive/observations/` — resolved defect observations & verdicts

Mechanical note: `scripts/check-doc-links.mjs` walks the entire repo (only `node_modules`, `.git`, `dist`, `build`, `coverage` are ignored), so **files moved into `docs/archive/` remain link-checked** — archiving cannot silently rot links inside the archive. The only mandatory Phase 2 work is updating *inbound* links from live docs; the checker will fail loudly on any miss. Today's baseline: 854 links / 144 files, all resolving.

### 4.1 Top-level `docs/` → `docs/archive/`

| File | Lines | Why |
|---|---|---|
| `docs/KIMI-CODE-RUNTIME-INTEGRATION-DESIGN.md` | 1,443 | Kimi runtime retired 2026-09-09; design never implemented. Update the `MAINTAINER-INDEX.md` §5 entry to a one-line tombstone pointing into the archive. |
| `docs/PI-CODEX-COMPACTION-SESSION-ID.md` | ~200 | Patch ecosystem retired (upstream server-side fix); MAINTAINER-INDEX already labels it RETIRED. |
| `docs/2026-09-04-SDK-QUERY-LOOP-ABORT-OBSERVATION.md` | ~150 | Resolved same-day; banner already points at the verdict doc. Keep the pair together in the archive. |
| `docs/2026-09-04-SDK-QUERY-LOOP-ABORT-VERDICT.md` | ~200 | Fix sequence executed 2026-09-04; evidence complete. |
| `docs/ADMISSION-CAPACITY-BOTTLENECK-OBSERVATION.md` | ~100 | Banner: RESOLVED 2026-09-11, executed via the capacity plan. |
| `docs/WATCH-DEFECT-RESTART-BRIEF.md` | ~200 | Completed work brief for the watch-defect/restart recovery effort. |
| `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` | 316 | Findings record superseded by the shipped two-lane harness; archive **after** `docs/VOICE-MODE.md` absorbs anything still load-bearing. |
| `docs/REVERSE-TRANSFER-FEASIBILITY.md` | ~200 | Complete feasibility investigation, unimplemented, dormant. |
| `docs/HEADROOM-TYPE-CONTEXT-LAYER.md` | 423 | Researched-not-implemented design note. Acceptable to keep with a `Status: dormant` header instead — Phase 2 owner's call. |
| `docs/TALKER-MODEL-REQUIREMENTS.md` | 153 | Self-described "self-contained search brief" for a one-off model search; archive once the chosen talker model + requirements are recorded in `docs/VOICE-MODE.md`. |

Kept in place deliberately: `docs/STEERING-RUNTIME-RESEARCH.md` (load-bearing for LIVE-VALIDATION §Steering), `docs/CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md` (live proposal; add status header), `docs/MCP-SERVER.md` (retained-but-disabled experiment whose package still ships; header already honest).

### 4.2 `docs/plans/` → `docs/archive/plans/`

Completed / superseded (verify each against `git log -- <file>` during Phase 2, but all carry strong completion evidence):

- `H3-TALKER-RETEST-RESULTS.md` (336) — transient retest results; explicitly a parent-facing artifact
- `VOICE-MODE-VALIDATION-RESULTS.md` (256) — Phase 5 acceptance evidence, programme closed
- `VOICE-MODE-BROWSER-E2E-RESULTS.md` (275) — P9 results, findings closed (`d3d3bc5`)
- `VOICE-HARNESS-EXECUTION-STATE.md` (1,276) — parent execution log; "all work packages complete, verified and merged"; **before archiving, extract** the H8 secrets audit + rotation caveat into `SECURITY.md`, and the R1/R2 stall defect outcome into `OBSERVABILITY.md`/`SHARP-EDGES.md` if not already there
- `VOICE-MODE-OBSERVABILITY-DESIGN.md` (163) — **only after** its field table is promoted into `OBSERVABILITY.md` (it is cited as canonical today)
- `CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md` (707) — goal function deployed to production 2026-08-27 (contract 1.27.0 era)
- `DRIVE-MODE-TWO-LANE-PLAN.md` (1,010) — the voice programme plan; delivered
- `CODEBASE-HARDENING-IMPLEMENTATION-PLAN.md` (1,131) + `CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md` (756) — delivered; MAINTAINER-INDEX already calls the report "the evidence ledger" (update that link)
- `COMMAND-CODE-GOAT-CATALOGUE-IMPLEMENTATION-REPORT.md` — delivered
- `COMMAND-CODE-SIMPLIFICATION-AND-COMPLETION-PLAN.md` — delivered
- `INTERNAL-API-DISPATCH-AND-IDENTITY-INTEGRITY-PLAN.md` + `-REPORT.md` — delivered (1.34.0 era)
- `INTERNAL-API-EVENTS-UNBOUNDED-STREAM-FIX-PLAN.md` — delivered (contract 1.24.0, 2026-08-23)
- `INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25.md` + `-ROUND-2.md` — both executed and deployed
- `INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md` — executed 2026-09-11 (per the admission-capacity observation's resolution banner)
- `FILES-TAB-MARKDOWN-EDITOR-PLAN.md` — MAINTAINER-INDEX already says "now delivered"
- `SESSION-METADATA-UNIFICATION-PLAN.md` — v2 model shipped (`SESSION-METADATA.md` is canonical)
- `NOTIFICATION-LAYER-MVP-PLAN.md`, `NOTIFICATION-OPTIN-IDENTITY-FIX-PLAN.md` — shipped (`NOTIFICATIONS.md` canonical)
- `OBSERVABILITY-HARDENING-PLAN.md`, `SESSION-EVIDENCE-OBSERVABILITY-PLAN.md` — shipped
- `SESSION-ADOPTION-PLAN.md`, `SUBAGENT-CARD-ENRICHMENT-PLAN.md` — shipped (child-orchestration surfacing 1.34.0)
- `UI-OUTAGE-HARDENING-2026-09-03-PLAN.md`, `WS-PATH-MEMORY-ROBUSTNESS-2026-09-05-PLAN.md`, `PI-MODEL-BINDING-DURABILITY-PLAN.md`, `PI-WEB-UI-RATE-LIMIT-AND-SESSION-HYGIENE-FIXES.md` — dated incident/fix plans, executed
- `CLAUDE-SDK-ASK-USER-QUESTION-PLAN.md`, `CLAUDE-SDK-ASK-USER-QUESTION-TIMEOUT-FIX-PLAN.md` — shipped (MAINTAINER-INDEX lists AskUserQuestion as supported)
- `CLAUDE-COMMAND-CODE-STEERING-PLAN.md` — shipped (mid-run steering documented as working)
- `FOUR-ANGLE-IMPROVEMENT-SEQUENCE.md` + `FOUR-ANGLE-IMPROVEMENT-REPORT.md` — completed sequence
- `PI-WEB-UI-INTERNAL-API-MCP-MVP-IMPLEMENTATION-PLAN.md` (1,549) — MCP experiment shut down; archive with status header
- `ANTIGRAVITY-JSON-STREAM-INTEGRATION-PLAN.md` — delivered as 1.37.0 (RECENT-CHANGES cites it)
- `ANTIGRAVITY-GOAL-AND-SESSION-LOGS-PLAN.md` — delivered as 1.38.0
- `CHILD-ORCHESTRATION-SURFACING-PLAN.md` — delivered (1.34.0 highlights entry)

**Keep active in `docs/plans/`** (do not archive):

- `VOICE-READING-AND-QA-DESIGN.md` — agreed 2026-09-14, packages A/B/C in flight (A landed in `729a222`)
- `PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md` (2,119) — **not archive material**: Phases 0–7 complete and in service, Phases 8–9 paused, and `AGENTS.md` cross-repo context links to it. Add the governance status header ("completed through Phase 7; 8–9 paused 2026-08-20; see Programme pause section") but keep it in place.
- `ANTIGRAVITY-BACKGROUND-TASKS-AND-ARCHIVE-ROBUSTNESS-PLAN.md`, `ANTIGRAVITY-FRONTEND-PARITY-AND-CONTEXT-HONESTY-PLAN.md`, `ANTIGRAVITY-TURN-DURABILITY-PLAN.md` — Phase 2 owner should verify status per file (`git log -- <file>`) and either archive or header; listed as *verify-then-decide*.

### 4.3 `docs/plans/briefs/` → `docs/archive/briefs/`

All 28 briefs (`E1…R2`) are per-work-package dispatch briefs for the voice programme whose packages are complete and merged. Archive the directory wholesale. If `VOICE-READING-AND-QA-DESIGN.md` spawns new briefs, new ones can live afresh in `docs/plans/briefs/`.

### 4.4 `docs/drafts/`

`docs/drafts/2026-09-04-claude-agent-sdk-query-fail-fast-DRAFT.md` — retained intentionally (upstream draft, deliberately not submitted). Keep; the `drafts/` namespace already communicates status.

### 4.5 Net effect

Roughly **35 files / ~14,500 lines / ~120k words (~170k tokens)** move out of the live navigation surface, leaving `docs/plans/` with ~4 active files and `docs/` root with only current-behaviour documents. The archive remains fully link-checked and indexed (§6), so nothing is lost — it is simply no longer toll-paying on every agent orientation.

---

## 5. Merging & Compaction Opportunities

Ordered by value-to-risk ratio:

1. **Internal API family (4 guides + 2,994-line reference).** Current split: `INTERNAL-API-QUICKSTART.md` (shortest loop), `INTERNAL-API-RECIPES.md` (task patterns), `INTERNAL-API-ORCHESTRATION.md` (child sessions), `INTERNAL-API.md` (canonical reference). Recommendation: **merge RECIPES into INTERNAL-API.md as a top-level "Recipes" section** (recipes duplicate endpoint facts that drift) and keep QUICKSTART + ORCHESTRATION as distinct, non-overlapping classes per governance. Alternative (lower effort): keep all four but add a comparison table at the top of `INTERNAL-API.md` stating exactly what each file owns. Do **not** merge the CONTRACT — it is the version authority and must stay standalone.
2. **`PROJECT-STORY.md` + `VISION.md`.** Both short, both "understand the project", both public. Merge VISION into PROJECT-STORY (or append VISION as its final section) and leave a redirect stub. Saves one orientation hop for adopters and agents.
3. **`OBSERVABILITY.md` + `TROUBLESHOOTING.md` voice content.** After `docs/VOICE-MODE.md` exists, voice Q&A should live in exactly one place (the feature doc) with one-line pointers from OBSERVABILITY (records/fields) and TROUBLESHOOTING (symptom ladder) — not three overlapping explanations.
4. **`DRIVE-MODE.md` → `VOICE-MODE.md` relationship.** Drive Mode doc describes the single-lane overlay; the two-lane voice harness now supersedes much of it. Recommend: DRIVE-MODE.md shrinks to "the overlay UI" + explicit pointer to VOICE-MODE.md for the talker/voice surface, avoiding two competing "voice" entry points.
5. **Plans discipline (preventive compaction).** Governance already prescribes status blocks; enforcement (§6) plus the archive means future plans stop accreting. Additionally: cap brief lifespans — a brief whose work package merged gets archived in the same merge commit.
6. **Not recommended to merge:** `TROUBLESHOOTING.md` with the decision tree (distinct classes, both referenced), `CLAUDE-BACKENDS.md` with `CLAUDE-PROVIDER-PROFILES.md` (distinct audiences), `GETTING-STARTED.md` with `FIRST-RUN.md` (menu vs shortest path — governance explicitly wants both).

---

## 6. Agent Navigation, Troubleshooting & Observability Architecture (Token Efficiency)

### 6.1 What already works (keep)

- **Byte-identical `AGENTS.md`/`CLAUDE.md` entry point** with a strict sync gate — excellent; ~4k tokens to orient any agent.
- **Three-layer routing:** root guide → `docs/README.md` (four reading paths) / `MAINTAINER-INDEX.md` (maintainer reading order) → canonical docs. Do not add a fourth index layer; the fix is freshness and enforcement, not more indexes.
- **Fast session diagnosis:** `npm run debug:where` → `/evidence` bundle → screen transcript → scoped diagnostics ladder, documented identically in `AGENTS.md`, both troubleshooting docs, and `docs/README.md`.
- **`docs:check-links` walks the whole repo** (including any future archive), so link rot is mechanically impossible to miss.
- **`OBSERVABILITY.md`** is a genuinely good agent doc: namespaces, correlation IDs, error-code catalog, voice observability with copy-paste `voiceTurnId` queries.

### 6.2 The real token-efficiency failures (evidence-based)

1. **Stale anchors misdirect agents.** All three "what's new" surfaces (README latest-work, MAINTAINER-INDEX recent-changes, RECENT-CHANGES.md) pre-date the largest workstream of the quarter. An agent following them wastes a full orientation cycle rediscovering Voice Mode via `git log`.
2. **Unclassifiable history tax.** 45 plans + 28 briefs with no status markers ≈ 265k tokens that an agent must either read or consciously distrust. A status line costs 1 line; its absence costs a skim.
3. **Canonical facts in history directories.** Voice field table (plans/), secrets layout (plan log), lint policy (script comments). Agents that find them do so by grep luck, not navigation.
4. **Duplicate voice explanations** (DRIVE-MODE vs OBSERVABILITY vs plans) with no authoritative feature page.

### 6.3 Proposed architecture

**(A) Three-anchor freshness contract (highest leverage, near-zero cost).**
Codify in `DOCS-GOVERNANCE.md`: *every programme-completion or behaviour-changing merge must update, in the same commit, (1) `RECENT-CHANGES.md` (one dated bullet, newest-first), (2) `MAINTAINER-INDEX.md` "Recent major doc-relevant changes" (cap at 10 items; older items drop off), and (3) root `README.md` "Latest work" (one line, ≤2 items).* Phase 2 begins by back-filling all three for: Voice Mode programme, lint re-baseline, secrets migration.

**(B) Canonical Voice Mode page.**
New `docs/VOICE-MODE.md` (~150 lines): what the two-lane harness is (talker lane vs work lane), the four UI states, speech priority ladder / anti-duet rule, receipt ack semantics, stop-talker behaviour, reading levels (verbatim/summary/headlines), barge-in behaviour, mobile socket durability, model requirements summary (absorbing `TALKER-MODEL-REQUIREMENTS.md`), and pointers to OBSERVABILITY §Voice Mode. Cross-link from: `AGENTS.md` "If you need to change X" table, `MAINTAINER-INDEX.md` (new §Voice), `docs/README.md` day-to-day features, `DRIVE-MODE.md`, `CODEBASE-MAP.md` (add voice server modules), `FEATURE-MATRIX.md`.

**(C) De-plan-ify canonical facts.**
Promote the voice observability field table into `OBSERVABILITY.md` §Voice Mode (then archive the design); add the post-H8 secrets layout to `SECURITY.md` + `DEPLOYMENT.md` (redacted, operator-generic: secrets live outside the repo; `.env` not load-bearing; `.env.example` placeholders only); add the lint-ratchet policy to `tests/README.md` (ceiling semantics, re-baseline rules, dead-gate rationale, pointer to the script's header comment).

**(D) Archive with an index, not a cliff.**
`docs/archive/INDEX.md`: one line per archived file — *what it was, outcome, date, superseded-by link*. Agents get history findability (grep one small index) without history reading cost. MAINTAINER-INDEX entries for archived items become one-line tombstones.

**(E) Enforce plan status mechanically.**
Extend `docs:check-links` (or add `scripts/check-plan-status.mjs` wired into `npm run docs:check-links`/CI): every `docs/plans/*.md` must begin with `Status: prospective|active|completed|superseded|abandoned` (+ canonical link when terminal). Every current plan gets a header during the Phase 2 move. This converts §6.2-2 from a tax into a single grep.

**(F) Per-doc class header.**
One line under each `docs/*.md` title: `Class: canonical | quickstart | recipe | reference | troubleshooting | history` (governance already defines these classes). Cheap for agents to route and for future tooling to lint (e.g., "history-class docs may not be referenced as normative from canonical docs" — which would have caught the OBSERVABILITY→plans violation automatically).

**(G) Token budget targets (soft gates, no new tooling required initially).**
`AGENTS.md` ≤ 4k tokens (today ~4k — hold the line); `MAINTAINER-INDEX.md` ≤ 4k (trim stale recents when archiving); `docs/README.md` ≤ 3k; every canonical doc starts with a ≤10-line summary header so an agent can decide relevance without reading the body. After Phase 2, the live (non-archive) doc surface drops from ~320k to ~180k words, and the *expected orientation path* (AGENTS → INDEX → one canonical doc) stays under ~12k tokens for the common cases.

### 6.4 Troubleshooting & observability routing after Phase 2

Single canonical chain, unchanged in shape, corrected in content:

```
symptom → TROUBLESHOOTING-DECISION-TREE.md (symptom-first)
        → TROUBLESHOOTING.md (evidence ladder: debug:where → /evidence → screen transcript → scoped diagnostics)
        → OBSERVABILITY.md (logs/namespaces/correlation/error codes/Voice Mode records)
        → runtime deep dive (per-runtime logs & failure modes)
        → docs/archive/INDEX.md (only if the answer is historical)
```

Voice-specific: `voiceTurnId` reconstruction stays in OBSERVABILITY; "why did the talker say/refuse that" moves to VOICE-MODE.md's behaviour section; both cross-link.

---

## 7. Concrete Action Plan for Phase 2

Sequenced so each step ends green (`docs:check-agent-guides` + `docs:check-links`), each independently shippable, no step destructive (archive = `git mv`, history preserved):

**Step 1 — Anchor refresh (do first; unblocks honest navigation).**
1. `README.md`: replace "Latest work" with Voice Mode one-liner (link `docs/VOICE-MODE.md` once it exists; until then link OBSERVABILITY §Voice Mode).
2. `docs/MAINTAINER-INDEX.md`: rewrite "Recent major doc-relevant changes" (Voice programme, lint re-baseline, secrets migration, Kimi retirement, watch-defect recovery); cap at 10; add §Voice placeholder.
3. `docs/RECENT-CHANGES.md`: add dated entries for the three workstreams.
4. Add the three-anchor freshness rule to `DOCS-GOVERNANCE.md` checklist.

**Step 2 — Canonical facts out of history.**
1. Promote voice observability field table from `docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md` into `OBSERVABILITY.md`.
2. Add post-H8 secrets layout to `SECURITY.md` + `DEPLOYMENT.md` (redacted); record rotation caveat.
3. Add lint-ratchet policy subsection to `tests/README.md`; link from MAINTAINER-INDEX §Tests.

**Step 3 — `docs/VOICE-MODE.md` + integration.**
Create the feature doc (content per §6.3-B); update `AGENTS.md` table (+ regenerate `CLAUDE.md` via `npm run docs:sync-agent-guides`), `docs/README.md`, `DRIVE-MODE.md`, `CODEBASE-MAP.md`, `MAINTAINER-INDEX.md`, `FEATURE-MATRIX.md`.

**Step 4 — Archive sweep.**
1. Create `docs/archive/{plans,briefs,observations}/` + `docs/archive/INDEX.md`.
2. `git mv` the §4.1 top-level files (KIMI, PI-CODEX, both SDK-QUERY-LOOP files, ADMISSION, WATCH-DEFECT, VOICE-ORCHESTRATOR-FEASIBILITY, REVERSE-TRANSFER, TALKER-MODEL-REQUIREMENTS, and optionally HEADROOM).
3. `git mv` the §4.2 completed plans and the 28 briefs (verify each with `git log -- <file>` first).
4. Extract-and-then-move for: `VOICE-HARNESS-EXECUTION-STATE.md` (secrets audit → SECURITY.md first) and `VOICE-MODE-OBSERVABILITY-DESIGN.md` (after Step 2.1).
5. Update all inbound links (MAINTAINER-INDEX tombstones, docs/README, OBSERVABILITY); the link checker enforces completeness.
6. Add status headers to retained plans: RESOURCE-SCALING (completed-through-7/paused-8-9), CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN (proposal), MCP-SERVER (already has one), plus any ANTIGRAVITY plan that survives verification.

**Step 5 — Enforcement tooling.**
1. Plan-status check (§6.3-E) wired into the docs check entry point and CI (`.github/workflows/application.yml`).
2. Optional: class-header check (§6.3-F) once headers exist.

**Step 6 — Internal API consolidation (separate PR, after 1–5).**
Merge RECIPES into `INTERNAL-API.md` (or add ownership table if the merge churns too many links); merge `VISION.md` into `PROJECT-STORY.md`.

**Validation gates for every step:** `npm run docs:check-agent-guides`, `npm run docs:check-links`, plus `git grep` for any moved filename to prove zero stale references. Steps 1–5 touch only Markdown + scripts — no runtime code — so no live-validation or contract implications.

**Explicit Phase 2 non-goals:** translating docs content wholesale, creating new indexes beyond `docs/archive/INDEX.md`, touching other repositories, or renumbering the Internal API contract family.

---

## Appendix — Measurement Baseline (2026-09-14)

| Metric | Value |
|---|---|
| Root Markdown files | 6 (README, AGENTS, CLAUDE, API, DEPLOYMENT, SECURITY) ≈ 10.8k words |
| `docs/*.md` root | 58 files ≈ 130.7k words (~183k tokens) |
| `docs/plans/*.md` | 45 files ≈ 176k words |
| `docs/plans/briefs/*.md` | 28 files (included in the ~190k words above) |
| `docs/drafts/` | 1 file |
| Plans carrying governance status block | **0 / 45** |
| Voice/talker commits in last 100 | 63 |
| RECENT-CHANGES mentions of voice/secrets/lint work | 0 |
| Link checker | PASS — 854 links / 144 files |
| Agent-guides sync checker | PASS — byte-identical |
| Internal API contract version | 1.42.0 (`docs/INTERNAL-API-CONTRACT.md`) |
