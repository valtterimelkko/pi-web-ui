# Audio regression lab

A reusable, unattended lab that measures **the audio a real browser actually
renders** for Pi Web UI's speech features. It exists to make "the first words
were eaten", "chunk 4 vanished", "it ducked instead of stopping" and
"playback after a long pause was garbled" into measurable, retained evidence
rather than a listening impression.

> **What a pass means, and what it does not.** A pass means: in this run, on
> this host, in this Chrome build, the OS-rendered output of a dedicated
> virtual sink contained the source speech with no measured head/tail loss,
> omission, duplication, reordering, unintended gap or gain loss above the
> frozen tolerances. It **cannot** certify a headset, a Bluetooth route, a
> different operating system or a different browser build, and it does not
> claim phoneme-level fidelity. It is a measurement capability, not a promise
> that any particular laptop defect is fixed.

## Quickstart

```bash
cd /root/pi-web-ui-wt-audio-lab        # isolated worktree
npm ci                                  # needs Node >= 22.19, Chrome, Xvfb, PulseAudio, FFmpeg

# 1. Does this host actually support the lab?
npx tsx scripts/audio-lab/cli.ts doctor

# 2. Build the speech fixture corpus (real MP3 speech; no credentials needed)
npx tsx scripts/audio-lab/cli.ts fixtures --provider local

# 3. Run the required scenario matrix
npx tsx scripts/audio-lab/cli.ts run

# 4. Re-check the record offline (no browser, no audio daemon, no network)
npx tsx scripts/audio-lab/cli.ts verify-record <attempt-dir>

# 5. Regenerate the HTML report for any finalised attempt
npx tsx scripts/audio-lab/cli.ts report <attempt-dir>
```

`doctor` exits non-zero when the host cannot run the lab, and says exactly
which dependency is missing. `run` exits **0** only when every required
scenario passed, **1** on a demonstrated regression, and **2** when proof is
missing or invalid (a mixed fail/indeterminate result can never be green).

## What it actually measures

```
real Chrome (private Xvfb display)
  -> the REAL product player + arbiter (AudioContext -> GainNode -> destination)
  -> a PRIVATE PulseAudio null sink
  -> an independent `parec` monitor process
  -> raw PCM -> FFmpeg remux -> the oracle
```

Three independent layers are correlated on a shared monotonic timeline:

| Layer | Where it comes from |
|---|---|
| **Source** | The exact MP3 bytes the player received, per request, hashed. Not "the text we hoped it would say". |
| **Application** | The product's own arbiter state changes and its own `browserDiagnostics` speech ring (`submit`, `drop`, `floor_held`, `playback_failed`, …), each stamped with `performance.now()`. |
| **Browser output** | Continuous PCM of the null sink's monitor, recorded by a separate `parec` process that has no relationship to Chrome or the product. |

The oracle is deterministic: RMS envelope for coarse alignment, **sample-domain
correlation** for candidate scoring, monotonic sequence alignment (dynamic
programming) for ordering, content-onset comparison for head/tail loss,
source-aware gap classification, and a 90th-percentile gain reference.

### Why those specific choices

- **Envelope-only scoring is not enough.** The envelope of any two spoken
  sentences is a similar pattern of bursts and pauses. An early version scored
  a *removed* chunk at 0.98 against a neighbour, so "omitted chunk", "reorder"
  and "truncated recording" all passed on damaged audio. Candidates are
  re-scored on the sample waveform.
- **Ordering needs sequence alignment, not greedy matching.** With repeated
  identical text, the n-th identical chunk must map to the n-th occurrence.
  Greedy per-chunk search marks repeats as misordered.
- **Head/tail loss must be content-based.** A fixed probe window that lands on
  an inter-word pause correlates with nothing, which reported ~175 ms of
  phantom head loss on perfectly clean speech.
- **The gain reference must be the loud part.** Normalising against the median
  let a defect that attenuated most of a reading move the reference down with
  it, so it looked normal.
- **Alignment is derived from audio, never timestamps.** A skewed clock cannot
  turn a broken render into a passing one.

## Frozen tolerances

Recorded in every manifest (`oracleTolerances`) and versioned by
`ORACLE_TOLERANCE_VERSION`. Changing any number requires new RED evidence.

| Measure | Tolerance | Rationale |
|---|---|---|
| Head/tail content loss | fail at ≥ 100 ms | the smallest loss a listener reliably reports as an eaten word |
| Chunk join gap, p95 | ≤ 100 ms | with one-ahead priming the next chunk is already decoded; a join should not need a synthesis round trip |
| Inserted gap detection | 250 ms+ reported | distinguishes a scheduling stall from natural phrasing |
| Sustained gain loss | ratio < 0.5 of the loud reference, or unrecovered | intentional ducking measures ≈ 0.15 |
| Chunk present | sample-domain correlation ≥ 0.6 | measured: identical audio ≈ 1.0; different sentences well below |
| Recorder rate mismatch | hard fail | a harness bug must never be scored as a product defect |

