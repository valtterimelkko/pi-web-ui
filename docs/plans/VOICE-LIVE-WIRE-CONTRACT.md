# Voice Mode — native-voice wire contract, version 1 (FROZEN)

> **Class:** frozen execution artefact — Wave 0 child E of the Voice Mode multi-agent execution.
> **Status:** **FROZEN at v1.** Committed on `feat/voice-contract`. No further edits to the
> semantics of v1 until the conductor reassigns this path; see §1.3 for the change protocol.
> **Date:** 17 September 2026.
>
> **Anchors.** [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md) (the *what* and *why*, N1–N9),
> [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](../VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
> (the *how*, D1–D7), [`VOICE-MODE-EXECUTION-PLAN.md`](../VOICE-MODE-EXECUTION-PLAN.md) Phases 3–5
> (the *when* and *who*).
>
> **Executable half.** [`shared/src/types/voice-messages.ts`](../../shared/src/types/voice-messages.ts) is
> this document's types, catalogue constants, runtime guards and service boundary; the compile-time
> assertions in that file and the tests in
> [`voice-messages.test.ts`](../../shared/src/types/voice-messages.test.ts) fail if the two drift apart.
> The catalogue table in §4 is machine-read by that test — **edit it only with the code**.

---

## 1. Scope, authority and freeze rule

### 1.1 What this contract is

Two independent tracks must meet at Phase 5 without drift:

- **Track B** productises the Gemini Live adapter into `server/src/voice/` — the native session, the
  audio transcode, context injection, resumption.
- **Track C** builds the client surface — AudioWorklet capture/playback, the speech floor and ducking,
  proposal cards, the parking-lot drawer, the trusted delivery chime.

This document is the frozen seam between them: the **transport**, the **message catalogue v1**, the
**audio framing**, and the **server service boundary** Track B implements. It was dispatched before
either track was, so that both can be built against one written contract rather than converging by
conversation.

### 1.2 What this contract is not

It does **not** define the authority kernel's internals (Track A owns `server/src/talker/`: the four
objects, the classifier, the gate, delivery adapters). It does **not** choose the client's DOM, audio-DOM
or tab-lifecycle design. It **does not weaken, widen or reinterpret** N1–N9. Where this contract and the
intent disagree, the intent governs intent and the contract is wrong.

### 1.3 The freeze rule

1. `VOICE_WIRE_VERSION = 1` is frozen. v1 semantics are not edited in place.
2. **Purely additive optional fields stay within v1**: a consumer that does not know a field ignores it.
   No message may gain a *required* field without a version bump.
3. A breaking change (removed field, changed meaning, new required field) is **v2**, added alongside —
   v1 stays readable. `VOICE_WIRE_VERSION` identifies which one a frame is.
4. `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` and `shared/src/types/voice-messages.ts` change **together**;
   the test in §9 fails otherwise, and `tsc` fails if the confirm's shape is weakened (§4.3).
5. Only the conductor reassigns this path. A track that needs a change raises it as a question rather
   than editing the seam.

### 1.4 Three structural properties this contract buys

These are the reason the contract exists as code and not as a wiki page:

| Property | Mechanism |
|---|---|
| **A client cannot post instruction bytes** (N1, N2) | No client→server voice message may carry `text`, `utterance`, `instruction`, `relayText`, `message` or `prompt`; `checkVoiceEnvelope` refuses such a frame. The operator's words travel as audio; the transcript is produced server-side; typed input stays on the separate `prompt` path. |
| **A confirmation needs a proposal identity** (§4.3, N1) | `proposal_confirm` carries `proposalId` + `variant` + `idempotencyKey` and has no text field. The compile-time assertion in `voice-messages.ts` fails `tsc` if anyone adds one, and the runtime guard refuses the frame. |
| **The kernel stays client-neutral** (D7, §20.1 of the intent) | The contract module contains no browser lifecycle global; the test inspects the source and fails if one appears. Lane and generation identity replace tab, page and audio-DOM assumptions. |

---

## 2. Transport decision

### 2.1 Decision

**Voice uses the existing authenticated session WebSocket.** Voice messages are versioned types routed
by the existing connection router ([`server/src/websocket/connection.ts`](../../server/src/websocket/connection.ts),
`routeMessage`) with types declared alongside the other wire types in
[`server/src/websocket/protocol.ts`](../../server/src/websocket/protocol.ts). Track B exports the service and
a thin handler; Phase 5 adds one `case` per client→server voice type, delegating to the handler.

No new endpoint, no second transport, no client-held provider credential.

### 2.2 Why

1. **The security properties already exist and are already the gate.** Every accepted WebSocket path passes
   a single pre-upgrade decision whose order is *allowed Origin → cookie JWT → upgrade rate limit*
   (`decideWsUpgrade`, `server/src/security/websocket.ts`); a rejected request never creates a WebSocket.
   After the connection, the `auth` frame validates the CSRF token
   (`server/src/websocket/connection.ts`, the `auth` case) and every frame from a client that has not
   completed that handshake is refused with `UNAUTHORIZED` before routing. Per-message rate limiting
   (`wsMessageLimiter`) applies to every frame. Voice frames inherit all of it and add no new
   authentication surface — which is exactly the property the brief requires be preserved.
2. **`GEMINI_API_KEY` never leaves the server.** The browser sends PCM to the server and receives PCM from
   the server. The key is read by Track B's service from the server environment and appears in no emitted
   event, no wire message and no client bundle.
