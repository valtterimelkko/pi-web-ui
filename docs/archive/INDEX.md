# Documentation archive index

One line per archived file: what it was, the outcome, and what superseded it
(where applicable). Archived files stay link-checked by `npm run docs:check-links`;
they are history, not current behaviour — never cite an archive file as normative.

> **Class:** history. **Moved:** 2026-09-14 (Phase 2 documentation de-bloat).

## Root of this archive (`docs/archive/`)

- [`KIMI-CODE-RUNTIME-INTEGRATION-DESIGN.md`](./KIMI-CODE-RUNTIME-INTEGRATION-DESIGN.md) — proposed Kimi Code sixth-runtime design (1,443 lines). Kimi runtime retired 2026-09-09; never implemented. Superseded by: nothing — the runtime no longer exists.
- [`PI-CODEX-COMPACTION-SESSION-ID.md`](./PI-CODEX-COMPACTION-SESSION-ID.md) — the Codex compaction session-ID patch ecosystem. RETIRED after OpenAI fixed the Codex backend server-side (upstream #6477/#6555); postinstall patch and auto-heal probe removed.

### Voice Mode intent corpus — consolidated 2026-09-17

The three files below held Voice Mode's intent and current-behaviour description
between them. They were **combined in full** into one canonical document,
[`docs/VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md), which is now the single
source of intent. Each is kept verbatim for provenance — operator quotations,
commit trails and the original framing — and each carries an archived banner
pointing at its successor.

- [`VOICE-MODE.md`](./VOICE-MODE.md) — was the canonical feature doc for the shipped two-lane harness (architecture table, mechanical gate, speech policy, reading levels, mobile durability, observability vocabulary). Superseded by: [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md) **Part II**, which absorbs it in full.
- [`VOICE-ORCHESTRATOR-FEASIBILITY.md`](./VOICE-ORCHESTRATOR-FEASIBILITY.md) — the frozen original intent (2026-09-10) plus the two-axes relay/worker-role correction (2026-09-12); the ChatGPT Voice anti-goals; the ruled-out Gemini Spark MCP route; the motivating Antigravity run `3099ab72`. Superseded by: [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md) **Part I and §23**.
- [`VOICE-MODE-INTENT-RESEARCH-2026-09.md`](./VOICE-MODE-INTENT-RESEARCH-2026-09.md) — two weeks of fixes read as intent: the nine non-negotiables N1–N9, the H/P/D-series defect history with commits and operator reports, the fluency spec, open items. Superseded by: [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md) **Parts I and IV**.

## `observations/` — resolved defect observations and completed briefs

- [`2026-09-04-SDK-QUERY-LOOP-ABORT-OBSERVATION.md`](./observations/2026-09-04-SDK-QUERY-LOOP-ABORT-OBSERVATION.md) — SDK 0.3.x `query()` abort investigation. Resolved same day: caller-side signature misuse, pi-web-ui unaffected. See the paired verdict.
- [`2026-09-04-SDK-QUERY-LOOP-ABORT-VERDICT.md`](./observations/2026-09-04-SDK-QUERY-LOOP-ABORT-VERDICT.md) — verdict + fix sequence for the observation above; owner-approved and executed 2026-09-04.
- [`ADMISSION-CAPACITY-BOTTLENECK-OBSERVATION.md`](./observations/ADMISSION-CAPACITY-BOTTLENECK-OBSERVATION.md) — admission/capacity bottleneck observation. RESOLVED 2026-09-11 via [`docs/plans/INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md`](../plans/INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md).
- [`H3-TALKER-RETEST-RESULTS.md`](./observations/H3-TALKER-RETEST-RESULTS.md) — transient parent-facing retest results for the talker model choice (H3). Programme closed; current behaviour lives in [`docs/VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md).
- [`WATCH-DEFECT-RESTART-BRIEF.md`](./observations/WATCH-DEFECT-RESTART-BRIEF.md) — completed work brief for the watch-defect / restart recovery effort. Delivered; current watch semantics live in [`docs/INTERNAL-API-ORCHESTRATION.md`](../INTERNAL-API-ORCHESTRATION.md) and [`docs/LONG-HORIZON-VALIDATION.md`](../LONG-HORIZON-VALIDATION.md).

## `plans/`

Reserved for completed/superseded plans moved out of `docs/plans/`. Empty at
archive creation (2026-09-14); the Phase 2 scope moved only the voice briefs and
resolved observations.

## `briefs/` — voice-programme execution briefs (E1…R2, P1…P19)

Per-work-package dispatch briefs for the Voice Mode / Drive Mode two-lane
programme. Every work package they describe is complete and merged; the durable
record of what shipped is [`docs/VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md),
[`docs/RECENT-CHANGES.md`](../RECENT-CHANGES.md), and git history. The briefs are
kept verbatim for provenance: E1 (mobile socket durability), H1–H8 (harness, input
routing, model retest, long session, provider guard, server integration, transport
binding, secrets migration), P1–P19 (transport, receipt ack, operator draft,
speech arbiter, Voice Mode UI, validation, CI, E2E, observability, state view,
relay fix, error visibility, ratchet headroom, stop talker, speech dedup, reading
levels, QA/focus, whole-turn digest), R1–R2 (event-loop stall investigation and
fixes).
