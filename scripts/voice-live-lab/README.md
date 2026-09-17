# Voice Live Lab — Phase L0 Equipment + L2 Baseline Lane

> **Scope:** L0 (measuring equipment) and L2 (baseline lane: Gemma cascade
> provider, tier-1 scenarios, scorer). The lab itself is specified in
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
measure a native Gemini Live candidate measure the baseline too. Every module
is tested against deliberately damaged traces; a clean control trace must pass
and each injected defect must fail for the intended reason.

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
| `cli.ts` | `verify <attemptDir>` — the offline trust boundary; `handshake` — the L1 probes; `baseline-dryrun` — hermetic L2 attempts. |
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
# Run the lab unit tests (L0 + L2)
cd server && npx vitest run tests/voice-live-lab/

# Verify a finalised attempt record
npx tsx scripts/voice-live-lab/cli.ts verify /path/to/attempt-01
npx tsx scripts/voice-live-lab/cli.ts verify /path/to/attempt-01 --json

# Hermetic baseline dry run (no provider called)
npx tsx scripts/voice-live-lab/cli.ts baseline-dryrun \
  --scenario /root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/t1-s1-orchestration-voice.json \
  --attempts 1

# Score attempts (benchmark side)
python3 /root/agent-benchmarks/benchmarks/04-voice-live-lab/score_voice.py /path/to/runs/<runId>
```

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