3. **The durability work already covers this socket.** Mobile reconnect on resume/online/focus, ordered
   outbound queueing, visible send failures and text restoration (intent §11) are implemented for the
   session socket — the same socket the shipped voice path (`talker_turn`, `talker_digest`) already uses.
   A new socket would need all of that again.
4. **Lane correlation has a proven precedent.** `talker_turn` + `client/src/lib/talkerBus.ts` already do
   request-id correlation and lane acceptance; the voice catalogue reuses the convention (`requestId`
   echoed; `laneId` + `attachmentGeneration` on every frame).
5. **One router means one place the gate can be reached.** N8 is easier to keep when there is a single
   frame dispatch, not two.

### 2.3 Alternatives rejected

| Alternative | Why not |
|---|---|
| A dedicated unauthenticated (or token-only) voice WebSocket | Re-derives auth/CSRF/origin, creates a second gate reachability path, and adds a second reconnect story. N8 forbids widening the gate's reachability for convenience. |
| Browser connects directly to Gemini Live with a client-held key | Standing rule: the server key never crosses to the client. Also puts the provider credential in a bundle. |
| WebRTC / media server | New infrastructure with no measured benefit; the PCM rates here are small (16 kHz mono in, 24 kHz mono out). |
| Binary WebSocket frames for audio | The existing router is JSON-typed and authenticates on the text path; a mixed-mode socket doubles the validation surface for a 33% payload saving on ~640-byte chunks. Base64 with a hard ceiling is the smaller risk. |

### 2.4 Frame shape and limits

- **Frames are JSON text frames**, matching the existing protocol. Audio travels base64-encoded with the
  byte ceilings in §5.
- The existing connection rate limiter applies unchanged.
- A `voice_*` frame that fails the router's type check today receives the existing
  `{ type: 'error', code: 'INVALID_MESSAGE' }` frame. That is the correct fail-closed behaviour **before**
  Phase 5 wires the handler: no capability exists until the handler is registered.
- After Phase 5, a *structurally invalid* frame that carries no usable lane identity is still answered by
  the generic `error` frame (there is no lane to address with `voice_error`); every other refusal is a
  `voice_error` with `code` from §3.4.

---

## 3. The envelope and versioning

### 3.1 Envelope fields

Every voice message carries these fields. `laneId` + `attachmentGeneration` are the frame's **target**;
on a proposal they are also the target the eventual release is bound to, which is what makes a stale
confirmation incapable of being re-pointed at another worker.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `type` | yes | catalogue name | The message type (§4). |
| `version` | yes | `1` | The **wire** version. Always `VOICE_WIRE_VERSION`. |
| `laneId` | yes | non-empty string, ≤200 chars | Opaque lane identity, minted by the client at `voice_session_start`. Recommended shape `${workerSessionId}:${tabNonce}` so two tabs cannot collide. |
| `attachmentGeneration` | yes | non-negative integer | Bumped by the client when the worker attached to the lane changes; adopted by the server at start. |
| `requestId` | no | string | Request/response correlation. The server echoes it on every message answering a request. |
| `sentAtMs` | no | number | Client-stamped send time. Informational; never trusted, never authority. |

`proposal_created` carries the proposal's **own** version counter as `proposalVersion`, not
`version` — see §8.4.

### 3.2 Attachment generation

A lane is one (client surface × worker session) attachment. When the operator switches the worker behind a
lane, the client:

1. stops the lane's native session (`voice_session_stop`, reason `worker_switch`);
2. opens a new generation (`voice_session_start` with `attachmentGeneration + 1`).

The server refuses any frame naming a generation it has not accepted for that lane
(`voice_generation_stale`) and **never retargets**: an unfinished draft or live proposal stays with its
original generation (§4.11 of the recommendation). A pending confirmation therefore cannot silently
become a confirmation for a different worker.

### 3.3 Correlation fields

- `requestId`: issued by the client for requests that expect an answer (`voice_session_start`,
  `parking_list`, `proposal_confirm`); echoed by the server on the message that answers it. A result with
  no matching issued `requestId` must not be applied to a lane's UI state — the same rule the shipped
  `talkerBus` already enforces.
- `seq`: monotonic per lane and per direction from 0, on audio chunks only (§5).
- `utteranceId`, `turnId`: kernel identity, server→client only, present once a turn is committed.

### 3.4 Fail-closed rules (normative)

`checkVoiceEnvelope(value, direction)` is the single entry check, in this order. A refusal means
**nothing was acted on**; the caller surfaces it and never coerces the frame into shape.

| Condition | Refusal code |
|---|---|
| Not an object / array / null, or `type` missing-or-not-a-string | `voice_message_malformed` |
| `type` unknown, or known but belonging to the other direction | `voice_message_unknown` |
| `version` missing, not a number, or ≠ `1` | `voice_version_unsupported` |
| `laneId` missing, empty, not a string, or over the length bound | `voice_message_malformed` |
| `attachmentGeneration` not a non-negative integer | `voice_message_malformed` |
| Client→server frame carrying any instruction-bearing key | `voice_client_text_forbidden` |
| `type === 'proposal_confirm'` that is not a valid confirmation | `voice_confirm_requires_proposal` |

Unknown **fields** are ignored — except that the confirmation is read only through its allow-listed
identity fields, so an unknown field can never supply consent or bytes.

