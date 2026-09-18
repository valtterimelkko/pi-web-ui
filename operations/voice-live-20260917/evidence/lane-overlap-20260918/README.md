# Why the talker's voice ran together — measured, root-caused, fixed

**Date:** 2026-09-18 · **Operator report:** *"the talker's voice starts talking on top of each other … it loads several
sentences at the same time … they all kind of go on top of each other and it becomes … I can't really understand what
it's saying."*

**Answer: the client's playback scheduler was built for a stream that arrives at real time. The live lane's audio
arrives at 4.14× real time, so the client played roughly half of every answer and left the rest queued — to reappear
later, on top of whatever was being said by then.**

## 1. What the lane actually delivers (measured, not assumed)

`arrival-shape.txt`, from one real lane captured by the new `scripts/voice-lane-lab` (disposable server, real Gemini
Live session, real synthesised operator speech, model-speech frames only):

| | |
|---|---|
| chunks | 99 (seq 0…98, no gaps, **no duplicate payloads**) |
| arrival span | 2.12 s |
| audio delivered | **8.77 s** |
| delivery rate | **4.14× real time** |
| chunk sizes | 20–100 ms (mostly 100 ms) |
| inter-arrival gap | p50 0 ms, p90 99 ms — bursts of 3–4 chunks |

So the server's stream is clean: one stream, in order, nothing duplicated. The defect is not in what was sent.

## 2. What the shipped client did with it

`before-measurement.json` — the SHIPPED scheduler (`client/src/lib/voiceLive/playbackSession.ts`, driven through a
recording backend so the real arithmetic produced it) over those exact 99 chunks at their exact arrival times:

| | before | after |
|---|---|---|
| chunks scheduled | **48 of 99** | **99 of 99** |
| speech booked | 4 170 ms | **8 770 ms** |
| accepted, never played | **4 500 ms** | **0 ms** |
| chunks dropped | 1 | **0** |
| overlap in the schedule | 0 ms | 0 ms |

**The old client played 4.2 s of a 8.8 s answer and left 4.5 s queued.** Two rules caused it, both written for a 1×
stream:

1. **`pump()` was only called from `pushChunk`.** Booking therefore stopped the moment the horizon filled, and
   nothing re-booked as playback consumed the queue. Whatever was still pending when a burst ended was never booked:
   the lane went quiet mid-answer, and those sentences were played only when a *later* chunk arrived — i.e. inserted
   into a later moment of the conversation, which is exactly "several sentences at the same time, and I can't
   understand it".
2. **The backlog bound was a chunk COUNT (50), silently assuming 20 ms chunks.** Real chunks are 100 ms, so the
   bound was 5 s of speech, not 1 s. On longer answers the bound was exceeded and the OLDEST pending chunk was
   dropped — from the middle of the answer — leaving the survivors concatenated across the gap. Measured on a 30 s
   answer at the same rate: **156 chunks dropped**.

The same probe on a 1× control stream dropped nothing and stranded nothing — which is why this was never caught.

## 3. The fix

`client/src/lib/voiceLive/playbackSession.ts` + `audioConstants.ts`:

- **Drain on the clock, not only on arrival.** When the horizon is full, the pipeline arms a timer for exactly when
  another chunk fits, so a full backlog drains at playback speed and the lane never strands accepted audio. Cancelled
  by `stop()` and `dispose()`, and it backs off rather than spinning if the audio clock is not advancing.
- **Bound the backlog in AUDIO, not in chunks.** `VOICE_PLAYBACK_MAX_PENDING_MS = 60_000`. At the measured rate the
  unplayed surplus of an answer is about 0.75× its duration, so this holds answers up to ~80 s of speech for ~5.8 MB.
  The bound is a memory guard, not a latency policy.

Overflow still drops the **oldest** unplayed chunk and surfaces `playback_overflow`; the utterance is still never
hard-stopped by a duck. §5.2 of the frozen contract is preserved as written — the units and the pump trigger were the
bug, not the rule.

## 4. Teeth

- `client/src/lib/voiceLive/playbackSession.test.ts` — three new tests at the measured shape (9 s of speech in
  100 ms chunks arriving 4× fast), plus the backlog test retargeted to the audio bound. **Mutation-checked:** disabling
  the drain fails 1 test, restoring the old count-equivalent bound fails 2; restored, 18/18 pass.
- `scripts/voice-lane-lab/**` + `server/tests/voice-lane-lab/oracle.test.ts` (14 tests) — the detector: a clean
  control passes and every injected defect fails for the intended reason, including chunks booked on top of each
  other (the operator's symptom), duplicate payloads, stranded audio, drops, sequence breaks, declared-vs-decoded
  duration, a second AudioContext, a second lane surface and a second lane.

## 5. Not proven here

- **A second output chain in the operator's browser** (two AudioContexts, two mounted lane surfaces, or two tabs) is a
  finding this detector can raise but could not be evaluated on a protocol-level capture: `audioContexts`,
  `mountedLaneSurfaces` are reported as 0 by this run, which means "not measured", never "clean". A browser-based
  scenario is the next increment of the lab.
- **OS-rendered audio.** The audio regression lab's capture chain cannot start on this host (`doctor` →
  `capture:chain` FAIL), so this lab measures what the product schedules and what the server sends, not what the
  speaker emitted. An overlap in the schedule is an overlap in reality (Web Audio starts a booked source when it was
  booked); a device-level dropout is outside this lane.
