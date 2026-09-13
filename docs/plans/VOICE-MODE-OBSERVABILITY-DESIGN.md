# Voice Mode observability — design

**Status:** designed 2026-09-13 for execution. Parent (conductor) authored; a child
implements. Supersedes nothing.

## Why

The operator is about to start **testing Voice Mode by ear and by voice**. When
something looks or sounds wrong, the question will be *"what actually happened in
the backend?"* — and today the answer is spread across a talker that returns rich
structured results nobody records, a delivery adapter whose outcome is reported but
not correlated, and a client speech scheduler whose decisions are invisible to
everyone but the browser console.

The aim: **an agent, or the operator, can reconstruct exactly what happened in one
voice interaction without reproducing it** — what was said, what the talker decided
and why, whether the gate held, what was relayed and by which mechanism, whether the
worker received it, and why something was or was not spoken aloud.

## The governing principle — extend, do not fork

`docs/OBSERVABILITY.md` already defines the doctrine. **Read it first.** Voice Mode
observability must ride it:

- **One central logger** (`server/src/logging/logger.ts`, `createLogger('…')`). No
  `console.*` in `server/src/**` — it is an ESLint **error**, and that is deliberate.
- **The diagnostics ring buffer** (`internal-api/diagnostics-buffer.ts`) already
  captures log records, **scrubs them for secrets before entry**, and is bounded
  with the retained-bytes invariant we property-tested in `c2ce523`. Emit into it by
  logging; do not add a second store.
- **Correlation is how an agent reconstructs a story** — `requestId` for the
  originating request, `runId` for durable turn identity. Voice needs its own key.
- **Metrics** go through `server/src/observability/operational-metrics.ts`.
- Retrieval goes through the existing Internal API diagnostics/evidence surface.

**Do not** invent a parallel telemetry channel, a second buffer, or a new log file.

## D1 — A voice turn record (the core artefact)

Every operator turn through the talker emits **one structured log record** at
`info` from a `VoiceMode` (or `Talker`) logger, carrying a stable correlation key so
one utterance's whole journey is reconstructable.

**The correlation key:** `voiceTurnId` — a monotonic per-talker-session counter
(e.g. `${workerSessionId}:${turnIndex}`), plus the existing `sessionId`/`runId`
where available. Every record in a turn's lifecycle carries it.

**Fields the record must carry** (omit a field rather than inventing a value —
"unknown" must never be silently rendered as a plausible default):

| Field | Meaning |
|---|---|
| `voiceTurnId`, `workerSessionId`, `turnIndex` | identity |
| `utteranceClass`, `classifierReason` | what the classifier called it and why |
| `utteranceChars`, `utteranceExcerpt` | bounded excerpt (≤120 chars) — this is the operator's own words, and seeing them is the point |
| `draftSizeBefore`, `draftSizeAfter`, `draftAction` | accumulated / superseded / cleared / none |
| `phase` | `answered` \| `proposed` \| `released` \| `refused` \| `cancelled` \| `error` |
| `gatePending` | was anything releasable at decision time |
| `releasedUtteranceId`, `releasedBytes`, `releaseMechanism` | what a confirmation actually released |
| `deliveryOutcome`, `deliveryDisclosure`, `deliveryError` | delivered / queued / refused, and why |
| `modelCalled`, `modelLatencyMs`, `modelTtftMs`, `outputChars` | the model path (and that it was **skipped** when it was) |
| `receiptAckEmitted` | whether the receipt ack fired this turn |
| `durationMs` | total turn wall time |

**Bounded, always.** The diagnostics buffer is size-limited; keep records small.
Never log the whole draft or the whole reply.

## D2 — Relay provenance (the safety-critical one)

When a release happens, emit a **second, explicitly-correlated record** carrying:

- the released text's **byte length and a hash or exact excerpt**, and
- the **delivery adapter's own reported outcome/mechanism**, and
- the **worker session** it went to.