Client-side symmetry: a server→client frame whose `version` the client does not support must be refused
and surfaced (`voice_version_unsupported`), never parsed on the assumption that it is v1.

---

## 4. Message catalogue v1

### 4.1 The catalogue

`client → server` means "browser to Pi Web UI server". The table below is machine-read by
`voice-messages.test.ts`; the catalogue constants and the table must agree exactly, both directions.

<!-- catalogue:begin -->
| Type | Direction | Purpose |
|---|---|---|
| `voice_session_start` | client → server | Open (or reopen) the lane's native voice session and adopt its attachment generation. |
| `voice_session_stop` | client → server | Close the lane's native voice session. Never releases. |
| `voice_audio_chunk` | client → server | One microphone chunk: 16 kHz mono base64 PCM16LE. |
| `voice_activity_state` | client → server | Local voice-activity boundary. Scheduling only — never a send trigger. |
| `proposal_confirm` | client → server | The confirmation gesture: proposal id + variant + idempotency key, and no text. |
| `proposal_cancel` | client → server | Abandon a live proposal. Narrowing only. |
| `proposal_presentation` | client → server | Report whether a proposal read-back completed. Release-inhibiting only. |
| `parking_promote` | client → server | Promote exactly one parked item into a proposal. Never a delivery. |
| `parking_list` | client → server | Ask for the parking lot; the server answers with `parking_updated`. |
| `voice_reading_level` | client → server | Change the reading level (an operation, not free text). |
| `voice_state` | server → client | Lane lifecycle, worker activity, reading level, resumption. |
| `voice_audio_chunk` | server → client | One model-speech chunk: 24 kHz mono base64 PCM16LE. |
| `transcript_delta` | server → client | Recognised operator or talker text, partial or final; captions and draft source. |
| `proposal_created` | server → client | A live proposal: identity, both variants, what was presented. |
| `proposal_resolved` | server → client | The proposal left its slot. Not a delivery verdict. |
| `receipt_event` | server → client | The authoritative delivery receipt: delivered / queued / refused / unknown. |
| `parking_updated` | server → client | The parking lot, as an ordered snapshot, plus what changed. |
| `voice_error` | server → client | A refusal or failure, surfaced (N9). |
<!-- catalogue:end -->

### 4.2 Client → server messages

#### `voice_session_start`