Sensitivity is not asserted, it is **demonstrated**: the adversarial matrix in
`server/tests/audio-lab/oracle.test.ts` requires the oracle to fail each
injected defect — 120 ms head loss, 120 ms tail loss, an omitted chunk, a
duplicated chunk, reordered chunks, a 400 ms inserted gap, sustained gain loss,
a wrong declared sample rate, a truncated recording and digital silence — and
requires clean controls (44.1 kHz round trip, bounded noise, ±10 ms boundary
jitter, natural pauses, repeated identical text) to keep passing.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | check binaries, private daemon start, real capture, bundle, fixtures, disk |
| `fixtures [--provider local\|endpoint]` | build/verify the speech corpus |
| `run [--scenario id,…] [--root dir] [--label id]` | run the matrix, write an immutable record |
| `app [--env-file <file>]` | authenticated compiled-app lane: real login + real `/api/tts` (see below) |
| `soak [--minutes N \| --repeat N] [--scenario id]` | repeat runs or a long-horizon soak; samples disk per pass |
| `verify-record <attempt-dir>` | offline re-verification of hashes and verdict consistency |
| `report <attempt-dir>` | regenerate the self-contained HTML report |
| `import <recording> [--text "…"] [--times "…"]` | analyse an operator recording |
| `build-bundle` | build the lab product-player page |

### Fixture providers

- `local` (default) — Supertonic CPU synthesis, encoded to MP3 by FFmpeg. No
  credentials and no network, so a fresh checkout runs unattended. This is
  diagnostic speech.
- `endpoint` — the **real production `/api/tts` path** on a disposable server,
  using the same model the product uses. Reports mark this corpus as
  `productionTtsPath: true`. `doctor` reports the production-TTS gate as unmet
  until such a corpus exists.

Fixtures are cached outside Git, keyed by a hash over provider + voice + the
exact texts, and every entry is hash-verified on reuse, so a changed sentence
can never silently reuse a stale recording.

## The scenario matrix

One registry (`scripts/audio-lab/lib/scenarios.ts`); add scenarios there rather
than as new scripts. Each scenario declares whether it is required, runs its
own negative control in its own capture, and drives the real product modules.

## Reading a failed app-lane run — the lab working, not broken

The app lane's job is to find what instant-fixture lanes cannot. First real
run (app‑2026‑09‑14T18‑00‑25‑195Z): with the REAL `/api/tts` backend, the
read played `chunk-00, chunk-01, [5.5 s hole], chunk-03, chunk-02, chunk-04,
chunk-05` — one chunk arrived seconds late and audibly AFTER its successor
(waveform-scored at 0.995 at 15.8 s, while its slot sat silent from 7.3 s).
That is exactly the “words were eaten / came late” class the lab was built to
measure, on the real transport, with immutable evidence. **An app-lane exit 1
with evidence like this is a finding to triage in the product player (one-ahead
priming under slow synthesis), not a lab defect** — reproduce with
`cli.ts app --label app-repro`, then root-cause in `useReadAloud`/
`speechArbiter` with TDD before any behavioural change.

## The authenticated app lane (`app`)

The product-player lane serves cached fixture bytes, so it deliberately does
not exercise transport or auth. The `app` command covers exactly those:

