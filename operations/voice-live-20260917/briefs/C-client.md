# Brief C — client voice surface + shared contracts (plan Phase 4 = Track C)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-track-c` (branch `feat/voice-client`, based on master **after the wire contract merges**). **Runtime:** pi. **Model:** assigned at dispatch (deepseek-v4.1-flash pool rotation); thinking `high` (no `max` needed).

## Bounded outcome

The **client voice surface**: AudioWorklet capture/playback, the speech arbiter's ducking rules, out-of-band delivery chimes, the proposal card and parking-lot UI, wired to the frozen wire contract — with unit tests and a real Playwright ducking check.

## Read first

- `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` **— frozen; your message handling matches it exactly.**
- `docs/VOICE-MODE-EXECUTION-PLAN.md` Phase 4 (your tasks and gate).
- `docs/VOICE-MODE-INTENT.md` §9 (speech policy — ducking, never stopping; capture is unconditional), §16 (the four objects), §20 (capture modes; push-to-talk retained as fallback), §18.2 (read-back rule).
- Existing client code you must respect: `client/src/lib/speechArbiter.ts` (**never add capture authority**), `client/src/lib/talkerBus.ts` (bus pattern), `client/src/lib/websocket.ts`, `client/src/components/DriveMode/` (ConfirmationCard, DriveModeDictate, useVoiceTurn — the shipped surface your new components sit beside).

## Deliverables

Owned paths: `client/src/lib/voiceLive/**` (new), `client/src/lib/speechArbiter.ts`, `client/src/lib/soundEffects.ts` (new), `client/src/components/DriveMode/{DriveModeVoiceLive,ProposalCard,ParkingLotDrawer}.tsx` (new), plus their tests (`client/src/**/*.test.ts(x)` for the new units), and the Playwright spec. **Minimal integration edits** to existing client transport wiring are permitted **only if strictly necessary** — list every one in the handback. NO-TOUCH: `server/**`, `shared/**` (the contract file is frozen; a needed change is a question), other DriveMode components unless a surgical integration edit is unavoidable.

1. **Typed client message layer** matching the contract: send `voice_audio_chunk`, `voice_activity_state`, `proposal_confirm` (proposalId + variant + idempotencyKey only), `proposal_cancel`, `parking_promote`, session lifecycle; receive `voice_audio_chunk`, `transcript_delta`, `proposal_created`, `proposal_resolved`, `receipt_event`, `parking_updated`, state/error. Version/unknown handling fails closed and surfaces visibly.
2. **AudioWorklet capture/playback** (`client/src/lib/voiceLive/`): 16 kHz PCM capture with bounded buffers and overflow protection; 24 kHz playback with one-ahead scheduling (preserve the no-eaten-first-words property); glitch-free under load.
3. **Speech arbiter**: keep the priority ladder and no-capture-authority rule; **duck to ≈15% volume while the operator speaks and resume at chunk boundaries** (duck, never stop); keep all existing arbiter tests green.
4. **Out-of-band chimes** (`soundEffects.ts`): a distinct, host-owned delivery chime played on `proposal_resolved { outcome: "delivered" }` — a local asset/generated tone, **never model-generated audio**. Also a refused/unknown variant if the contract defines one.
5. **UI**: `DriveModeVoiceLive` (open-mic default with push-to-talk fallback and an honest "listening suspended" state), `ProposalCard` (original/tidied variants, presented-vs-stale visible, hash/id shown, confirm/cancel wired to typed messages), `ParkingLotDrawer` (list + one-tap single-item promotion; no batch send).
6. **Tests**: unit tests for the message layer, worklet buffer management, arbiter ducking rules, chime triggering; **a Playwright browser test proving ducking occurs when microphone activity begins** (use the repo's `@playwright/test` setup; if a running app is needed, serve the built client — keep it self-contained in your worktree).

## Gate 4 (run and record)

```bash
npm run build --workspace=shared && npm run build --workspace=client
npm --prefix /root/pi-web-ui-track-c/client test -- src/lib/speechArbiter.test.ts
```

Both exit 0; Playwright ducking spec passes with evidence (screenshot/log lines of volume before/during/after operator speech).

## Anti-cheat and constraints

- Ducking evidence must be a real browser run, not a unit-mocked assertion.
- No change may give the client a send path or the arbiter capture authority (N5, N1).
- No secrets; no model-generated audio; no silent behaviour widening of the gate.

## Contract decisions you must honour (from the frozen v1 contract and its independent review)

- **The chime fires on `receipt_event` with `outcome: "delivered"` and nothing else** (contract §8.1 — this supersedes the plan's Phase 4 wording that named `proposal_resolved`; Phase 3's message list and N6 agree with the contract).
- Use the shared module's runtime guards for envelope/message validation; do not hand-roll validators. Client→server frames are schema-exact (unwritten fields refused).
- `proposal_created` nests its payload under `proposal`; `receipt_event` nests under `receipt`; the catalogue also carries `proposal_presentation`, `parking_list`, `voice_state`, `voice_error` beyond the plan's minimum.
- You add the `voice-messages` re-export to `shared/src/index.ts` (deliberately left to Track C by the contract) — an additive edit only, and the one shared/ change you own.

## Stop protocol

Blocked or a contract conflict → `/root/voice-exec-20260917/coordination/C/01-questions.md`, print `PARENT-INPUT-NEEDED`, end turn.

## Handback

Commit on `feat/voice-client`. `/root/voice-exec-20260917/coordination/C/complete.md`: outcome; changed-path inventory (including every integration edit to existing files); gate commands + observed results; Playwright evidence summary; `FROZEN` marker. Declare on the agent-os board; leave the entry on completion.