| Field | Req | Notes |
|---|---|---|
| `workerSessionId` | yes | Session id or path, as `talker_turn` allows. |
| `runtime` | no | Defaults to `pi`; one of `pi \| claude \| antigravity` (the talker's supported set). |
| `captureMode` | no | `open-mic` (default) \| `push-to-talk` \| `ambient`. |
| `readingLevel` | no | `verbatim` (default) \| `summary` \| `headlines`. |
| `resume` | no | True when reopening the same generation after a socket drop. |

```json
{ "type": "voice_session_start", "version": 1, "laneId": "session-abc:tab7",
  "attachmentGeneration": 3, "requestId": "req-1", "workerSessionId": "session-abc",
  "runtime": "pi", "captureMode": "open-mic", "readingLevel": "summary" }
```

The start ack is `voice_state { state: "live" }`, emitted once the provider reports setup complete.
A refusal is a `voice_error` — never silence (N9).

#### `voice_session_stop`

`reason` ∈ `operator_stop | lane_switch | worker_switch | client_disconnect | provider_error | provider_go_away | dispose`.
Stopping never releases a proposal; a live proposal survives its lane's stop as kernel state and is
reported through `proposal_resolved` (`replaced`) only when the kernel actually drops it.

#### `voice_audio_chunk`

| Field | Req | Notes |
|---|---|---|
| `seq` | yes | Monotonic per lane from 0. A gap is surfaced, never silently reordered. |
| `mimeType` | yes | Exactly `audio/pcm;rate=16000`. |
| `data` | yes | Base64 PCM16LE mono. |
| `durationMs` | yes | ≤ `VOICE_AUDIO_INPUT_FORMAT.maxChunkMs` (100 ms). |
| `capturedAtMs` | yes | Capture-clock stamp; used for pacing diagnostics only. |

```json
{ "type": "voice_audio_chunk", "version": 1, "laneId": "session-abc:tab7",
  "attachmentGeneration": 3, "seq": 41, "mimeType": "audio/pcm;rate=16000",
  "data": "…base64…", "durationMs": 20, "capturedAtMs": 1758100000000 }
```

#### `voice_activity_state`

`state` ∈ `speech_start | speech_end`, plus `atMs`. This is the speech scheduler's barge-in signal
(§20 of the intent): **voice activity governs when the talker may speak; it never governs when the host
may send.** The server must not treat `speech_end`, a pause, or a transcript-stability interval as
consent (N3).

#### `proposal_confirm`

| Field | Req | Notes |
|---|---|---|
| `proposalId` | yes | The proposal the operator was shown. Non-empty. |
| `variant` | yes | `tidied` \| `original` — which retained bytes to release. |
| `idempotencyKey` | yes | Minted once per confirmation gesture; **reused verbatim** when the same gesture is retried after a transport drop, so a retry cannot deliver twice. |
| `proposalRef` | no | Additive echo of the displayed identity `{ version, sha256 }`; when present the gate requires it to still describe the current proposal (the shipped D-card behaviour). |

**This message carries no instruction text of any kind, and it must be structurally impossible to confirm
without a proposal identity.** The type has no text field, the compile-time assertion in
`voice-messages.ts` fails the build if one is added, and `isProposalConfirmMessage` refuses the frame at
runtime. A confirmation names *which* proposal; it never supplies *what* is sent — the released bytes come
from the kernel's retained proposal (§4.6, §16.3 of the intent).

```json
{ "type": "proposal_confirm", "version": 1, "laneId": "session-abc:tab7",
  "attachmentGeneration": 3, "requestId": "req-9", "proposalId": "prop-17",
  "variant": "tidied", "idempotencyKey": "idem-9f2c" }
```

#### `proposal_cancel`

`proposalId` + `reason` ∈ `operator_cancel | replaced | lane_stopped`. Cancellation wins immediately
(§7.1.2 of the recommendation) and can never release.

#### `proposal_presentation`

`proposalId` + `presentedVariant` + `completed` (+ optional `stoppedAtChar`).

The read-back rule of §4.6/§18.2 makes "the operator heard the actual bytes" part of what a confirmation
authorises. The host controls its own read-back synthesis and sees provider interruptions, but a purely
local playback stop would otherwise be invisible to the server. This message closes that gap and **only
narrows**: `completed: true` authorises nothing at all; `completed: false`, or a report for a proposal
that is no longer current, makes a later confirmation refuse with `voice_presentation_incomplete`. It can
never create, release or replace a proposal (N8).

#### `parking_promote`

`itemId` of exactly one parked item. Creates the proposal — **never a delivery**. The item's text is the
operator's own words, supplied by the kernel; the client never sends text. Batch promotion does not exist:
N3 is per instruction, and a batch would quietly defeat it. The resulting proposal is announced by
`proposal_created` with `promotionRoute: "parked_item"` and `sourceItemId`.

Whether the *same* spoken utterance that named the item also serves as that proposal's confirmation is a
**kernel decision** (Track A classifies the utterance); the wire contract supports both readings and
mandates neither.

#### `parking_list`

No fields beyond the envelope. Answers with `parking_updated { operation: "listed" }`.

#### `voice_reading_level`

`level` ∈ `verbatim | summary | headlines`. A reading-level change is an **operation, not free text**: it
names a level, never content. It takes effect at the next safe boundary (§10 of the intent: a stopped read
stays stopped, what was already heard never replays, and the change is announced). The server confirms by
emitting `voice_state` carrying the new `readingLevel`.

### 4.3 The confirm rule, restated

> A release requires **the operator's own confirmation utterance or gesture**, bound to **one currently
> presented proposal** whose identity (`proposalId`, target `laneId` + `attachmentGeneration`, variant)
> and content digest still match, with **no prior successful release for that identity**, and no
> cancellation or ambiguity. Confirmation carries identity and consent — **never text**.

The last clause is the contract's hardest structural guarantee and the one Track C must not route around.

### 4.4 Server → client messages

#### `voice_state`

`state` ∈ `idle | connecting | live | reconnecting | suspended | stopped | error`, plus optional
`workerActivity` (`idle | busy | unknown`), `readingLevel`, `captureMode`, `detail`, and
`resumption: { resumable }`.

The server emits this on start, on provider `goAway`/reconnect, on suspension, on a reading-level change,
and whenever the worker's busy state changes in a way the surface should show. `state: "live"` is the
start ack. Honesty requirements ride with it: never claim continuous listening while capture is suspended
by the platform — show and say the suspension.

#### `voice_audio_chunk` (server → client)

| Field | Req | Notes |
|---|---|---|
| `seq` | yes | Monotonic per lane from 0, provider delivery order. |
| `mimeType` | yes | Exactly `audio/pcm;rate=24000`. |
| `data` | yes | Base64 PCM16LE mono at 24 kHz. |
| `durationMs` | yes | ≤ `VOICE_AUDIO_OUTPUT_FORMAT.maxChunkMs` (100 ms). |
| `atMs` | yes | Server clock stamp. |

Playback is scheduled by the client's shared speech floor, never by arrival order alone (§4.10 of the
recommendation). The model never generates the delivery chime.

#### `transcript_delta`

`speaker` ∈ `operator | talker`; `source` ∈ `native | shadow-asr`; `text`; `final`; optional
`utteranceId`, `turnId`; `atMs`.

Three artefacts are kept distinct throughout (§4.6 of the recommendation): **audio received**, **words
recognised**, **bytes delivered**. Only **final** operator deltas may source a draft. A late revision
after a final delta is a new delta and can never silently rewrite an authorised one. Shadow ASR is
labelled and asynchronous; it never gates or delays the gate.

#### `proposal_created`

| Field | Req | Notes |
|---|---|---|
| `proposalId` | yes | Stable identity; what a confirmation names. |
| `proposalVersion` | yes | The proposal's own version counter (not the envelope's wire `version`). |
| `sha256` | yes | Digest over the exact release bytes of the presented variant. |
| `promotionRoute` | yes | `directed` \| `accepted_offer` \| `parked_item`. Nothing else creates a proposal. |
| `sourceItemId` | no | Present for `parked_item`. |
| `sourceUtteranceId` | no | The operator utterance the proposal came from. |
| `original` | yes | The operator's semi-verbatim words, retained in full. |
| `tidied` | yes | The bytes a default (`tidied`) confirm releases. |
| `presentedVariant` | yes | Which variant the surface is presenting now. |
| `presentation` | yes | `{ completed: boolean, stoppedAtChar?: number }`. |

