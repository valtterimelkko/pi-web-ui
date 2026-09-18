# Track L — client presentation wiring & app reachability (Wave 3 closeout)

**Role:** correction child. The independent review Track R
(`/root/voice-exec-20260917/coordination/R/complete.md`) found the delivered voice surface does not
work end-to-end in the way the contract requires. The conductor confirmed the code sites. Your job:
make the client surface honest and reachable, **in the client only**.

**Worktree:** `/root/pi-web-ui-wt-corr-client` · **Branch:** `fix/voice-corr-client`
**Base:** `master` @ `edccdbe` (contract E, kernel A, audit D, bridge B, client C, regression G,
mount F, rollout H).

**Owned paths (write only these):** `client/src/**` (including its colocated tests and
`client/src/dev/**`), `operations/voice-live-20260917/evidence/L/**`.
**Do NOT touch:** `server/**`, `shared/**`, `scripts/**`, `docs/**`, `operations/**` outside `evidence/L/`.
Track K is working in the server in parallel — never edit anything under `server/`.

**Report:** `/root/voice-exec-20260917/coordination/L/complete.md` (never create it before you are done);
genuine blockers: `NN-questions.md` + `PARENT-INPUT-NEEDED`.

## Findings to close

### 1. H3-client (HIGH) — the card's confirm path is dead, and "presented" is decorative
`DriveModeVoiceLive` (`client/src/components/DriveMode/DriveModeVoiceLive.tsx`) is real, but:
- nothing wires `onReadBack`, so the "Read it back" button never renders, `reportPresentation` is
  never called, `presentationStatus()` stays `'pending'`, and the typed **Confirm button is
  permanently disabled**;
- `ProposalCard` fires `onPresentationReport?.(true)` **synchronously on click** — even where wired,
  "completed" would mean "I clicked", not "the read-back played".
Contract §4.3/§4.6 + intent §18.2: a release requires one currently **presented** proposal; the
composed draft is read back in full before confirmation.
**Required outcome:**
- The read-back button exists and **actually plays** the composed text aloud (browser speech
  synthesis is acceptable and preferred for the local rendering; if the lane provides an audio
  route, use it). `reportPresentation({ completed: true, … })` fires **only after playback
  completes** — wire it to the playback's `onend`/completion, never the click.
- Before presentation completes, the typed Confirm stays disabled (the visible bug disappears once
  the flow is real).
- The typed confirm carries the `proposalRef` echo (version + sha256 — the controller machinery
  already exists; wire it). Track K is making the server enforce the echo; your client must send it.
- Tests: component-level tests proving Confirm disabled → read-back → playback completes → Confirm
  enabled → confirm sends the echo; a test proving a click alone does NOT report completion.

### 2. M7 (MEDIUM) — the surface must be reachable for the operator (Phase 7 prerequisite)
`DriveModeVoiceLive` is imported only by the dev lab page; no phase owns wiring it into the app, so
the operator cannot dogfood it.
**Required outcome:** mount it where the voice lane lives in the app (Drive Mode), with an honest
**unavailable state** when the lane cannot start (server in cascade mode / engine unreachable / no
caps) — a failed lane start must never break the existing Drive Mode UI, and must be visibly
explained rather than silent. Keep the diff minimal; do not restyle unrelated components. Test the
unavailable state.

### 3. M8-client (MEDIUM) — transport-level refusals must render
`interpretInbound` (`client/src/lib/voiceLive/messages.ts:398-410`) runs the envelope check on
server→client frames and drops an empty-`laneId` refusal as `voice_message_malformed` — precisely
the over-budget notice the server sends when a frame carried no envelope.
**Required outcome:** transport-level refusals (e.g. rate refusals) render honestly even without a
lane envelope; malformed frames that are genuinely malformed still refuse. Test both.
(Track K is fixing the server side to send an acceptable envelope — defensive tolerance here is
still wanted.)

## Gates

```bash
cd /root/pi-web-ui-wt-corr-client
npm run typecheck                       # repo root
npm run build --workspace=shared && npm run build --workspace=client
npm run test --workspace=client         # full client suite
npx playwright test <your spec>         # real browser: the flow below
```
**Playwright evidence (required):** a real browser run proving the card flow against the real
component tree (the dev lab page or a test page is fine, stubs at the transport seam are fine):
read-back plays → presentation reported after playback → Confirm enabled → typed confirm sends the
echo; plus the unavailable state rendering when the lane is down. Save screenshots + the console log
under `operations/voice-live-20260917/evidence/L/` and reference them in the handback.

Do not run `npm install` anywhere (the worktree is already isolated; use it as-is). Commit on
`fix/voice-corr-client`; do not push (the conductor merges).

**Handback:** `coordination/L/complete.md` with: per-finding status (closed / not closed + why), the
proof test for each, exact gate commands + exit codes, the Playwright evidence paths, deliberate
deviations, and honest gaps.
