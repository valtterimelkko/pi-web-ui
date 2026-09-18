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

`chunks.json` + `audio/` are the capture itself (every model-speech chunk with its arrival time, digest and
samples), so this evidence **re-runs offline**: `npx vite-node scripts/voice-lane-lab/cli.ts analyse
operations/voice-live-20260917/evidence/lane-overlap-20260918`.

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

### The comparison is controlled, not two different harnesses

The "before" figure above was first taken with the lab's earlier revision. It was re-taken with the CURRENT harness —
real-time replay, same capture, same arrival times — with only the drain disabled, which is the single variable:

| same harness, same capture | chunks scheduled | booked | stranded | dropped |
|---|---|---|---|---|
| drain disabled (pre-fix behaviour) | 48 | 4 170 ms | 4 600 ms | 0 |
| the shipped fix | **99** | **8 770 ms** | **0 ms** | **0** |

So the before/after is the scheduling change alone, not a change of instrument.

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

### Verified in a REAL browser, too

Everything above is the shipped scheduler driven from Node. The fix's only environment-dependent parts are that
`AudioContext.currentTime` advances with the audio clock and that the drain's timers actually fire — so the lab also
replays the same capture through the dev-lab page (`client/voice-live-lab.html`, NOT in the production bundle), which
mounts the REAL `VoiceLiveSurface` on a REAL Web Audio graph, with the page's own audio sources instrumented:

```
npx vite --config client/voice-live-lab.vite.config.ts --port 5273 --strictPort &
npx vite-node scripts/voice-lane-lab/cli.ts browser \
  --capture operations/voice-live-20260917/evidence/lane-overlap-20260918 \
  --url http://127.0.0.1:5273/client/voice-live-lab.html
```

Measured in Chromium, same capture, same arrival pacing, the drain the only variable
(`browser-mutation-drain-disabled.json` vs `browser-measurement.json`):

| in a real browser | chunks scheduled | booked | stranded | overlap | AudioContexts |
|---|---|---|---|---|---|
| drain disabled (pre-fix behaviour) | 53 | 4 610 ms | **4 160 ms** | 0 ms | 1 |
| the shipped fix | **99** | **8 770 ms** | **0 ms** | **0 ms** | **1** |

That also answers the one question a Node-side harness cannot: **the page created exactly ONE AudioContext**, so
there was no second output chain in the graph.

> Probe bug worth recording: the first version of this check plotted overlaps from the wall-clock moment `start()` was
> called instead of the audio-clock time it was booked for, and so reported a 91 ms "overlap" on a perfectly correct
> one-ahead schedule. The schedule is graded from `when`; a measurement that invents a defect is worse than no
> measurement.

## 5. Was there a SECOND playback chain? Production evidence: no

The one mechanism a single scheduler cannot produce is a second output chain (two AudioContexts / two mounted lane
surfaces / two tabs): each mounted lane surface owns its own AudioContext and its own pipeline, so two of them would
play the same model audio twice — which is literally "on top of each other".

`lane-inventory.txt` answers it from the journal. A lane id is `<workerSessionId>:vl-<index>-<per-page nonce>`, so a
second lane on one page would appear as **index 2 for the same nonce**, and a second tab as a second nonce with its
own `clientId`:

- **every lane the server has ever seen is index 1** (30 lane-event lines over 7 days, one index value);
- today's five lanes each carry a **distinct `clientId`** and each was **detached before the next appeared** — the
  operator's 14:34 and 16:34 lanes are `:vl-1-zze18jkx` and `:vl-1-9fhlzwha`, different page loads a hour apart.

So the symptom was **one page, one lane, one playback chain** — the chain this lab measured. The other mechanism is
not merely unmeasured now: it is ruled out for the reported period. `client/src/components/DriveMode/DriveModeDictate.native-lane.test.tsx`
pins the invariant at the code level (a non-addressed lane in multi-lane Drive Mode mounts no lane; a page holds
exactly one frameBus registration) so it cannot regress.

## 6. What is still not proven

- **OS-rendered audio.** The audio regression lab's capture chain cannot start on this host (`doctor` →
  `capture:chain` FAIL), so this lab measures what the product schedules and what the server sends, not what the
  speaker emitted. An overlap in the schedule is an overlap in reality (Web Audio starts a booked source when it was
  booked); a device-level dropout is outside this lane.
- **The operator's ear.** The final acceptance is theirs and cannot be self-certified by any agent. Everything above
  says the audio the client books is complete, contiguous and single-chained; it cannot say how it sounds in the room.
- **A live lane driven through the real app UI in a browser.** The browser run above feeds a capture into the real
  surface on the dev-lab page; it does not click through Drive Mode and open a lane, so the app-UI path is still
  covered by the component tests and by the operator's own use.

## 7. What a provider interrupt should do (found, not changed)

The captured lane had **no** provider interruption (three `voice_state` events, none of them
`provider interrupted playback`), so this defect did not involve one. It is worth recording that the client's
playback ignores that signal entirely: with the queue now played rather than stranded, an interrupted answer will play
out (ducked) to its end. Whether an interrupt should instead flush the queue is a product decision — the contract's
N5 rule is "duck, never stop" for *operator* speech, and the lab's own reference player has a separate
`native-interrupt` profile that flushes — so it is flagged here rather than changed unilaterally.