```json
{ "type": "proposal_created", "version": 1, "laneId": "session-abc:tab7",
  "attachmentGeneration": 3, "proposalId": "prop-17", "proposalVersion": 4,
  "sha256": "9f2c…", "promotionRoute": "parked_item", "sourceItemId": "item-2",
  "original": "ask it whether the retry handler drops the token", "tidied": "ask it whether the retry handler drops the token",
  "presentedVariant": "tidied", "presentation": { "completed": false, "stoppedAtChar": 42 } }
```

`original` and `tidied` are shown so the operator approves what will actually go, and `presentedVariant`
records what they were shown — a card may not claim "your words, exactly" when a visible tidy happened.

#### `proposal_resolved`

`proposalId` + `outcome` ∈ `released | cancelled | refused | replaced | expired`, optional `releaseId`
(when released) and `refusal` (when refused).

**This is not a delivery verdict.** `released` means the release path was authorised and handed to
delivery, and nothing more. The only evidence of delivery is `receipt_event` (§7.3, N6).

#### `receipt_event`

| Field | Req | Notes |
|---|---|---|
| `releaseId` | yes | The release this receipt belongs to. |
| `proposalId` | yes | The proposal that was released. |
| `idempotencyKey` | yes | The key from the confirmation, so an `unknown` outcome can be reconciled. |
| `outcome` | yes | `delivered` \| `queued` \| `refused` \| `unknown`. |
| `mechanism` | no | `steer` \| `prompt` \| `follow_up`. |
| `disclosure` | no | Per-runtime honest disclosure (e.g. an Antigravity follow-up queue). |
| `reason` | no | Present when refused. |
| `unknownCause` | no | `timeout` \| `disconnect` \| `transport_error` — the `unknown*` family. |
| `reconcile` | no | True when an `unknown` outcome must be reconciled by `idempotencyKey` rather than retried. |
| `atMs` | yes | Server clock stamp. |

**The trusted chime fires on `receipt_event` with `outcome: "delivered"` and on nothing else.** The
model never produces the confirmation sound (§4.5 of the recommendation); the surface plays a locally
owned asset.

#### `parking_updated`

`operation` ∈ `added | promoted | removed | listed`, and `items`: the full ordered snapshot (oldest
first) of `{ itemId, text, createdAtMs, sourceUtteranceId? }`.

The full snapshot rather than a delta means a reconnecting client needs no delta bookkeeping. Parked
items are the operator's own words, held for later promotion; they are **never sent as a batch**, and a
promotion is still only a proposal.

#### `voice_error`

`code` (from §3.4 plus the service codes), `message`, `fatal`.

| Code | Meaning |
|---|---|
| `voice_message_malformed` / `voice_message_unknown` / `voice_version_unsupported` | Envelope/version refusal (§3.4). |
| `voice_lane_unknown` / `voice_generation_stale` / `voice_not_started` | No such lane/generation, or audio before a successful start. |
| `voice_client_text_forbidden` | A client frame tried to carry instruction text. Nothing acted on. |
| `voice_confirm_requires_proposal` | A confirmation without a usable proposal identity. |
| `voice_proposal_stale` / `voice_presentation_incomplete` | The confirmation named a proposal that moved on, or whose read-back did not complete. |
| `voice_audio_chunk_too_large` / `voice_audio_chunk_corrupt` | Chunk dropped (§5.3). Never fatal. |
| `voice_provider_unavailable` / `voice_quota_exhausted` | The bridge could not reach or could not continue the provider session. |
| `voice_internal_error` | Anything else; surfaced, never swallowed. |

Refusals are **healthy outcomes**, not errors in the product sense (§12 of the intent). Surfacing them is
N9 in the voice path.

### 4.5 Direction-level guarantee

Every client→server message in §4.1 is **text-free** by construction. There is no client→server voice
message that carries the operator's words. Typed operator input remains the existing `prompt` message on
the session socket, outside this contract, where it already is.

---

## 5. Audio framing

### 5.1 Formats

| | Client → server (microphone) | Server → client (model speech) |
|---|---|---|
| Sample rate | **16 000 Hz** | **24 000 Hz** |
| Channels | 1 (mono) | 1 (mono) |
| Encoding | `pcm_s16le` (signed 16-bit little-endian) | `pcm_s16le` |
| MIME type | `audio/pcm;rate=16000` | `audio/pcm;rate=24000` |
| Suggested chunk | 20 ms = 640 bytes | 20 ms = 960 bytes |
| Hard maximum | 100 ms = 3 200 bytes | 100 ms = 4 800 bytes |
| Base64 ceiling | 4 268 chars | 6 400 chars |
| Container | base64 in the JSON frame | base64 in the JSON frame |

The client does not resample: capture is configured for 16 kHz and playback is fed at 24 kHz. The 24 kHz
figure matches the provider's output; the provider-wire conversion lives entirely in Track B's service
(`server/src/voice/audio-transcoder.ts` in the plan), so neither side of this contract sees the provider's
own framing.

### 5.2 Pacing and buffers

- **Capture is unconditional; only playback is scheduled** (N5). The client must never suppress capture to
  let another lane speak.
