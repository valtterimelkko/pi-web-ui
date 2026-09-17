# L2 Baseline lane — Child A handback

> **Phase:** L2 (Baseline lane — Gemma cascade harness, scenarios, scorer) of the Voice Live Lab.
> **Authoritative spec:** [`docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](../../docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)
> §13 (lab overview), §14.2 (scenario schema), §15.2 (worlds), §16.4 (reading levels), §19 (baseline lane),
> §20.1–20.6 (scoring), §23 (L2 row + gate), §26.4 (Benchmark 4 packaging).
> **Operative plan:** [`docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](../../docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md).
> **Session:** `pi-01a0aed3` (Child A on the Pi runtime).

## Owned paths (single-writer) — nothing else touched

- `scripts/voice-live-lab/**` (pi-web-ui)
- `server/tests/voice-live-lab/**` (pi-web-ui)
- `/root/agent-benchmarks/benchmarks/04-voice-live-lab/**` (new)

`server/src/talker/**` and `server/tests/unit/talker/**` were imported from, never modified.
Both trees were clean at start; both are left **uncommitted** for parent
review/sign-off, matching the L0 handback precedent and the standing
owner gate on new master commits.

## Deliverables

### 1. `lib/providers/baseline-cascade.ts` — the Gemma cascade as a ProviderInputSink

- Buffers 16 kHz s16le PCM frames; fires a turn on the E-lane `activityEnd`,
  N-lane trailing silence (default 900 ms, all-zero frames), a buffer-limit
  guard, or `flush()`.
- Per turn: STT → **the real `TalkerSession`** (policy-core gate inside; the
  cascade adds no decision path) → TTS of what the operator hears → reference
  player `receive()` (with operator-floor duck handoff).
- Event contract per turn, in order: `provider_content` (transcription in,
  reply out, audio parts `{mimeType: 'audio/pcm;rate=24000', audioBytes}`,
  leg timings), `provider_usage` (per-leg metered facts + ms; talker tokens
  are character-based ESTIMATES, labelled), harness transitions
  (`harness_release` / `harness_receipt` / `harness_mechanical`), and
  `turn_complete` last (TTFA, `speechEndAtMs`, draft size + bytes after the
  turn, released bytes, `failedLeg`). One `provider_error` event names the
  failed leg; usage facts gathered before the failure are still recorded.
- Real adapters included: `createOpenAiStt` (gpt-4o-mini-transcribe, local
  Whisper `/asr` fallback), `createWhisperFallbackStt`, `createOpenAiTts`
  (tts-1 / alloy / pcm). All accept an injected `fetchImpl` (unit-tested with
  stubs; no network in tests).
- Mock/stub injection for all three legs (tests use a scripted model client,
  mock STT/TTS, and `createNullDelivery`).

### 2. Scenarios + worlds (`agent-benchmarks/benchmarks/04-voice-live-lab/`)

- Seven tier-1 scenarios (`voice-lab.scenario/1`): five ported 1-beat-per-turn
  from Benchmark 3 (`s1…s5` → `t1-s1…s5`, bench-3 labels carried through),
  plus `t1-s6-worker-permission` (finding D: allow + deny-with-dry-run flows,
  verdicts relayed through the normal gate) and `t1-s7-reading-levels`
  (verbatim/summary/headlines promises, `[[to-talker]]` suppression path,
  stop-talker gesture).
- Seven worlds (`voice-lab.world/1`) with initial snapshots, timelines
  (worker outputs, permission requests, delivery-triggered patches) and
  distinctive hidden-truth golden strings (validator refuses short/common
  strings so leak checks mean something).
- `personas/operator-default.md` (the §14.5 draft, versioned with provenance
  note), `candidate_models.json` (§10.1 route tuples + dated rate card),
  `README.md`, `PLAN.md` (condition matrix actually run).
- TS loaders/validators (`lib/scenario.ts`, `lib/worlds.ts`) pin the fixtures
  from the pi-web-ui side: schema strings, trigger/permission vocabulary,
  relay-needs-confirm-permission, world-event references, golden-vs-spoken
  leakage, unique ids.

### 3. Scorer (`score_voice.py`) + parity suite

- Integrity (dense/monotonic seq, required kinds, golden-leak re-check —
  parity with the L0 verifier), per-turn TTFA (payload + rendered-event
  cross-check) with STT/model/TTS leg splits, per-beat `expect` assertions
  (relay, conversationalOnly, draftCreated, requiredWords, releasedContains,
  ackIsTrusted, forbiddenClaims, answeredFromHistory, permissionAnswered,
  spokenAtReceiptTier), attempt-level unauthorised-release detection,
  usage aggregation and spend from a dated rate card (talker tokens labelled
  as estimates; dry-run spend pinned to 0). Missed beats are
  `not-exercised`, never failed.