This is what lets an agent answer *"did the operator's exact words reach the worker,
and by what mechanism?"* without reading raw JSONL. A gate refusal emits the
corresponding record too, with the **reason** (`nothing pending`, `lapsed`,
`ambiguous`, `cancel-classified`).

## D3 — Metrics

Add to `operational-metrics.ts` (follow the existing registration pattern):

- `voice_turn_total{phase}` — turns by outcome
- `voice_release_total{mechanism,outcome}` — relays by mechanism and result
- `voice_gate_denied_total{reason}` — refusals, which should be *common and healthy*
- `voice_receipt_ack_total` — acks emitted
- `voice_turn_duration_ms`, `voice_model_latency_ms` — latency
- `voice_delivery_latency_ms{mechanism}` — adapter call → worker transcript visible

Gate denials are not errors. A rising `voice_gate_denied_total` with a flat
`voice_release_total` is the *correct* shape when an operator is thinking aloud.

## D4 — Client speech telemetry (the "why didn't I hear it?" half)

The speech arbiter's decisions are currently invisible outside the browser. At
minimum, record **client-side speech events**: intent submitted (tier), **dropped
because a higher tier was active**, ducked/restored (barge-in), and playback
failures — recoverable through the **existing browser diagnostic bundle**
(`docs/OBSERVABILITY.md` § "Manual browser diagnostic bundle").

Do **not** add a WebSocket message or server route for this unless you can show the
existing bundle or diagnostics path genuinely cannot carry it — and if you do,
justify it in your report. A new wire message is a parent decision.

## D5 — One retrieval path, documented

An agent asked *"why did Voice Mode do X?"* must have **one** documented path. Add a
Voice Mode section to `docs/OBSERVABILITY.md` (and a pointer from
`docs/TROUBLESHOOTING.md`'s evidence ladder) that gives:

- how to enumerate voice turns in a session (the exact query),
- how to follow one `voiceTurnId` end to end,
- what the healthy shapes look like, and
- the three or four common failure signatures with what each means.

If a small derived endpoint (e.g. a voice timeline for a session) would materially
help an agent, propose it — but the raw correlated records come first, and the
doctrine prefers queryable records over a bespoke view.

## D6 — Error codes

New voice-specific failure modes get **existing-registry** error codes with hints
(`server/src/internal-api/error-codes.ts`), consistent with the current style. Do not
invent a parallel code space.

## Verification (this is the part that must be real)

1. **TDD** for the record shape and correlation: a turn produces the expected fields;
   a refusal carries its reason; a release carries bytes and mechanism.
2. **Live proof on a disposable server**: hold a short voice conversation through
   the talker (the P1/`ws-validate` path is fine), then **retrieve the trace for that
   conversation through the documented path** and quote the records. An agent must be
   able to do this from the docs alone.
3. **Prove the gate signature**: show a refusal record and a release record from the
   same session, so the healthy shape is demonstrated, not just described.
4. **Prove the scrubber still applies**: a record must not carry a secret; confirm the
   existing scrubbing applies to the new fields (the buffer scrubs on entry — verify
   rather than assume).

## Non-goals

- No new dashboards, no external telemetry, no vendor instrumentation.
- No change to the gate, the release path, or the talker's behaviour. **This package
  observes; it does not alter.** If observing requires changing behaviour, stop and
  report.
- Not a replacement for the existing validation suites.
- No full utterance or reply bodies in logs.

## Owned paths

`server/src/talker/**`, `server/src/observability/**`,
`server/src/internal-api/routes/diagnostics.ts` (only if a query filter is genuinely
needed), `client/src/lib/speechArbiter.ts` + the client diagnostics bundle wiring,
`docs/OBSERVABILITY.md`, `docs/TROUBLESHOOTING.md`, and tests.

## Off-limits

- **Production.** Disposable servers only.
- The release gate's semantics (`release()` private, `takeForRelease` atomic).
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — evidence record.
- Adding secrets or full utterance bodies to any log.