- Client capture is paced at the suggested chunk size. A local VAD may avoid *sending* silence, but a
  pre-roll buffer must be retained so the first word is never clipped (P21 is exactly that defect).
- The playback queue is bounded. On overflow the client drops the **oldest unplayed model audio** and
  surfaces it; it never drops or delays operator capture, and it never hard-stops the current utterance
  (ducking replaces stopping).
- Backpressure on capture is honest: if the socket cannot keep up, the failure is surfaced (§11 of the
  intent: a dictated prompt is never lost silently), never swallowed.

### 5.3 Oversized and corrupt chunks

| Condition | Behaviour |
|---|---|
| `data` longer than the format's base64 ceiling | **Drop + surface** `voice_error { code: "voice_audio_chunk_too_large", fatal: false }`. |
| `data` not base64 (bad length, non-base64 character) | **Drop + surface** `voice_error { code: "voice_audio_chunk_corrupt", fatal: false }`. |
| `mimeType` not the expected literal | Refuse the frame as `voice_message_malformed`; never transcode on a guess. |
| `seq` gap | Surface once (`voice_internal_error` with a bounded detail) and continue; never reorder silently. |
| Any of the above, repeatedly | **Bounded surfacing**: at most one such `voice_error` per lane per second, with a suppressed count carried on the next one. A fault storm must not become a socket storm. |

No audio fault may crash the lane or the server: the trigger contract for the bridge is "drop and
surface", and the client renders the surface state rather than pretending the audio arrived.

---

## 6. Server service boundary

### 6.1 The service Track B implements

```ts
interface VoiceBridgeService {
  start(options: VoiceBridgeStartOptions): Promise<void>;
  stop(laneId: VoiceLaneId, reason: VoiceStopReason): Promise<void>;
  feedAudio(chunk: VoiceAudioInputChunk & { laneId; attachmentGeneration }): void;
  noteActivity(note: VoiceActivityNote): void;
  injectContext(laneId: VoiceLaneId, update: VoiceBridgeContextUpdate): void;
  setReadingLevel(laneId: VoiceLaneId, level: VoiceReadingLevel): void;
  getState(laneId: VoiceLaneId): VoiceBridgeLaneState | null;
  subscribe(listener: (event: VoiceBridgeEmittedEvent) => void): () => void;
  dispose(): Promise<void>;
}
```

The exact field shapes are normative in
[`shared/src/types/voice-messages.ts`](../../shared/src/types/voice-messages.ts) (`VoiceBridgeService`,
`VoiceBridgeStartOptions`, `VoiceBridgeContextUpdate`, `VoiceBridgeLaneState`, `VoiceBridgeCallbacks`,
`VoiceBridgeEmittedEvent`) and are not restated here to avoid a second source of truth.

Implementation invariants:

1. **No credential ever leaves the service.** `GEMINI_API_KEY` is read from the server environment; it
   appears in no emitted event and no wire message, and it must not be present in any client bundle.
2. **`feedAudio` never throws and never buffers past the ceiling.** Oversized or corrupt chunks are
   dropped and surfaced (§5.3).
3. **`stop` and `dispose` release nothing.** They close provider sessions; the kernel owns releases.
4. **Client-neutral (D7).** No browser lifecycle concept — tab, page visibility, DOM-bound state, one
   audio floor per surface — may appear in the service or its events. Lane identity and attachment
   generation replace them.

### 6.2 Emitted events and lifecycle callbacks

`VoiceBridgeEmittedEvent` is the productised shape of the lab adapter's `GeminiLiveCallbacks`
(`scripts/voice-live-lab/lib/providers/gemini-live.ts`), which Track B productises per the plan's Phase 3.
The mapping is mechanical, and one row is deliberately not a wire message:

| Lab callback | Emitted event | Wire message |
|---|---|---|
| `onAudioPcm` | `audio_out` | `voice_audio_chunk` (server→client) |
| `onInputTranscriptionDelta` / `onOutputTranscriptionDelta` | `transcript` | `transcript_delta` |
| `onTurnComplete` | `turn_complete` | (state / captions) |
| `onInterrupted` | `interrupted` | `voice_state` |
| `onToolCall` | `tool_call` | **none** — drives the kernel |
| `onResumptionHandle` / `onGoAway` | `resumption` / `go_away` | `voice_state` |
| socket error / close | `error` / `state` | `voice_error` / `voice_state` |

`tool_call` carries the two declared Live functions the lab proved out: `mark_addressed_to_talker`
(suppress a draft candidate) and `offer_ask_worker` (create a candidate that still needs the operator's
own confirmation). **Neither can release, and neither can supply consent or bytes** — they are the
non-blocking replacements for the fragile `[[to-talker]]` / `[[ask-worker]]` text marks (§19.2 of the
intent), and the harness interprets them exactly as it interpreted the marks.

### 6.3 Session lifecycle, resumption and context injection

- **Resumption.** The service keeps the provider's resumption handle in memory, captures each
  `sessionResumptionUpdate`, and reconnects on `goAway` or a network drop without discarding the
  conversation (plan Phase 3). On reconnect it restores a **compact host snapshot** and never replays
  acknowledged sends or already-heard speech (§4.11 of the recommendation).
