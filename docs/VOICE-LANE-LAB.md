# Voice Lane Lab

> **Class:** canonical measurement-tool doc. **Status:** current. **Last verified:** 2026-09-18. **Corpus:** Voice
> Mode — see [`VOICE-MODE-INDEX.md`](./VOICE-MODE-INDEX.md).

A small lab that measures **what a live native voice lane's audio did**: the model speech a real server sent a real
lane, and the schedule the SHIPPED client scheduler produced for it. It exists because the operator reported that the
talker's voice "starts talking on top of each other … several sentences at the same time … I can't really understand
what it's saying", and neither the server's observability (`voice-kernel` records turns, briefs, receipts and capture
faults — nothing about the audio's shape) nor the audio regression lab (whose capture chain cannot start on this host:
`doctor` → `capture:chain` FAIL) could see it.

Root cause found with it, and fixed: see
[`operations/voice-live-20260917/evidence/lane-overlap-20260918/README.md`](../operations/voice-live-20260917/evidence/lane-overlap-20260918/README.md)
— the client played roughly half of every answer because the provider delivers at **4.14× real time** and the
scheduler was written for a 1× stream.

## Quickstart

```bash
cd /root/pi-web-ui

# What can this host do? (and what it deliberately does not)
npx vite-node scripts/voice-lane-lab/cli.ts doctor

# Capture one real lane end to end: disposable server + real Gemini Live + real spoken question.
# Needs GEMINI_API_KEY. Writes to /root/voice-lane-lab/run-A (outside Git).
npx vite-node scripts/voice-lane-lab/cli.ts run --out /root/voice-lane-lab/run-A

# Re-analyse a recorded capture, offline and deterministically (no server, no provider).
# This replays the SHIPPED scheduler over the SAME chunks: a before/after of the code on identical input.
npx vite-node scripts/voice-lane-lab/cli.ts analyse /root/voice-lane-lab/run-A

# The same capture, in a REAL browser's audio graph: the dev-lab page mounts the real
# VoiceLiveSurface on a real AudioContext, and the page's audio sources are instrumented.
# Needs the lab's own Vite config serving the dev page (NOT part of the production bundle).
npx vite --config client/voice-live-lab.vite.config.ts --port 5273 --strictPort &
npx vite-node scripts/voice-lane-lab/cli.ts browser \
  --capture <captureDir> --url http://127.0.0.1:5273/client/voice-live-lab.html
```

Exit codes: **0** clean, **1** a defect was demonstrated, **2** no proof (refused, or the capture was incomplete).

> `vite-node`, not `tsx`: the measurement deliberately imports the SHIPPED client scheduler, which reaches
> `import.meta.env` through the client's diagnostics module. `vite-node` supplies it; plain `tsx` cannot load it, and
> stubbing that module would mean measuring something other than the product.

## What it measures, and what it cannot

| Layer | Source |
|---|---|
| **Server** | every `voice_audio_chunk` a real lane received — arrival time, `seq`, declared duration, mime type, decoded samples, payload sha256 |
| **Client schedule** | the SHIPPED `PlaybackPipeline` (`client/src/lib/voiceLive/playbackSession.ts`) driven through a recording backend, in real arrival time, so the real arithmetic produced the schedule |
| **Client schedule, in a browser** (`browser`) | the same scheduler on a REAL `AudioContext` via the dev-lab page, with every `AudioBufferSourceNode.start` recorded — the schedule is graded from the AUDIO-CLOCK time it was booked for, never from when the JS call happened |
| **Page** | AudioContexts created, mounted lane surfaces, and distinct lane ids — the only things that can produce two output chains for one lane |

The oracle is deterministic and has teeth in the audio regression lab's sense: a clean control must pass, and every
injected defect must fail **for the intended reason** (`server/tests/voice-lane-lab/oracle.test.ts`).

Findings, worst first (the operator's symptom is first):

| Code | What it means |
|---|---|
| `chunk_overlap` | two booked sources play at the same time — the operator's "on top of each other" |
| `duplicate_audio` | the same payload delivered twice: the same words from two sources |
| `stranded_audio` | audio accepted and never booked: speech the operator never hears |
| `dropped_audio` | audio the scheduler refused or dropped from the middle of an answer |
| `seq_not_contiguous` | the server's own sequence has a gap or a repeat |
| `declared_duration_mismatch` | what a sample-rate disagreement between server and client looks like |
| `second_audio_context` / `second_lane_surface` / `second_lane` | a second output chain for one lane |

**Limitations, stated rather than folded into a pass:**

- It measures the product's **own schedule**, not OS-rendered audio. An overlap in the schedule is an overlap in
  reality — Web Audio starts a booked source when it was booked — but a device-level dropout, a Bluetooth route or a
  different machine's speakers are outside this lane. The audio regression lab
  ([`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md)) is the OS-output lane; its `capture:chain` fails on this
  host, and that is why this sibling exists.
- The page-level findings are only as good as the run. A protocol-level capture reports `audioContexts: 0` and
  `mountedLaneSurfaces: 0`, which means **not measured** — never "clean". The `browser` command supplies them from a
  real Web Audio graph, but it has only been run against the lab's own dev page replaying a captured lane, never
  against the operator's live page; production page facts therefore still come from the lane inventory and the
  component test that pins the one-chain invariant.
- It never touches production: a disposable server outside the production cgroup, its own state dir, token and socket.

## Evidence and privacy

A capture directory holds `chunks.json` (per-chunk metadata and digests), `frames.ndjson` (every inbound frame, audio
payloads redacted to their length), `transcripts.json`, `measurement.json` and `audio/chunk-NNNN.pcm` (the decoded
model speech). Runs are written outside Git (`/root/voice-lane-lab`); nothing here is uploaded, and no operator
utterance text or credential is recorded.

**Deliberate deviation from the audio lab's convention.** `AUDIO-REGRESSION-LAB.md` keeps raw audio **outside** Git.
This lab commits the decoded model speech for a record when the capture is small (single-digit MB), because it is the
only way the record can be **re-analysed offline** — `analyse <dir>` replays the shipped scheduler over the same bytes
and reproduces the published verdict. The audio is the MODEL's own speech answering a normalised question on a
disposable server: no operator recording, no credentials, no session content. Where a capture is large, only the
metadata, measurements and arrival shape are committed, and the record says so.

## Related documents

- [`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md) — the OS-rendered-output lab this one is a sibling of
- [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) — the speech feature, N1–N9 (N5 duck-never-stop is preserved here)
- [`plans/VOICE-LIVE-WIRE-CONTRACT.md`](./plans/VOICE-LIVE-WIRE-CONTRACT.md) — §5.2 pacing and buffers
- [`VOICE-MODE-EXECUTION-LEDGER.md`](./VOICE-MODE-EXECUTION-LEDGER.md) — the live progression log
