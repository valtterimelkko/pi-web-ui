# Voice Live Lab — Phase L0 Equipment + L2 Baseline Lane + L4 Tier 1 Guarded Harness + L5 Tier 3 Orchestrator

> **Scope:** L0 (measuring equipment), L2 (baseline lane: Gemma cascade
> provider, tier-1 scenarios, scorer), L4 (tier 1 guarded native harness:
> Gemini Live adapter, policy-core-driven gating, commit rule, dry-run
> runner) and L5 (tier 3: the live model as orchestrator over the shortened
> Benchmark 2, with the Internal API tool surface, the host-enforced
> confirmation protocol and session-lifetime handling). The lab itself is
> specified in
> [`docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](../../docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)
> (Parts II–III) and sequenced in
> [`docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](../../docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md).
> This directory owns `scripts/voice-live-lab/**`; its tests live in
> `server/tests/voice-live-lab/**`. Benchmark packaging (scenarios, worlds,
> scorer) lives in `/root/agent-benchmarks/benchmarks/04-voice-live-lab/`.
> Run records and audio are written outside the repository and never committed.

L0 proves the measuring equipment before any API key is spent. L2 drives the
shipped baseline (STT → TalkerSession → TTS) through that equipment as a
`ProviderInputSink`, so the same driver, log, verifier and scorer that will
measure a native Gemini Live candidate measure the baseline too. L4 replaces
the minimum stack for tier 1: the operator's speech reaches a native Gemini
Live session while the PURE policy core (L3's `decideOperatorTurn`) keeps the
relay gate — the model has no send path, and every module is tested against
deliberately damaged traces; a clean control trace must pass and each injected
defect must fail for the intended reason.

## Modules

| File | Responsibility |
|---|---|
| `lib/scheduler.ts` | Monotonic clock (`process.hrtime.bigint()`), append-only JSONL event log (`{seq,tMs,source,kind,id,causedBy?,mediaOffsetMs?,payload}`), independent async pumps (`createPump`, `createPumpSet`). L2 adds the `turn_complete` / `provider_error` / `harness_*` event vocabulary. |
| `lib/fixtures.ts` | Offline Supertonic synthesis → 24 kHz master → 16 kHz s16le PCM; SHA-256 freezing; independent Whisper ASR gate (WER ≤ 0.08 and required words present). |
| `lib/speech-driver.ts` | Paced 16 kHz s16le PCM streaming (640-byte / 20 ms frames) in an **E** explicit-boundary lane or an **N** natural-endpointing lane. |
| `lib/playback.ts` | In-process 24 kHz reference player; **duck** profile (gain 0.15 while the operator holds the floor, barge-in does not cancel) and **native-interrupt** profile (flush on barge-in); exact received/rendered/discarded accounting. |
| `lib/record.ts` | Immutable attempt records (`runs/<runId>/<condition>/<attemptId>/…`) and the offline verifier. |
| `lib/providers/fake-live.ts` | Scripted `serverContent` replay (audio parts, transcripts, turnComplete, interrupted, usageMetadata) for hermetic tests. |
| `lib/providers/baseline-cascade.ts` | **L2.** The shipped cascade in-process: buffers PCM frames, fires on E-lane boundaries / N-lane trailing silence, then STT → `TalkerSession` (policy core gate inside) → TTS → reference player. Logs `provider_content` (transcription + audio parts), `provider_usage`, harness transitions and `turn_complete` per turn; leg failures are named `provider_error` events, never swallowed. Includes the real OpenAI STT (with local-Whisper fallback) and OpenAI TTS adapters. |
| `lib/scenario.ts` | **L2.** `voice-lab.scenario/1` loader/validator: beats (frozen/branching/adaptive), triggers relative to observed output, director permission vocabulary, mechanical `expect` blocks. |
| `lib/worlds.ts` | **L2.** `voice-lab.world/1` loader/validator: initial `WorkerStateSnapshot`, timeline (worker outputs, permission requests, delivery-triggered patches), hidden truth as distinctive golden strings. |
| `lib/baseline-dryrun.ts` | **L2.** Hermetic attempts: scripted STT/TTS + real talker gate drive the full path (driver → cascade → player → immutable record → verify). Manifests are labelled `mode: "dry-run", realProviderCalls: 0`. |
| `lib/providers/gemini-live.ts` | **L4.** The injectable seam to `@google/genai` 1.52.0 `ai.live.connect`: tier-1 connect config (audio modalities, both transcriptions, session resumption, E/N activity detection), the two declared functions (`mark_addressed_to_talker`, `offer_ask_worker` — NON_BLOCKING, acknowledged SILENT), `provider_content`/`provider_usage`/lifecycle events, state-view context updates coalesced ≥ 2 s apart and never mid-speech. Tests and dry runs inject a mock session factory; the real `@google/genai` factory is built only for a measured `tier1-run`. |
| `lib/harness/tier1-guarded.ts` | **L4.** The guarded native harness: `TranscriptCommitTracker` (the §16.3 400 ms stabilisation commit rule as a pure state machine), `Tier1GuardedHarness` executing the L3 policy core exactly as `TalkerSession` does — `release` → recorded `WorkerDelivery`; mechanical decisions → trusted mechanical voice at receipt tier + context update, with native audio queued before the decision discarded under honest player accounting; conversational decisions → the model's own native reply, with the tool calls interpreted through the same `decideAfterModelReply` semantics. `native` and `sidecar` transcript conditions; `buildTier1SystemInstruction` (v3 prompt minus the text-marker lines, plus the function contract and "you never send; the host sends"). |
| `lib/tier1-dryrun.ts` | **L4.** `runTier1DryAttempt`: hermetic guarded-native attempts (scripted live client + scripted shadow ASR + silence mechanical voice + null delivery) across all shipped tier-1 scenarios in both transcript conditions and both lanes. `runTier1MeasuredAttempt` + `createWhisperShadowAsr` + `encodeWav`: the guarded real-run entry for `tier1-run` (refuses without `GEMINI_API_KEY`). |
| `lib/tier3-tools.ts` | **L5.** The tier-3 tool surface (§17.2): the seven declared functions (`create_child`, `prompt_child`, `child_status`, `read_child`, `wait_for`, `run_checked`, `notify_owner`), all `NON_BLOCKING` with `WHEN_IDLE`-scheduled responses; Zod-validated arguments; the `run_checked` allow-list as a pure grammar (no shell metacharacters at all, `git -C` inside the run dir with `log|status|diff` only, `python3 -m unittest` with the run dir as cwd, `bash … ctl.sh restart|health|status`, `cat`/`ls` inside the run dir); the 30 s polling rule; the host-enforced confirmation protocol (a committed `confirm` within 60 s, never the model's claim); the tool ledger; and both the real Unix-socket Internal API client and full hermetic doubles. |
| `lib/harness/tier3-orchestrator.ts` | **L5.** The tier-3 orchestrator: the connect config (`sessionResumption: {}` and `contextWindowCompression` at 100k tokens on EVERY connection), the versioned/hashed ≤600-word system instruction, the operator path (PCM + E-lane markers + the 400 ms commit rule), tool-call dispatch with `WHEN_IDLE` responses, and `goAway` handling — finish in-flight responses, close, reconnect with the last `newHandle`, increment the generation, restore host state from its own ledger, and re-issue (tagged with the original call id) any result that could not go out while the socket was down. |
| `lib/b2-short-driver.ts` | **L5.** The B2-short driver (§17.3): builds the fixture testbed, evaluates the declarative triggers, supplies the scripted children and scripted live model for the hermetic dry run, walks `B2_SHORT_DRY_SCRIPT`, derives a parent transcript from the event log and scores the run with the UNCHANGED Benchmark 2 `score_orchestrator.py`. `runB2ShortMeasuredAttempt` is the real-run entry. |
| `cli.ts` | `verify <attemptDir>` — the offline trust boundary; `handshake` — the L1 probes; `baseline-dryrun` — hermetic L2 attempts; `tier1-dryrun` — hermetic L4 attempts; `tier1-run` — measured L4 attempts (needs `GEMINI_API_KEY`); `tier3-dryrun` — hermetic L5 tier-3 attempts over B2-short; `tier3-run` — measured L5 attempts (needs `GEMINI_API_KEY`, a named socket and operator audio fixtures). |
| `boot-disposable-server.sh` | `systemd-run --scope --collect` boot of an isolated validation server, outside the production cgroup. |

## The L0 verification gate

`verifyAttempt` re-derives mechanical facts from a record without a browser,
provider or network. The required damaged-trace behaviours are covered in
`server/tests/voice-live-lab/record.test.ts`:

- missing usage record → `required event kind missing: provider_usage`
- dropped input frames → `dropped frames: …`
- out-of-order / non-dense sequence → `event sequence is not dense …`
- leaked golden (hidden-truth) text in the trace or `provider/` → `golden text leaked …`

and the clean control passes. Tampering after finalisation is caught by the
manifest/artefact hashes.

## Usage

```bash
# Run the lab unit tests (L0 + L2 + L4)
cd server && npx vitest run tests/voice-live-lab/

# Verify a finalised attempt record
npx tsx scripts/voice-live-lab/cli.ts verify /path/to/attempt-01
npx tsx scripts/voice-live-lab/cli.ts verify /path/to/attempt-01 --json

# Hermetic baseline dry run (no provider called)
npx tsx scripts/voice-live-lab/cli.ts baseline-dryrun \
  --scenario /root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/t1-s1-orchestration-voice.json \
  --attempts 1

# Hermetic GUARDED NATIVE dry run (L4; no provider called, mode: dry-run)
npx tsx scripts/voice-live-lab/cli.ts tier1-dryrun \
  --scenario /root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/t1-s1-orchestration-voice.json \
  --condition native        # or sidecar: the Whisper transcript decides
  # optional: --stability-ms N compresses the §16.3 400 ms commit rule for
  # hermetic runs; the real rule stays 400 ms in measured runs.

# MEASURED tier-1 attempt against the real Gemini Live session (L4; guarded)
GEMINI_API_KEY=... npx tsx scripts/voice-live-lab/cli.ts tier1-run \
  --scenario /root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/t1-s1-orchestration-voice.json \
  --condition native --model gemini-3.8-live
  # respects plan §21: budget, quota and the 07:00–11:00 UK window are the
  # caller's responsibility; the command refuses an empty key.

# Score attempts (benchmark side)
python3 /root/agent-benchmarks/benchmarks/04-voice-live-lab/score_voice.py /path/to/runs/<runId>
```

## Tier 3 — the live model as orchestrator (L5)

Tier 3 has no talker and no relay gate: the live model orchestrates B2-short
itself, and its authority is the **tool allow-list** plus a **confirmation
protocol** the host enforces. See §17 of the intent document, and
`/root/agent-benchmarks/benchmarks/04-voice-live-lab/b2-short/README.md` for the
fixture.

```bash
# Hermetic tier-3 dry run: scripted children + scripted live model, but REAL
# repositories, git history, mock service and run_checked commands.
# Writes an immutable attempt record, verifies it offline, derives a parent
# transcript from the event log and scores it with the unchanged
# score_orchestrator.py.
npx tsx scripts/voice-live-lab/cli.ts tier3-dryrun \
  --runs-root /root/agent-benchmarks/benchmarks/04-voice-live-lab \
  --run-id my-run --attempts 1

# Verify / re-verify the record offline
npx tsx scripts/voice-live-lab/cli.ts verify \
  /root/agent-benchmarks/benchmarks/04-voice-live-lab/runs/my-run/t3/<candidate>/E-orchestrator/<variant>/attempt-01

# MEASURED tier-3 attempt: real Internal API, real Live session, real children.
# Refuses without GEMINI_API_KEY, without an explicit --socket/--token-path
# (never an implicit production socket), and without operator audio fixtures
# (<beats-audio-dir>/<beatId>.pcm) unless --probe-tone labels an equipment
# smoke run. Budget, quota and the GLM peak window stay with the caller (§21).
GEMINI_API_KEY=... npx tsx scripts/voice-live-lab/cli.ts tier3-run \
  --socket <disposable.sock> --token-path <token> \
  --beats-audio-dir /path/to/beats --model gemini-3.8-live
```

What a green `tier3-dryrun` proves: the tool surface, the allow-list, the
polling rule, the confirmation protocol, the orchestrator's `goAway` handling
and host-state restoration, the B2-short fixture and its triggers, the
derived transcript, the immutable record, the offline verifier and the
unchanged Benchmark 2 scorer all agree with each other on real files and real
exit codes. What it does NOT prove: anything about any live model — the record
carries `usage.mode: "dry-run"`, `realProviderCalls: 0` and
`realServices.liveModel: false`.

# Boot / stop an isolated disposable validation server (never production)
VOICE_LAB_DIR=$(mktemp -d /tmp/voice-lab-XXXXXX) \
  bash scripts/voice-live-lab/boot-disposable-server.sh boot
bash scripts/voice-live-lab/boot-disposable-server.sh status
bash scripts/voice-live-lab/boot-disposable-server.sh stop
```

`boot` prints the state dir, log, Internal API socket and token path, and exits
0 only once the socket exists. `status`/`stop` find the state dir via
`/tmp/voice-lab-current` (or `VOICE_LAB_DIR`). The server's own cgroup guard
(exit 78) remains the authoritative safety control.

## In-situ verification (2026-09-17)

- Boot script: server ready after 6 s; `/api/v1/health` over the Internal API
  socket returned **200** with `status: ok`, contract `1.44.0`.
- Isolation: the server process ran in `/system.slice/voice-lab-srv.scope`,
  outside `pi-web-ui.service`; production was never touched.
- Teardown: scope inactive, socket removed, no process remaining, state dir
  deleted.

## Environment notes

- The host's private PulseAudio lane is broken (`audio-lab doctor` reports
  `capture:chain` failing), so OS-rendered proof is `indeterminate` here; the
  reference player is in-process PCM by design.
- Golden fixture text, real audio, keys and run records never enter the
  repository.