- **Context injection.** Worker state is *structured, host-derived* context, injected with
  `sendClientContent({ turnComplete: false })`, coalesced to at most one update per
  `VOICE_CONTEXT_COALESCE_MS` (2 000 ms) and held back while the operator is speaking. It includes a
  `statusLine` (e.g. `CURRENT STATUS: RUNNING`) so the model cannot claim a completion it cannot see.
  Housekeeping is excluded at the emitter, not in the prompt (§4.8 of the recommendation).
- **The worker must continue when the voice socket closes.** Nothing in the bridge owns worker state; the
  kernel stores drafts, receipts, parked items and supervision state outside model context.

### 6.4 The router handler Phase 5 registers

```ts
interface VoiceRouter {
  handle(context: VoiceRouteContext, message: VoiceClientMessage): Promise<VoiceErrorCode | null>;
}
```

Phase 5 adds one `case` per entry of `VOICE_CLIENT_MESSAGE_TYPES` to `routeMessage`, each delegating to
this handler with `{ send(message) }` bound to the originating client. The handler:

1. runs `checkVoiceEnvelope(message, 'client-to-server')` and returns the refusal code on failure
   (surfaced as `voice_error`, or the existing generic `error` frame when there is no usable lane);
2. resolves the lane and generation, refusing `voice_lane_unknown` / `voice_generation_stale`;
3. routes: audio/activity/lifecycle to the bridge; promotion/confirmation/cancel/presentation/parking to
   the kernel; then relays what they return as `VoiceServerMessage`s;
4. **adds no capability of its own.** It never releases, never composes text, and never widens the gate
   (N8). If a wire change appears to require a new authority, the design is wrong, not the transport.

Until Phase 5 wires it, a `voice_*` frame is answered by the router's existing `default` branch with
`INVALID_MESSAGE` — fail closed, no capability.

---

## 7. Invariants and non-goals

### 7.1 N1–N9, and where this contract holds them

| Rule | Mechanism in this contract |
|---|---|
| **N1** the relay is gated by code | The contract has no client send path at all. There is no wire message that delivers an instruction; the only release trigger is a confirmation naming a kernel-held proposal. Model output (`tool_call` events) can suppress or create a candidate and nothing else. |
| **N2** the relay text is the operator's own words, semi-verbatim | Client→server voice messages are text-free (§1.4). The released bytes come from the kernel's retained `original`/`tidied`, never from a wire field supplied by the client. |
| **N3** never act on an unfinished thought | `voice_activity_state` is a scheduling signal, never a send trigger. A gap, a pause or a stable transcript releases nothing; only a confirmation bound to a proposal does. |
| **N4** conversation first | The catalogue separates conversation (`transcript_delta`, `voice_audio_chunk`) from authority messages. Nothing in the thread creates a proposal. |
| **N5** you speaking is never interrupted | Capture is unconditional; only playback is scheduled. Activity state changes ducking, not capture, and never hard-stops. |
| **N6** honest delivery | `receipt_event` is the single source of the delivery verdict; `proposal_resolved` is explicitly not one, and the chime fires on `delivered` only. |
| **N7** allow-list, not model judgement | The declared Live functions are the whole typed operation surface; `tool_call` cannot release. |
| **N8** never widen the gate | The contract adds no message that can authorise anything. `proposal_presentation` narrows; a breaking change needs v2 and the conductor. |
| **N9** failures are visible | Every refusal has a named code, a `voice_error` frame and a documented bounded-surfacing rule for storms. |

### 7.2 Reading level and parking are operations

`voice_reading_level` names a level; `parking_promote` names an item; `parking_list` names nothing. None
carries content. The only messages that carry the operator's or the worker's words are server→client
(`transcript_delta`, `proposal_created`, `parking_updated`), which is exactly the direction in which the
host is the authority (§19.4 of the intent: typed operations replace text markers).

### 7.3 Receipt honesty

`delivered`, `queued`, `refused` and `unknown` are distinct. `unknown` is **first-class**: a timeout after
submission is not a refusal, and it is reconciled by `idempotencyKey` rather than retried blindly
(§16.4 of the intent). The surface may only say "sent" on the strength of a `delivered` receipt; a
`proposal_resolved { outcome: "released" }` is not evidence and must never be spoken as one.

### 7.4 Explicit non-goals for v1

- **No typed operator text on this contract.** The scripted typed fallback remains the existing `prompt`
  path on the session socket.
- **No batch promotion.** Neither a message nor a route exists for sending several parked items together.
- **No ambient client design.** `ambient` is an accepted capture mode value only, so a future mobile
  client needs no wire bump; the kernel stays client-neutral at no extra cost.
- **No provider interrupt semantics.** Native interrupt is a separately labelled option requiring owner
  approval and a comparative listening test; v1 exposes ducking plus scheduling.
- **No offers as typed messages.** In v1 the offer to relay is conversational. If a surface needs to
  render an offer as a card, that is an additive v1 extension and a conductor decision.
- **No cross-tab floor coordination.** Out of scope (§4.11 of the recommendation).

---

## 8. Decisions taken in this contract

Recorded because they resolve ambiguity, and so a later reader does not re-litigate them.

1. **`receipt_event` owns the delivery verdict, and the chime follows it.** Phase 4 of the execution plan
   phrases the chime trigger as `proposal_resolved { outcome: "delivered" }`; Phase 3's message list has a
   separate `receipt_event`. Keeping a proposal's lifecycle and a delivery's verdict in one message would
   create two sources of truth for honest delivery (N6), so the contract keeps them separate:
   `proposal_resolved` reports that the proposal left its slot; `receipt_event` reports what delivery
   actually did. Track C chimes on `receipt_event.outcome === "delivered"`.
