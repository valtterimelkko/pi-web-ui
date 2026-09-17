# Brief E — wire contract (Wave 0 child)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-wt-contract` (branch `feat/voice-contract`, based on master `f70030d`). **Runtime:** pi. **Model:** `commandcode/deepseek/deepseek-v4.1-flash`, thinking `high`.

## Bounded outcome

The **frozen v1 wire contract** for the Voice Mode native-voice slice: typed, versioned messages and the server service boundary, so that Track B (server Gemini Live bridge) and Track C (client audio + UI) can be built independently and meet at Phase 5 integration without drift.

**Deliverables (commit all on your branch):**

1. `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` — the contract document.
2. `shared/src/types/voice-messages.ts` — the TypeScript types + runtime guards, following the conventions of the existing `shared/src/protocol-types.ts` (plain TS interfaces/types; add lightweight runtime guards only if the file's conventions support them).
3. `shared/src/types/voice-messages.test.ts` — a small test that executes: catalogue completeness (every documented message has a type), envelope shape, and the confirm-cannot-exist-without-proposal-identity rule at the type/shape level.

## Context you must read before writing

- `docs/VOICE-MODE-INTENT.md` §15–§20 (the four objects, promotion routes, provenance, capture) — **N1–N9 are non-negotiable**; the contract must make the gate's requirements structural.
- `docs/VOICE-MODE-EXECUTION-PLAN.md` Phase 3 and Phase 4 (message lists; bridge requirements; AudioWorklet + arbiter + chimes).
- `docs/VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md` §4.1–§4.6 and Step 2 ("typed, versioned audio/turn/proposal/receipt/parked-item events with lane and attachment generation").
- `shared/src/protocol-types.ts` — existing conventions; do not modify it.
- `server/src/websocket/connection.ts` + `server/src/websocket/protocol.ts` — how the existing authenticated session WebSocket routes typed messages; the contract must state exactly where voice messages dispatch (Track B exports the handler; Phase 5 wires the router).
- `client/src/lib/talkerBus.ts` — the client bus pattern Track C will mirror.
- `server/src/talker/types.ts`, `policy-core.ts`, `pending-proposal.ts` — the kernel objects (proposal identity, versions, sha, release idempotency) the messages reference.
- `scripts/voice-live-lab/lib/providers/gemini-live.ts` — the provider adapter Track B productises (interfaces `LiveSessionFactory`, `LiveCallbacks`, `GeminiLiveCallbacks`, resumption/goAway) — your server-boundary section must be compatible with it.

## Required content of the contract document

1. **Transport decision + rationale.** Reuse the existing authenticated session WebSocket as the voice transport, adding versioned voice message types routed by the existing connection router. No new unauthenticated endpoint, no client-held provider credentials (cookie/origin/CSRF protections preserved). If the code makes this decision wrong, raise a question — do not invent around it.
2. **Envelope** for every message: `type`, protocol `version`, `laneId`, `attachmentGeneration`, and correlation fields; rules for unknown/mismatched versions (fail closed, surface to client).
3. **Message catalogue v1**, each with direction, required fields, and a short example. Client→server at minimum: `voice_session_start`, `voice_session_stop`, `voice_audio_chunk`, `voice_activity_state`, `proposal_confirm`, `proposal_cancel`, `parking_promote` (the plan names the last five; session lifecycle may be added). Server→client at minimum: `voice_audio_chunk`, `transcript_delta`, `proposal_created`, `proposal_resolved`, `receipt_event`, `parking_updated`, plus `voice_state`/`voice_error` if needed. Proposal messages carry `proposalId`, `version`, `sha256`, `presentedVariant`; `proposal_confirm` carries `proposalId`, `variant`, `idempotencyKey` and **no instruction text of any kind**. It must be structurally impossible to confirm without a proposal identity.
4. **Audio framing**: client→server 16 kHz mono PCM; server→client 24 kHz; encoding/mimeType, suggested chunk size and hard maximum; behaviour on oversized/corrupt chunks (drop + surface, never crash).
5. **Server service boundary** (the interface Track B implements): an exported service (e.g. `VoiceBridgeService`) with start/stop/feed-audio/context-injection/lifecycle callbacks and an emitted-event type union; plus the thin handler Phase 5 registers in the websocket router. **Client-neutral**: no `window`/DOM/browser-lifecycle references anywhere in server-facing types (standing constraint from D7).
6. **Non-goals / invariants section**: N1 unchanged (model cannot send); relay text is always the operator's words; the model never composes instruction bytes; receipts distinguish `delivered` / `queued` / `refused` / `unknown*`; reading-level and parking-lot messages are operations, not free text.

## Acceptance gate (run and record the outputs)

```bash
cd /root/pi-web-ui-wt-contract
npm run build --workspace=shared && npm run typecheck --workspace=shared
npm test --workspace=shared
```

Exit 0, and the new test executes (not skipped). The document is complete against the checklist above.

## Constraints

- Owned paths only: the three deliverables. No edits to `server/**`, `client/**`, existing `shared/src/protocol-types.*`, or any talker file.
- N1–N9 unchanged; server key never crosses to the client; kernel stays client-neutral.
- TDD where the test is meaningful; the types must compile under the shared workspace's `tsc`.
- If the brief conflicts with existing code, **stop**: write `/root/voice-exec-20260917/coordination/E/01-questions.md`, print `PARENT-INPUT-NEEDED` as a standalone line, and end your turn.

## Handback (end of work, then end your turn)

Commit on `feat/voice-contract`. Write `/root/voice-exec-20260917/coordination/E/complete.md`:

- outcome (what was delivered, one paragraph);
- **changed-path inventory** (exact list);
- gate commands + observed results (paste key output);
- a ≤10-line contract summary for conductor review (transport decision; message names; service boundary name);
- `FROZEN` marker meaning: no further edits until the conductor reassigns.

Also declare on the agent-os board (`agent-os board declare --join-session <your session id>`), and leave the board entry on completion.
