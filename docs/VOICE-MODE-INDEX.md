# Voice Mode — document index and reading order

> **Class:** landing/chooser for the voice corpus. **Status:** authoritative for
> *orientation only* — it decides nothing. **Last verified:** 2026-09-17
> (master `38b70e6`).
>
> Voice Mode has accumulated roughly twenty-five documents across three weeks, at
> different levels of completion: shipped behaviour, target architecture, lab
> design, execution ledgers, validation evidence, agreed designs and archived
> history. Some are current, some are superseded, and **one verdict is
> deliberately disproven**. This file says which is which, what each is for, and
> what the lab actually established.
>
> **Open this first. Update it whenever a voice document is added, promoted or
> retired.**
>
> **It never overrides a canonical document.** Where this file and
> [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) or
> [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
> disagree, they win. Per [`DOCS-GOVERNANCE.md`](./DOCS-GOVERNANCE.md), code and
> emitted capability metadata outrank documentation.

---

## 1. Read these three, in this order

| # | Document | What it gives you |
|---|---|---|
| 1 | [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) | **What Voice Mode is, and what ships today.** The intent, the nine non-negotiables, the shipped two-lane cascade behaviour, the renewed *thinking-together* intent, and the one known live defect (the confirmation gate). |
| 2 | [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md) | **What was decided, and how to build it.** The architecture of record (owner decisions D1–D7), **§2 the evidence audit of the lab**, and §7 the sequenced build plan with a per-step gate. |
| 3 | [`DRIVE-MODE.md`](./DRIVE-MODE.md) | **The shipped UI the voice feature speaks through** — overlay, layout modes, lanes, switching workers, and what is never spoken. |

Changing code? Also read [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) §Voice Mode and
[`OBSERVABILITY.md`](./OBSERVABILITY.md) §Voice Mode. Diagnosing a symptom? Start
at [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

---

## 2. The one thing to know about the lab

**The lab's harness is real; its measured results are not.**

The native-voice lab was built and tested phase by phase (L0–L8). It did **not**
produce scored conversational results. Specifically:

- the only committed run manifest is a **Tier-3 dry run** —
  `usage.mode: "dry-run"`, `realProviderCalls: 0`, and the fake Live model, fake
  Internal API and fake child sessions all declared `false`;
- the measured matrices in the benchmark plan are recorded as **pending**;
- the published leaderboard figures trace to **no data file or manifest** — they
  appear only in the site's `index.html`;
- the "measured" runner streams a **sine wave** (60 ms per word) with a silent
  mechanical voice, so a run through it measures nothing about comprehension;
- the headline latency figure is **not** operator-facing TTFA. It is labelled
  `speechToFirstTranscriptMs` / `inputFinalisationTimingMs`; the lab spec §20.2
  defines TTFA as *speech-end → first played audio*. The two are different
  measurement points and must not be quoted interchangeably.

The **engineering record is honest** — `PLAN.md` marks every unrun matrix
*pending*, every Tier-2 rule *unresolved*, and states that an unmeasured test is
never silently treated as the finding did not fire. The failure is confined to the
**reporting and sign-off layer** above it. Owner decision **D1** corrects the
record by annotating rather than erasing, which is why the historical documents
below still carry their original wording alongside a correction banner.

**Do not cite any lab completion figure.** Read the audit in
[`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
§2 before using any number from the lab.

---

## 3. Document map

**Vintage** is the last commit that substantively changed the file, so you can
tell what is newer than what.

### 3.1 Canonical — current behaviour and settled direction

| Document | Class | Vintage | Read it when |
|---|---|---|---|
| [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) | Canonical intent + shipped behaviour | 2026-09-17 `38b70e6` | Always — it is the *what* and the *why*, and the source of the non-negotiables N1–N9. |
| [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md) | Canonical architecture of record (D1–D7) | 2026-09-17 `38b70e6` | Before building or judging any native-voice work — the *how*, plus the evidence audit and the build sequence. |
| [`DRIVE-MODE.md`](./DRIVE-MODE.md) | Canonical shipped-UI doc | 2026-09-16 `edfa28f` | Working on the overlay, lanes, layout modes or worker switching. |
| [`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md) | Canonical measurement-tool doc | 2026-09-17 `578e621` | Making claims about **rendered audio** (eaten first words, vanishing chunks, ducking vs stopping). Note the host caveat: `doctor` reports 18/19 here because the private PulseAudio capture lane cannot start, so the OS-output oracle is *indeterminate* on this machine. |
| [`OBSERVABILITY.md`](./OBSERVABILITY.md) §Voice Mode | Canonical reference, voice records | 2026-09-17 | Reading or changing voice telemetry: `voiceTurnId`, gate outcomes, counters, client speech events. |

### 3.2 Design inputs and the current execution plan

| Document | Class | Vintage | Read it when |
|---|---|---|---|
| [`VOICE-MODE-EXECUTION-PLAN.md`](./VOICE-MODE-EXECUTION-PLAN.md) | Execution plan (current, owner-approved) | 2026-09-17 `cd2f876` | You are **building** the migration. It operationalises the recommendation's §7 sequence into four concurrency workstreams (A–D) with anti-early-claim gates. Where it and the recommendation differ on sequencing, the recommendation governs the decision and this governs execution. |
| [`VOICE-MODE-EXECUTION-LEDGER.md`](./VOICE-MODE-EXECUTION-LEDGER.md) | Conductor's live execution ledger — strategy + checkpoint + progression | live | You are executing or resuming the plan: child routing, wave sequence, ownership/worktrees, zero-token waiting protocol, gate verification and the running progression/decision logs. Current state, not a completion claim. |
| [`VOICE-AGENT-PRICING-RESEARCH-2026-09.md`](./VOICE-AGENT-PRICING-RESEARCH-2026-09.md) | Research record (with §8 Gemini-launch and §9 gap-analysis addenda) | 2026-09-17 `578e621` | You need the cost basis for the voice seat, or the "what is Voice Mode missing" gap analysis. It is a research record, not a plan; treat its arithmetic as scenarios, not bills. |
| [`VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md) | Lab specification (intent record + lab design + execution runbook), **partly superseded** | 2026-09-17 `578e621` | You need the **tier definitions, scoring families, or §20.2 latency definitions** — still citable and cited elsewhere. Part I is now *intent history* (canonical intent is the intent file), and the tier question it exists to decide is **closed**. |
| [`TALKER-MODEL-REQUIREMENTS.md`](./TALKER-MODEL-REQUIREMENTS.md) | Role brief, **premise superseded** | 2026-09-11 `f4937c1` | You want the historical account of how the original relay seat was specified, benchmarked and chosen. Its "no tools, no reasoning burden" premise and its small-model hypothesis are **no longer current** — see the banner in the file and `VOICE-MODE-INTENT.md` §17 and §24. |

### 3.3 Lab execution — delivered equipment, and the corrected record

| Document | Class | Vintage | Read it when |
|---|---|---|---|
| [`VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](./VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md) | Execution plan, **delivered** | 2026-09-17 `ff61b07` | You need the record of how the lab was executed, including its historical model routes, child-runtime policy and thinking levels. Not current instruction. |
| [`VOICE-GEMINI-LIVE-STATUS-LEDGER.md`](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md) | Execution ledger, **history** | 2026-09-17 `c9c0bd5` | You need the phase-by-phase dispatch and verification trail. Its "COMPLETE & SIGNED OFF" status is corrected in place. |
| [`VOICE-GEMINI-LIVE-DECISION-MEMO.md`](./VOICE-GEMINI-LIVE-DECISION-MEMO.md) | Verdict memo, **superseded / deliberately disproven** | 2026-09-17 `c9c0bd5` | You need to see what was claimed and why it is not supported. **Never cite it as evidence.** The evidence audit is in the architecture doc §2. |
| [`VOICE-LIVE-MODEL-EVALUATION-LAB-ARCHITECTURE.md`](./VOICE-LIVE-MODEL-EVALUATION-LAB-ARCHITECTURE.md) | Principles note, **superseded as the build spec** | 2026-09-17 `578e621` | You want the design principles and evidence levels — the adapter contract, the measurement families, and "human-free execution is possible; human preference is not thereby measured". Not the lab's shape or status. |

### 3.4 Programme plans in `docs/plans/`

Plans are history: they record authority and evidence, and per
[`DOCS-GOVERNANCE.md`](./DOCS-GOVERNANCE.md) they must never override shipped
schema or canonical docs.

| Document | Vintage | Status | Read it when |
|---|---|---|---|
| [`plans/VOICE-TALKER-FULL-SESSION-BRIEF.md`](./plans/VOICE-TALKER-FULL-SESSION-BRIEF.md) | 2026-09-18 | Implemented, **live-validated** | You are changing how much worker session the live talker holds: it records the measured cliff (~82k tokens free, ~100k dead), the 200k-character ceiling, the delta rule and the read-only retrieval fallback. Policy of record is `server/src/voice/worker-brief.ts`. |
| [`plans/VOICE-LIVE-WIRE-CONTRACT.md`](./plans/VOICE-LIVE-WIRE-CONTRACT.md) | 2026-09-17 | **Frozen v1 contract** | You are building or consuming the native-voice wire surface (transport, envelope, message catalogue, audio framing, server service boundary). The normative types are `shared/src/types/voice-messages.ts`; a breaking change is v2 alongside, never an in-place edit. |
| [`plans/DRIVE-MODE-TWO-LANE-PLAN.md`](./plans/DRIVE-MODE-TWO-LANE-PLAN.md) | 2026-09-17 | Programme plan, **complete** | You need the original two-lane programme: its intent table I1–I18 and the mechanical/instructed layering. |
| [`plans/VOICE-MODE-DESKTOP-LANES-AND-SESSION-VIEW-PLAN.md`](./plans/VOICE-MODE-DESKTOP-LANES-AND-SESSION-VIEW-PLAN.md) | 2026-09-16 | **Implemented & validated** | You are working on the desktop pane or lane layout. |
| [`plans/VOICE-READING-AND-QA-DESIGN.md`](./plans/VOICE-READING-AND-QA-DESIGN.md) | 2026-09-14 | Agreed design, **implemented** | You are changing reading levels or the focus/recap behaviour. |
| [`plans/VOICE-MODE-OBSERVABILITY-DESIGN.md`](./plans/VOICE-MODE-OBSERVABILITY-DESIGN.md) | 2026-09-13 | Agreed design, **implemented** | You need the reasoning behind the voice record vocabulary. The **authoritative field list** is `VOICE-MODE-INTENT.md` §12 plus `OBSERVABILITY.md` §Voice Mode, not this file. |
| [`plans/REAL-BROWSER-AUDIO-REGRESSION-LAB-PLAN.md`](./plans/REAL-BROWSER-AUDIO-REGRESSION-LAB-PLAN.md) | 2026-09-14 | Plan, **executed** | You need the execution history of the audio lab. The canonical description is [`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md). |
| [`plans/VOICE-MODE-VALIDATION-RESULTS.md`](./plans/VOICE-MODE-VALIDATION-RESULTS.md) | 2026-09-13 | Validation evidence, **history** | You need the P6 live-validation acceptance evidence for the shipped harness, including its honest findings and stated gaps. |
| [`plans/VOICE-MODE-BROWSER-E2E-RESULTS.md`](./plans/VOICE-MODE-BROWSER-E2E-RESULTS.md) | 2026-09-13 | Validation evidence, **history** | You need the P9 real-browser E2E record — including the integration defect it found, which was fixed afterwards (`ed3ea2f`). |
| [`plans/VOICE-HARNESS-EXECUTION-STATE.md`](./plans/VOICE-HARNESS-EXECUTION-STATE.md) | 2026-09-13 | Execution log, **history** | You need H-series execution detail: the two-copies-of-`pi-ai` trap, the R1/R2 event-loop stall evidence, the H8 secrets audit. Its former "read this first" instruction is **withdrawn**. |
| [`plans/VOICE-MODE-CONTINUATION.md`](./plans/VOICE-MODE-CONTINUATION.md) | 2026-09-14 | Handover brief, **history** | You need the 2026-09-14 state snapshot. Superseded; do not read as current state. |

### 3.5 Archived intent (history — never cite as normative)

The three documents that previously held Voice Mode's intent between them were
**combined in full** into [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) and
archived verbatim for provenance. See [`archive/INDEX.md`](./archive/INDEX.md)
for the one-line-per-file record, and
[`archive/briefs/`](./archive/INDEX.md) for the 38 execution briefs (E1, H1–H8,
P1–P27, R1–R2) of the completed voice programmes.

---

## 4. Superseded and disproven — do not act on these

| Do not act on | Because | Act on this instead |
|---|---|---|
| [`VOICE-GEMINI-LIVE-DECISION-MEMO.md`](./VOICE-GEMINI-LIVE-DECISION-MEMO.md) — "Tier 1 is the decisive winner", "zero leaks across 140 attempts" | The runs were never performed; the tier question is closed by decision, not by that measurement. | [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md) §2 and §8 |
| [`VOICE-GEMINI-LIVE-STATUS-LEDGER.md`](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md) — "COMPLETE & SIGNED OFF" | Its own definition of done requires the scored runs, which were not run. | The architecture doc §2 |
| The published leaderboard site figures (`140 attempts`, `1,840 ms`, `270 ms`) | They appear only in the site's `index.html`; no data file or manifest contains them. | The architecture doc §2.2 |
| [`TALKER-MODEL-REQUIREMENTS.md`](./TALKER-MODEL-REQUIREMENTS.md) — "no tools", "no reasoning burden", "small model" | Replaced by the provenance rule and the standard native-audio seat (D3, D6). | [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) §17, §24 |
| [`plans/VOICE-HARNESS-EXECUTION-STATE.md`](./plans/VOICE-HARNESS-EXECUTION-STATE.md) and [`plans/VOICE-MODE-CONTINUATION.md`](./plans/VOICE-MODE-CONTINUATION.md) — "read this first" | They pin production at contract 1.42.0; the surface has moved on. | [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) |
| The 210-attempt synthetic campaign (as described in earlier revisions of the architecture doc) | Replaced by a lean deterministic regression suite plus real-ear dogfooding (D4, revised). | The architecture doc §7 and §7.1 |
| The archived [`archive/VOICE-MODE.md`](./archive/VOICE-MODE.md), [`archive/VOICE-ORCHESTRATOR-FEASIBILITY.md`](./archive/VOICE-ORCHESTRATOR-FEASIBILITY.md), [`archive/VOICE-MODE-INTENT-RESEARCH-2026-09.md`](./archive/VOICE-MODE-INTENT-RESEARCH-2026-09.md) | Consolidated into the intent file. | [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) |

---

## 5. Lab, measurement and evidence assets

| Asset | Where | What it is |
|---|---|---|
| Native-voice lab harness | `scripts/voice-live-lab/` (index: [`README.md`](../scripts/voice-live-lab/README.md)) | The L0–L8 equipment: scheduler, fixtures, paced speech driver, playback, record/verify, providers, tier harnesses, adaptive operator, fidelity corpus. |
| Phase handoffs | [`L0`](../scripts/voice-live-lab/L0-HANDOFF.md), [`L2`](../scripts/voice-live-lab/L2-HANDOFF.md), [`L4`](../scripts/voice-live-lab/L4-HANDOFF.md), [`L5`](../scripts/voice-live-lab/L5-HANDOFF.md), [`L6`](../scripts/voice-live-lab/L6-HANDOFF.md), [`L7`](../scripts/voice-live-lab/L7-HANDOFF.md) | Per-phase delivery records with their own gaps and limitations. |
| Lab tests | `server/tests/voice-live-lab/` (19 files) | Regression tests for the harness, including deliberately damaged-trace verification. |
| Rendered-audio lab | `scripts/audio-lab/` | Measures the audio a real browser actually renders, via a private null sink and an independent monitor. Host caveat in [`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md). |
| Benchmark packaging & published site | `/root/agent-benchmarks/benchmarks/04-voice-live-lab/` (**sibling repository**) | `PLAN.md` (honest, matrices marked pending), `generate_reports.mjs`, `report.json`/`report.html`, `run_voice_lab.sh`, `runs/` (gitignored), `site/`. Decision **D1** corrected its verdict layer on 2026-09-17: the report is now compiled from run manifests and fails closed, and the published figures are marked withdrawn. The site's source is corrected; **republishing it is a separate, owner-gated act.** |
| Operations evidence | `operations/voice-card-20260915/`, `operations/voice-desktop-20260916/`, `operations/voice-relay-20260916/` | Per-workstream briefs, parent verification, harnesses, logs and screenshots for the card-identity, desktop and relay-robustness work. |

---

## 6. Where the code lives

| Concern | Path |
|---|---|
| Talker harness (policy, gate, drafts, delivery, digest, observability) | `server/src/talker/` — start with `policy-core.ts` (pure decision core, extracted in L3) and `talker.ts`. |
| Voice transport | `websocket/connection.ts` (`talker_turn`, `talker_turn_result`, `talker_digest`) and `client/src/lib/talkerBus.ts`. |
| Client voice surface | `client/src/components/DriveMode/` — `DriveModeDictate.tsx`, `useVoiceTurn.ts`, `useAnswerReader.ts`, `voiceLayout.ts`, `LaneStrip.tsx`, `DriveModeSessionPane.tsx`. |
| Speech scheduling | `client/src/lib/speechArbiter.ts` (playback only — it never holds capture authority), `voiceFloor.ts`, `speechTelemetry.ts`, `spokenLedger.ts`. |
| Talker prompt | `scripts/talker-prompts/` (the harness prompt is a prompt concern only; the load-bearing rules are in code). |

---

## 7. Open items and current state

- **The confirmation-gate defect is live and unfixed.** A word such as the one
  inside *"not sure"* still matches the confirmation pattern and can release a
  pending draft, so an operator expressing doubt can dispatch a held instruction.
  It breaks N3. Authorised for immediate repair (D2); the repair is **Step 1** of
  the architecture doc's sequence and is independent of the migration.
- **No measures lab results exist** (see §2). The lean deterministic regression
  suite (Step 4) is the replacement for the synthetic campaign.
- **Ambient operation is deferred to a mobile client** (D7) and is not a later
  phase of the web UI; the standing price of keeping it open is a **client-neutral
  kernel**.
- Product questions still open are listed in `VOICE-MODE-INTENT.md` §25.

---

## 8. Keeping this file true

1. **Adding a voice document?** Add a row with its class, vintage and a
   *read-it-when* sentence. Put canonical documents in §3.1–§3.2, history in
   §3.4–§3.5, and anything a reader must not act on in §4.
2. **Superseding something?** Add the banner to the old document (annotate, do
   not erase) and move its row into §4 with the successor named.
3. **Finding a correction that is still outstanding?** Record it in §7 rather
   than leaving it implicit.
4. **Naming:** new documents should use `VOICE-<CLASS>-<YYYY-MM>.md` with the
   class made explicit (`INTENT`, `ARCH`, `LAB-SPEC`, `LAB-RESULTS`, `PLAN`). Do
   not add further files under the retired `VOICE-GEMINI-LIVE-` prefix, which
   described a lab phase rather than a subject.
5. **Checks:** `npm run docs:check-links` resolves every link here, and
   `npm run docs:check-status` enforces rules 1–3 mechanically across the corpus
   (a marker in every active voice document, and a successor link wherever a
   document says it is superseded). The link is only as good as this file's
   upkeep.