2. **Promotion never auto-releases.** `parking_promote` creates a proposal; a release still needs a
   confirmation. Whether the promoting utterance doubles as that confirmation is a kernel classification
   decision, not a transport one.
3. **Client→server is text-free.** Not merely the confirmation: no client voice message carries the
   operator's words. This is what makes N1/N2 structural at the transport layer.
4. **`proposalVersion`, not `version`, on `proposal_created`.** The envelope already uses `version` for the
   wire version; a proposal's own version counter must not share that name. The confirmation's optional
   echo keeps the shipped card shape `proposalRef: { version, sha256 }`, where the nested object makes the
   meaning unambiguous.

### 8.1 Two messages beyond the plan's minimum

`proposal_presentation` and `parking_list` (plus the lifecycle/error pair `voice_state` / `voice_error`)
are the contract's additions beyond the execution plan's Phase 4 minimum list. `voice_state`/`voice_error`
are required for fail-closed surfacing. `parking_list` is the read-back control the intent requires.
`proposal_presentation` exists so that the §4.6 read-back rule is enforceable rather than assumed; it is
release-inhibiting only.

---

## 9. Acceptance and verification

The contract's own gate:

```bash
cd /root/pi-web-ui-wt-contract
npm run build --workspace=shared && npm run typecheck --workspace=shared
npm test --workspace=shared
```

What the executable half proves:

| Check | Where |
|---|---|
| The document's catalogue and the code catalogue are the same set, both directions | `voice-messages.test.ts` "catalogue completeness" |
| Every message has an example, and the example survives JSON transport | the fixtures + envelope test |
| Missing/mismatched version, unknown type, cross-direction type, missing lane, bad generation all fail closed with a named code | the "fail closed" tests |
| A confirmation cannot exist without a proposal identity, and cannot carry instruction text | `isProposalConfirmMessage` + `checkVoiceEnvelope` tests |
| No client→server message can carry instruction text | the text-free tests |
| Receipts distinguish delivered / queued / refused / unknown | compile-time assertion in `voice-messages.ts` |
| The module stays free of browser lifecycle globals (D7) | the source-inspection test |
| Audio framing constants and ceilings are internally consistent | the audio tests |
| The confirm shape cannot be weakened without failing the build | `AssertTrue`/`InstructionKeysOf` assertions in `voice-messages.ts`, verified by a negative control during development |

Not covered here (and deliberately so): the bridge's live handshake, the transcoder's sample correctness,
AudioWorklet behaviour and rendered audio. Those belong to Track B's Phase 3 gate, Track C's Phase 4 gate
and the audio lab respectively. A green gate here proves the **seam**, never the product.

---

## 10. Handover

### 10.1 Track B (`server/src/voice/`)

- Implement `VoiceBridgeService` against the shared types; productise the lab adapter rather than copying
  it wholesale.
- Register nothing in the router yourself if Phase 5 has not landed; export the handler through
  `VoiceRouter` and let the conductor wire the `case` branches.
- Keep `GEMINI_API_KEY` server-side; prove it with the phase's own inspection test.
- Honour the audio ceilings and the drop-and-surface rule; honour the 2 s context coalescing and the
  speak-suppression rule.
- Do not edit `shared/src/types/voice-messages.ts`.

### 10.2 Track C (`client/src/lib/voiceWorklet/`, `client/src/components/DriveMode/`)

- AudioWorklet capture at 16 kHz and playback at 24 kHz, paced to the suggested chunk size with bounded
  buffers.
- Play the trusted delivery chime locally on `receipt_event.outcome === "delivered"`; never let the model
  generate it.
- Render `proposal_created` with `original` and `tidied` and the presented variant; send
  `proposal_presentation` when a read-back completes or is interrupted.
- Mint a fresh `idempotencyKey` per confirmation gesture and reuse it verbatim on retry after a reconnect.
- Send `parking_promote` for one item; render `parking_updated`; never batch.
- Keep the duck-and-continue contract (N5) and never disable capture.
- Do not edit `shared/src/types/voice-messages.ts`.
- The contract module is not re-exported from `shared/src/index.ts` yet: that one-line export is Track C's
  to add when the client surface lands (child E owned only the three contract paths).

---

## 11. Source map

- **This contract:** `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md`.
- **Executable half:** [`shared/src/types/voice-messages.ts`](../../shared/src/types/voice-messages.ts),
  [`shared/src/types/voice-messages.test.ts`](../../shared/src/types/voice-messages.test.ts).
- **Intent (N1–N9, the four objects, capture, promotion):** [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md) §15–§20.
- **Target architecture and D1–D7:** [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](../VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md) §4, §7.
- **Phases 3–5 and the gates:** [`VOICE-MODE-EXECUTION-PLAN.md`](../VOICE-MODE-EXECUTION-PLAN.md).
- **Provider adapter productised by Track B:** `scripts/voice-live-lab/lib/providers/gemini-live.ts`.
- **Existing transport and its conventions:** `server/src/websocket/connection.ts`,
  `server/src/websocket/protocol.ts`; client bus precedent `client/src/lib/talkerBus.ts`.
- **Kernel objects the messages reference:** `server/src/talker/types.ts`, `policy-core.ts`,
  `pending-proposal.ts` (Track A evolves these).
