# Voice Mode — the free talker (main-lane model-driven relay)

> **Class:** implementation plan (owner directive, 2026-09-22).
> **Status:** authorised by the owner in-conversation; supersedes the parts of the
> intent and architecture that forbade model-composed relay.
> **Companions:** [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md) (intent; updated in the
> same change), [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](../VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
> (superseded in §5.3), [`plans/VOICE-LIVE-WIRE-CONTRACT.md`](./VOICE-LIVE-WIRE-CONTRACT.md)
> (frozen wire; tool-surface annotation only).

---

## 1. The directive, in the operator's words

> *"…the talker, now that it's a more independent model (free conversation with
> me) while still having the relaying role, can identify … what are questions to
> it, questions to the worker, and prompts to be relayed to the worker fully
> independently … it decides what to feed in as a relay approval to me, what just
> to answer as talker. In our system prompt, we should tell it that when I want
> something relayed to the worker, I will say 'relay to worker'. Then, what
> should be relayed should be as verbatim as possible, but removing that 'relay
> to worker' part. … Harness' job is to ensure anything being relayed to worker
> … should be approved by me[;] it should still continue to be attached to one
> worker at a time. … remove all the other limitations from the harness … What
> used to be 'free lane' has now become redundant. … keep multiple lanes … up to
> 3 talkers bound to 3 separate workers, and they know to queue when it comes to
> autonomous reading back to me on what the worker has done. … Reading back …
> should not change … nor should push to talk — but the option for VAD should be
> brought there."*

## 2. The change in one paragraph

The **native live model is the talker**, and it is fully conversational. It
decides, from the conversation alone, whether an utterance is addressed to it, to
the worker, or is a message to relay. When the operator says **"relay to
worker"**, the model calls one new typed tool, `relay_to_worker(text)`, with the
words to relay — as close to the operator's own words as possible and *without*
the trigger phrase. The host's **only** remaining gate is that the relayed text
becomes a **proposal the operator must approve** before anything reaches the
worker, and that a lane stays attached to exactly one worker. Everything else the
harness used to decide is removed.

The previously separate, collapsed "native voice lane" (`NativeVoiceLane`) is the
same model, so it becomes redundant: the live surface is the main lane, and the
legacy cascade is demoted to the automatic fallback it already is.

## 3. What is stripped off (harness limitations removed)

