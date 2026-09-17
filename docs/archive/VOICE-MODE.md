# Voice Mode

> **ARCHIVED 2026-09-17.** This file is history, not current behaviour. Its
> normative content was absorbed **in full** into Part II of
> [`docs/VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md), which is now the
> canonical intent and current-behaviour document. Cite that file instead.
> Kept verbatim below for provenance.

> **Class:** canonical feature doc. **Status:** current behaviour (two-lane harness shipped 2026-09-12…14; reading levels 2026-09-14).
> The programme's plan history and per-package briefs live in `docs/plans/` and `docs/archive/briefs/`; this file is the only normative description of the feature.

Voice Mode lets you **converse with an agent by voice while it works**. It grew out of Drive Mode (the distraction-reduced overlay — see [`DRIVE-MODE.md`](../DRIVE-MODE.md), which describes the overlay UI this feature speaks through).

## The two lanes

- **Lane 1 — the talker.** A server-side conversational harness (`server/src/talker/`) that holds the spoken conversation: it answers, acks, holds your draft, and relays instructions. It never does work itself.
- **Lane 2 — the work lane.** The ordinary worker session, untouched. Voice Mode adds no worker behaviour; it only routes your spoken instructions into it through a confirmation gate.

One talker instance serves one worker session. The talker's model is chosen separately from the worker (see [`TALKER-MODEL-REQUIREMENTS.md`](../TALKER-MODEL-REQUIREMENTS.md)).

## Architecture

| Piece | Where | Role |
|---|---|---|
| Talker harness | `server/src/talker/talker.ts` | Per-turn loop: classify utterance → release/refuse/converse (header comment documents the ten invariants) |
| Utterance classifier | `server/src/talker/utterance-classifier.ts` | Mechanical confirmation/cancel/ordinal classification — **model output is never an input** |
| Draft store | `server/src/talker/pending-proposal.ts` | The accumulating verbatim draft (statements and worker-directed questions); ageing expires the *confirmation*, never the draft |
| Session registry | `server/src/talker/session-registry.ts` | One talker per worker session; the single server-side entry point |
| Digest | `server/src/talker/digest.ts` | Reading-level digests (summary / headlines) produced in the talker's reading path |
| Delivery adapters | `server/src/talker/delivery.ts` | Per-runtime relay: Pi mid-run steer via the existing path; Claude SDK steer/follow-up (non-SDK backends **refuse**, never silently degrade); Antigravity follow-up queueing (a first-class outcome, not an error) |
| Transport binding | `server/src/websocket/connection.ts` (`talker_turn`, `talker_turn_result`, `talker_digest`) + `client/src/lib/talkerBus.ts` | Browser ⇄ talker over the existing session WebSocket; every UI relay delivers |
| Worker relay | `server/src/talker/ask-worker.ts` | Ask-the-worker offer handling on the talker path |
| Client surface | `client/src/components/DriveMode/DriveModeDictate.tsx`, `useVoiceTurn.ts`, `client/src/lib/voiceFloor.ts`, `speechArbiter.ts`, `speechTelemetry.ts` | Voice UI states, capture, playback scheduling |

### The mechanical gate (non-negotiable)

The relay of an instruction to the worker is gated by **code, not instructions to the model**:

1. The talker model has **no send path**. The only code that can hand text to the worker runs solely when (a) a pending proposal holds the operator's verbatim utterance and (b) the operator's new utterance mechanically classifies as a confirmation.
2. The relay text is **always the operator's own words**, referenced by id from the verbatim log. The model decides whether and when to ask; it never composes what is sent.
3. Acknowledgements are fixed strings produced by the harness **after** the delivery outcome is known — honest delivery/queue/refusal wording, and the talker never claims the worker finished.
4. Never widen the gate's reachability. If work appears to require that, the design is wrong, not the transport.

## Speech policy (client speech arbiter)

`client/src/lib/speechArbiter.ts` schedules playback; it has **no capture authority** — capture of what you say is unconditional, only playback is scheduled. The anti-duet rule is a strict priority ladder:

1. **You speaking is never interrupted.** Already-playing audio **ducks** (volume lowers, never hard-stops); new intents wait; chatter is dropped.
2. **Receipt ack (tier 2)** — an unacknowledged utterance gets one short fixed acknowledgement ("Noted — still holding that."), spoken before anything else.
3. **Worker answer (tier 3)** — speaks at the next natural gap.
4. **Talker chatter (tier 4)** — lowest; dropped, not queued, when it cannot play immediately.

Chunked TTS is what makes barge-in clean: boundaries are the only scheduling points, ducking replaces stopping, and pause/resume/level-changes happen at chunk boundaries — speech never resumes mid-word. **Stop talker** is a playback control only: it silences the current chunk and discards the queue, and nothing heard after it is a suppression of capture — what arrived is surfaced explicitly.

## Reading levels

The operator chooses how much of the worker's output is spoken; the level is persisted, visibly indicated, and changeable **mid-answer** (the current item stops at the next chunk boundary, the unplayed remainder is re-digested, what was already heard never repeats, and the change is announced).

| Level | What speaks |
|---|---|
| **Verbatim** | The worker's raw output. |
| **Summary** | A talker-produced spoken prose digest. Short turns (≤ ~400 characters of speech) still speak verbatim. Announced with "In short:". |
| **Headlines** | One line: **"Done: X. Needs you: Y."** — a different *extraction*, not a shorter summary; designed to be left on permanently. |

## Mobile socket durability & recovery

A dictated/spoken prompt must never be lost on a mobile browser:

- **Reconnect on resume:** on `visibilitychange → visible`, `online`, and window `focus`, a closed socket reconnects immediately and the attempt budget resets — a frozen tab can no longer exhaust the budget while suspended.
- **Never drop a send:** when the socket is down, outbound messages queue and flush **in order** after reconnect (after session re-subscription, so the server accepts them).
- **Surface failures:** a send that cannot be queued or delivered reaches the operator visibly, and a failed voice send restores the text (never a silent `console.error`).

## Observability & telemetry

The full retrieval runbook (exact `voiceTurnId` queries, healthy record shapes, failure signatures, client-error reports) lives in [`OBSERVABILITY.md`](../OBSERVABILITY.md) §Voice Mode — one ring, no second buffer. The record vocabulary:

**`voiceTurnId`** = `runtime:workerSessionId:turnIndex`. Every operator turn emits one `voice turn` record; a release or gate refusal adds a same-id companion record. Fields (omit rather than invent — absent means unknown):

| Field | Meaning |
|---|---|
| `voiceTurnId`, `workerSessionId`, `turnIndex` | identity (`sessionId` is deliberately absent — the voice path runs outside the request-correlation context) |
| `utteranceClass`, `utteranceChars`, `utteranceExcerpt` | class, size, and a ≤120-char excerpt of the operator's words (scrubbed on entry) |
| `draftAction`, `draftSizeBefore`, `draftSizeAfter` | accumulated / superseded / cleared / none |
| `phase` | `answered` \| `proposed` \| `released` \| `refused` \| `cancelled` \| `error` |
| `gatePending` | was anything releasable at decision time |
| `releasedUtteranceId`, `releasedBytes`, `releasedSha256`, `releasedExcerpt` | what a confirmation actually released (verify against the worker transcript; full text is never logged) |
| `releaseMechanism` (`steer`/`prompt`/`follow_up`), `deliveryOutcome` (`delivered`/`queued`/`refused`), `deliveryDisclosure`, `deliveryError` | the delivery adapter's own verdict |
| `gateDenialReason` | `nothing_pending` \| `lapsed` \| `ambiguous` \| `cancel_classified` — refusals are **healthy**, not errors |
| `modelCalled`, `modelTtftMs`, `modelLatencyMs`, `outputChars` | the model path (and that it was skipped when it was) |
| `receiptAckEmitted` | whether the receipt ack fired this turn |
| `durationMs` | total turn wall time |

Counters in `GET /api/v1/diagnostics` → `.operational.voice`: `turnTotal{phase}`, `releaseTotal{"mechanism:outcome"}`, `gateDeniedTotal{reason}`, `receiptAckTotal`, plus `turnDuration` / `modelLatency` / per-mechanism `deliveryLatency` snapshots. Client-side speech decisions (submit/drop/barge-in/playback) ride the browser diagnostic ring as `kind: "speech"` events; client voice-surface crashes are uploaded as `ClientVoice` records into the same server ring.

## Where to change what

- Talker behaviour, gate, classification → `server/src/talker/*` (TDD mandatory: the operator-pushback turn is a required test).
- Speech scheduling → `client/src/lib/speechArbiter.ts` (never add capture authority).
- Delivery semantics per runtime → `server/src/talker/delivery.ts`.
- Voice observability fields → `server/src/talker/observability.ts`, then update this table **and** `OBSERVABILITY.md` §Voice Mode in the same change.

## Measuring what was actually heard

"The first words were eaten", "a chunk vanished", "it stopped instead of ducking"
are claims about **rendered audio**, and nothing above can confirm or refute
them: server logs describe scheduling, and a transcript describes text. The
[`AUDIO-REGRESSION-LAB.md`](../AUDIO-REGRESSION-LAB.md) measures the OS-level
output of a real Chrome running these exact modules — real `useReadAloud` and
`speechArbiter`, a private PulseAudio null sink, and an independent `parec`
monitor — and reports head/tail loss, omissions, duplications, reordering,
join gaps and gain behaviour against frozen tolerances.

Run it before changing anything in the speech path, and again afterwards:

```bash
npx tsx scripts/audio-lab/cli.ts run
```

A green lab result is evidence about the **render**, not proof that a user's
laptop is fine; read its limitations section before quoting a pass.