- `tests/test_scorer_parity.py`: 12 tests — clean control passes; each
  injected defect (seq gap, missing usage, golden leak, missing relay,
  forbidden claim, missing required words, untrusted ack, unauthorised
  release, missed receipt) fails for the named reason; measured-mode spend
  is positive and bounded.

### 4. Dry-run driver + CLI (`lib/baseline-dryrun.ts`, `cli.ts baseline-dryrun`)

- One command runs N hermetic attempts of a scenario (scripted STT returning
  authored utterances, real TalkerSession + gate + recording delivery,
  silence-mock TTS with real byte accounting), finalises immutable records
  with provenance copies of scenario+world, verifies them, and labels every
  manifest `mode: "dry-run", realProviderCalls: 0`.
- New EVENT kinds in `lib/scheduler.ts` (`turn_complete`, `provider_error`,
  `harness_*`) — additive; L0 tests untouched and green.

## Acceptance gates (all run in this session)

| Gate | Command | Result |
|---|---|---|
| Scoped tests | `cd server && npx vitest run tests/voice-live-lab/` | **PASS — 10 files, 146 assertions, 0 failed** (66 L0 + 80 L2) |
| Scorer parity | `python3 -m pytest tests/ -q` (benchmark 04) | **PASS — 12/12** |
| Typecheck | `npm run typecheck` | **PASS — exit 0** |
| Lint | `npm run lint` | **PASS — exit 0, 0 errors** (318 pre-existing warnings; 0 from this work — the L0 baseline was 313) |
| Build | `npm run build` | **PASS** |
| End-to-end dry run | all 7 scenarios → record → verify → score | **7/7 PASS, exit 0** (turns/releases match every scenario's expectations) |

The end-to-end proof: `baseline-dryrun` across all seven scenarios writes
verifiable records under `runs/` (gitignored), and `score_voice.py` over the
whole run tree exits 0 with every beat passing — the equipment, the
mechanical gate, the records and the scorer agree with each other on real
files.

## Authoring findings recorded (not smoothed over)

- Bench-3's "counts as confirmation" utterances (`Keep going, don't commit.
  That's it.`) classify as **statements** under the shipped mechanical gate:
  they join the draft, and the release lands on the later bare "yes" (s2 b5/b6).
- Bench-3's pushback turn — refused by the bench-3 talker — is, **with a live
  draft**, an authorisation by the shipped contract's own design (s4 b3;
  `talker-gate` pins this). Expectation blocks record both readings in
  `labels`/notes; the scorer asserts the mechanical truth of the stack under test.
- Receipts are one per composition batch (§4.1 rule 2): an append to an
  already-open batch earns no second receipt (s6 b4 note).

## What L2 deliberately does NOT include

- **No live provider calls.** The §23 L2 gate ("5 attempts × 7 scenarios, E
  lane, report renders") spends real cash on OpenAI/OpenRouter by design
  (§19) and is the parent's gated run — the machinery, including the real
  leg adapters, is in place and unit-tested; only the scripted legs are wired
  into the CLI. Provider spend was not authorised for this child.
- The world *driver* (timed events, delivery-triggered patches) is L4
  machinery; L2 ships validated fixtures + validators. Dry-run world-event
  beats fire in causal order after the previous beat.
- Reading-level host reads (Supertonic/digest spoken by the host) land with
  the tier-1 harness; s7 exercises the talker-side contracts.
- N-lane scenarios: all seven ship as E lane (§23 L2 gate); the cascade's N
  lane (trailing-silence boundary) is implemented and unit-tested, ready for
  the L4 lane matrix.

## Commit state — needs the parent

Deliverables in both repos are **uncommitted**. Per the L0 precedent and the
standing owner gate, the parent should review, run the gates and commit a
path-limited change set:

- pi-web-ui: `scripts/voice-live-lab/**`, `server/tests/voice-live-lab/**`
- agent-benchmarks: `benchmarks/04-voice-live-lab/**` (new directory)

## Next actions (for the parent)

1. Review + commit the two change sets; update the status ledger.
2. Decide the live baseline matrix run (§23 L2 gate) — cash spend on
   OpenAI/OpenRouter is deliberate for this lane (§19).
3. Phase L4 (tier 1 guarded harness) is unblocked: it consumes
   `baseline-cascade.ts`'s event contract and the scenario/world fixtures.
