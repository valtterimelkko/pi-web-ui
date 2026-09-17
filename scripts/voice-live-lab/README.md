# Voice Live Lab — Phase L0 Equipment

> **Scope:** L0 only (measuring equipment). The lab itself is specified in
> [`docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](../../docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)
> (Parts II–III) and sequenced in
> [`docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](../../docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md).
> This directory owns `scripts/voice-live-lab/**`; its tests live in
> `server/tests/voice-live-lab/**`. Run records and audio are written outside
> the repository and never committed.

L0 proves the measuring equipment before any API key is spent. Every module is
tested against deliberately damaged traces; a clean control trace must pass and
each injected defect must fail for the intended reason.

## Modules

| File | Responsibility |
|---|---|
| `lib/scheduler.ts` | Monotonic clock (`process.hrtime.bigint()`), append-only JSONL event log (`{seq,tMs,source,kind,id,causedBy?,mediaOffsetMs?,payload}`), independent async pumps (`createPump`, `createPumpSet`). |
| `lib/fixtures.ts` | Offline Supertonic synthesis → 24 kHz master → 16 kHz s16le PCM; SHA-256 freezing; independent Whisper ASR gate (WER ≤ 0.08 and required words present). |
| `lib/speech-driver.ts` | Paced 16 kHz s16le PCM streaming (640-byte / 20 ms frames) in an **E** explicit-boundary lane or an **N** natural-endpointing lane. |
| `lib/playback.ts` | In-process 24 kHz reference player; **duck** profile (gain 0.15 while the operator holds the floor, barge-in does not cancel) and **native-interrupt** profile (flush on barge-in); exact received/rendered/discarded accounting. |
| `lib/record.ts` | Immutable attempt records (`runs/<runId>/<condition>/<attemptId>/…`) and the offline verifier. |
| `lib/providers/fake-live.ts` | Scripted `serverContent` replay (audio parts, transcripts, turnComplete, interrupted, usageMetadata) for hermetic tests. |
| `cli.ts` | `verify <attemptDir>` — the offline trust boundary. |
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
# Run the L0 unit tests
cd server && npx vitest run tests/voice-live-lab/

# Verify a finalised attempt record
npx tsx scripts/voice-live-lab/cli.ts verify /path/to/attempt-01
npx tsx scripts/voice-live-lab/cli.ts verify /path/to/attempt-01 --json

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