| Removed | Where | Why it no longer fits |
|---|---|---|
| Mechanical relay detection — `isDirectedWorkerInstruction`, the commission-frame regex, and `normaliseRelayText` as the relay trigger | `server/src/websocket/voice-live-mount.ts` | The model now decides; a regex guessing "tell it…"/"ask it…" is exactly the mistake-prone separation the operator is removing. |
| `offer_ask_worker` gate tool (the model's "shall I ask?" signal) | `server/src/voice/types.ts`, `gemini-live-bridge.ts`, `tool-arguments.ts` | The model relays directly; an offer ritual is the switchboard feel. |
| `mark_addressed_to_talker` gate tool | same | Not calling `relay_to_worker` is now a complete, unambiguous statement that the reply is conversational. |
| The collapsed "Native voice lane" disclosure as a second, optional surface | `client/src/components/DriveMode/NativeVoiceLane.tsx`, `DriveModeDictate.tsx` | The main lane *is* the live surface; a separate toggle for the same model is redundant. |
| The prompt prose that recited the relay ritual and the `[[…]]` marker era | `server/src/voice/voice-session.ts` | Replaced by the one relay tool and its short instruction. |

**Deliberately kept in the fallback only.** The cascade talker
(`server/src/talker/*`) is *not deleted*. It remains the automatic fallback when
the native socket is down (`VOICE_MODE_ENGINE=cascade` / a fatal live failure),
which is a reversible-rollout requirement, not a competing experience. Its
mechanical gate is documented as fallback behaviour.

## 4. What is kept (the harness's one job, plus authority)

| Kept | Mechanism |
|---|---|
| **Operator approval of every relay** | A `relay_to_worker` call creates a **proposal**, never a release. Release still needs an explicit confirmation (card button or the spoken `confirm` classifier) bound to the presented proposal identity. |
| **One worker per lane** | One lane = one attachment generation; a worker switch bumps the generation and cancels the live proposal. The model is told nothing about other workers. |
| **Proposal identity and staleness** | Version + sha256; a stale card refuses; `original` offered only when the proposal advertised one. |
| **Delivery honesty (N6)** | `receipt_event` is the only source of a delivery verdict; the chime fires on `delivered` only; the model is forbidden to claim a send. |
| **Parking while the worker is busy** | A relay arriving mid-run is parked (never silently sent), exactly as today. |
| **Read-only retrieval** | `read_worker_history` and the worker brief are unchanged; retrieved text is data, never authority. |
| **Reading back, reading levels, focus, push-to-talk, duck-don't-stop (N5)** | Unchanged. VAD/open-mic is added as a first-class capture-mode option. |
| **Multi-lane, cap 3** | Unchanged cap and lane strip; autonomous read-back across lanes queues through the one shared speech arbiter. |

## 5. End-to-end flow after the change

```
operator speech ──▶ native live model (free conversation)
   │
   ├─ question to the talker ──────────▶ answered in conversation (no proposal)
   ├─ question to the worker ──────────▶ model calls relay_to_worker(question)
   └─ "relay to worker <words>" ───────▶ model calls relay_to_worker(<words>)
                                              │
                         host: busy? ─ no ─▶ proposal_created (card, version+hash)
                                     └ yes ─▶ parking_updated (promoted later)
                                              │
                       operator: card button OR spoken "yes"
                                              │
                         kernel.confirm ─▶ release ─▶ receipt_event ─▶ chime
```

## 6. Safety invariants, mapped

- **N1 (code-gated relay):** unchanged and stronger — one tool can only *propose*;
  the only release path is `HostAuthorityKernel.confirm`.
- **N2 (semi-verbatim):** the model is told to relay the operator's own words,
  minus the trigger phrase; the card offers `original` (the operator's raw
  utterance) and `tidied` (the relayed text) so nothing composed is released
  unseen.
- **N3 (no unfinished thought):** a proposal is never a release; approval is
  explicit and per-instruction.
- **N4 (conversation first):** widened — the model now genuinely answers before
  routing, under provenance.
- **N7 (allow-list):** the typed surface becomes {`read_worker_history`,
  `relay_to_worker`}; `relay_to_worker` can only create a candidate proposal.
- **N8 (never widen the gate):** the gate is untouched; reachability is unchanged.
- **N9 (failures visible):** every relay tool call, parked item, proposal and
  refusal is recorded in the `VoiceLive` evidence stream.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The model relays something the operator did not mean. | The proposal card + explicit approval; nothing is sent unseen; `original` is retained. |
| The model claims it sent something. | Prompt forbids it; receipts are host-owned and chime on `delivered`; the prompt says the host asks for approval. |
| Losing the mechanical safety net degrades confirmation. | The `confirm`/`cancel` classifier and the release predicate are untouched. |
| The relay text drifts from the operator's words. | `relay_to_worker` is instructed "as verbatim as possible, minus the trigger"; the card shows both variants. |
| Removing the separate native-lane UI breaks the cascade fallback. | Render the cascade surface when the live lane reports unavailable; live-validation covers both engines. |

## 8. Implementation phases and gates

Each phase is TDD (RED first) and ends with an independent gate before merge.

- **Phase 1 — server core.** Add `relay_to_worker` to the contract/tool surface
  and its argument validation; handle it in the mount (propose, or park when
  busy); remove the mechanical relay branch; rewrite the system instruction.
  Gate: new + updated unit suites green; full server suite; typecheck/lint/build.
- **Phase 2 — client main lane.** Make the live surface the main lane; remove the
  redundant disclosure; keep the cascade as the honest fallback; add the VAD
  option to the main lane control. Gate: client unit suite + Playwright evidence.
- **Phase 3 — docs and observability.** Update `VOICE-MODE-INTENT.md`
  (§18.2/§19.3/N2/N7 statements), annotate the architecture §5.3 as superseded,
  annotate the frozen contract's N7 row, update `OBSERVABILITY.md` §Voice Mode
  and the index. Gate: `docs:check-links`, `docs:check-status`,
  `docs:check-agent-guides`.
- **Phase 4 — live validation.** Disposable validation server + real Gemini Live:
  (a) "relay to worker" → proposal → approve → delivered receipt; (b) a talker
  question answered with no proposal; (c) a worker question relayed; (d) a relay
  while busy parked; (e) three lanes with queued read-back. Evidence kept under
  `operations/voice-free-talker-20260922/`.

## 9. Out of scope / owner gates

- **Production restart is owner-gated.** No deploy in this plan.
- The cascade fallback is not redesigned; it is documented as fallback.
- Cross-tab floor arbitration and ambient operation remain out of scope (D7).