- boots the **real compiled server** through the repo's disposable validation
  launcher (isolated state dir, a throwaway bcrypt password minted per boot —
  never the production secret; only `OPENAI_API_KEY` is imported from an
  explicit env file by the launcher's allowlist);
- **denial control first**: a no-cookie `POST /api/tts` against that server
  must be refused, or the lane refuses to run;
- logs in over HTTP exactly as the browser does and drives the real product
  player with the cookie attached, forwarding every `/api/tts` request to the
  live endpoint;
- the oracle's source of truth is the **bytes actually served in that run**
  (dumped per request under the attempt's `source/`), not an earlier
  synthesis, so non-deterministic TTS cannot fake or break the comparison.

Credentials stay outside the repo (see `SECURITY.md`): the env file is
referenced by path at runtime only, `verify.sh` unsets credential variables,
and evidence/audio never enters Git. Known honest gap: the reading-level-change
scenario is recorded `not_run` until a Drive-Mode harness exists — the app
lane exits 2 (missing proof), never green, while that gap stands.

| ID | What it proves |
|---|---|
| `start-cold` | a cold context and first real gesture still produce a complete first sentence |
| `idle-resume` | playback after a ≥30 s gap still produces the first words |
| `chunk-joins` | 20+ chunk starts, ordered coverage, head/tail and join-gap distribution |
| `speed` | the existing 1.25× path keeps content coverage |
| `stop-cancel` | an explicit stop is accounted for honestly: a cancelled read is *not* a complete read |
| `pause-boundary` | pause/resume at an allowed boundary loses and duplicates nothing |
| `priority-dedup` | repeated identical text is heard once per repeat, in order |
| `slow-error-tts` | a transient synthesis failure is absorbed by the player's single retry |
| `tts-terminal-failure` | a terminal failure is surfaced and bounded, and nothing is reported as speech that was not heard |
| `visibility` | a background/foreground transition does not drop a chunk |
| `barge-duck` | the operator floor ducks rather than hard-stopping, and restores |

### Authoring a new scenario

1. Add a `Scenario` object to `lib/scenarios.ts` with a stable `id`, a
   `corpus` index and an honest `required` flag.
2. Drive the page through `context.page.evaluate` against `window.__labProduct`
   (the real product API exposed by `browser/lab-main.tsx`).
3. Return `assertions(measurement)` — assert what *should* be true, including
   the negative side (a duck is not a stop; a cancellation is not a completion).
4. Add the sentence(s) to `DIAGNOSTIC_CORPUS` in `lib/fixtures.ts` and rebuild
   fixtures. The runner verifies the corpus against the **real** product
   chunker and fails loudly on a mismatch, so the lab can never describe a
   sequence the product does not play.

## Diagnosing a failure

The generated report ends with the same ladder:

1. **Source absent from the recording entirely** — all chunks missing and the
   recording silent. Synthesis or scheduling never produced audio. Check
   `events/tts-requests.json` and each scenario's `productTelemetry`.
2. **Source present, chunk missing from the recording** — the audio was
   fetched but not rendered or was muted. Look for `drop`/`playback_failed`.
3. **Chunk present but head/tail loss above tolerance** — the render started
   late or was cut short. Compare `start-cold` and `idle-resume`.
4. **Everything present in the lab but the operator still hears loss on their
   laptop** — an environment discrepancy. The lab has **not** reproduced it.
   Import the operator recording (`import`) and compare.

## Evidence and privacy

Every attempt writes an immutable directory: `manifest.json` (+ its own
`MANIFEST.sha256`), per-scenario JSON, raw PCM and remuxed WAV captures, TTS
request logs, product telemetry, screenshots, anomaly clips, and an offline
`report.html`.

- Records are **finalised once**; retries use a new `attempt-NN` directory and a
  failed attempt is never deleted or overwritten.
- `verify-record` recomputes every hash and **re-derives each scenario status
  from its own assertions**, so a self-reported "passed" cannot survive a
  tampered record.
- Raw audio, browser profiles, screenshots and credentials stay **outside Git**.
- Operator recordings are read-only originals; analysis runs on a private copy
  and nothing is uploaded. Without expected text or timing, attribution is
  reported as **UNKNOWN** — the lab does not invent alignment certainty.

## Safety boundaries

The lab runs entirely inside its own capsule: a private X display, a private
PulseAudio daemon with its own socket and null sinks, a private Chrome profile,
and an ephemeral static server on loopback. It never touches the host desktop,
the shared audio daemon, the production service, host routing, or Authelia.

Process teardown is **identity-verified**: children are tracked by PID *and*
`/proc` start time, and the process group is torn down by enumerating `/proc`
rather than by pattern matching. There is no `pkill -f` anywhere — during this
lab's development such a pattern matched its own invoking shell. After teardown
the capsule re-enumerates its identities and listeners and reports any residual
as a failure of the run, so a leak cannot be mistaken for a clean pass.

## Limitations (also recorded per-run in the manifest)

- The capture is a virtual null sink's monitor, not a physical speaker.
- The product-player lane supplies the words; it is not proof of what a model
  chose to say. The authenticated full-application lane is separate.
- Microphone capture in the product lane uses a synthetic audio device: it
  exercises the browser capture machinery, but is not microphone-hardware
  proof.
- One heavy runner at a time; the lab is not a load/stress harness.
- No external browser, residential proxy or remote publication is used or
  needed. A public HTTPS lane is deliberately out of scope for core delivery.

## Related documents

- [`VOICE-MODE.md`](./VOICE-MODE.md) — the speech feature and its invariants
- [`DRIVE-MODE.md`](./DRIVE-MODE.md) — the two-lane driving surface
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — the runtime validation suite this lab complements
- [`../SECURITY.md`](../SECURITY.md) — auth, isolation and evidence-handling rules
- [`../tests/README.md`](../tests/README.md) — test lifecycle and proof semantics
