# Track L evidence — client voice surface honesty & reachability (Wave 3)

**Branch:** `fix/voice-corr-client` · **Worktree:** `/root/pi-web-ui-wt-corr-client`
**Findings closed:** H3-client (read-back + presentation + confirm echo), M7 (app mount +
honest unavailable state), M8-client (transport-level refusals render).

This directory holds the committed proof. Everything here was produced by the commands in
`/root/voice-exec-20260917/coordination/L/complete.md`; no artefact is hand-written except the
`.txt` gate logs (direct command output).

## What is REAL in the browser evidence

* the **REAL product component tree**: `DriveModeVoiceLive` → `ProposalCard` bound to the
  real `VoiceLiveSurface` + `VoiceLiveController` (mounted by `client/src/dev/voiceLiveLab.tsx`);
* the real read-back path: `VoiceLiveSurface.readBackProposal` → the host's speech synthesis
  → `controller.reportPresentation` (the only call site that can report presentation);
* the real contract frames: `proposal_created`, `proposal_confirm`, `proposal_presentation`,
  the cascade server's `voice_state {error}` + fatal `voice_error`, and the rate limiter's
  lane-less `voice_error` — the exact bytes `server/src/websocket/connection.ts` and the mount send;
* a real Chromium browser over HTTP, real AudioWorklet capture path, real virtual microphone.

## What is SUBSTITUTED (disclosed)

| Substituted | Why | Where |
|---|---|---|
| The operating system's microphone | headless Chromium has no device | lab's virtual microphone (same substitution Track C's ducking spec uses) |
| The operating system's speech service | headless Chromium has no speech backend, so a real utterance never fires `onend` | `addInitScript` in `tests/e2e/voice-live-presentation.spec.ts`: a genuine `speechSynthesis` surface whose `speak()/cancel()` the PRODUCT calls, and whose `onend`/`onerror`/`onboundary` callbacks the product depends on — only the timing is ours |

Nothing about the product's wiring is stubbed: the spec asserts what was submitted to the
speech API, when the presentation report left the client, and what the confirm frame carried.

## Files

| File | What it proves |
|---|---|
| `01-typecheck-scoped.txt` | `npm run typecheck --workspace=shared` and `--workspace=client`: exit 0 / 0 |
| `02-typecheck-root-server-preexisting.txt` | `npm run typecheck` (root) fails on **pre-existing** `server/src/routes/*` zod errors — reproduced with Track L's changes stashed (identical output), so it is not Track L's |
| `03-build.txt` | `build --workspace=shared` exit 0; `build --workspace=client` exit 0 |
| `04-client-suite.txt` | full client suite: 144 files / 1601 tests passed, exit 0 |
| `05-playwright-spec.txt` | `npx playwright test --config playwright.voice-live-presentation.config.ts`: 5 passed, exit 0 |
| `browser-console.log` | the browser console/page errors from the evidence run (no page errors) |
| `card-flow.json` | the flow's own frames: spoken text, one `proposal_presentation {completed:true}`, and the `proposal_confirm` carrying `proposalRef {version, sha256}` |
| `L1-pending-confirm-disabled.png` | a proposal that has not been read back: status `pending`, Confirm disabled |
| `L2-reading-in-flight.png` | read-back playing (`data-reading="true"`), still `pending`, still disabled, **no** report sent |
| `L3-presented-confirm-enabled.png` | after playback ended: `presented`, Confirm enabled |
| `L4-click-is-not-a-presentation.png` | an utterance that never ends leaves the proposal unconfirmable (900 ms after the click) |
| `L5-unavailable-cascade.png` / `-full.png` | the cascade server's own reason rendered in place, with a retry, and the surface otherwise intact |
| `L6-unavailable-unreachable.png` | a lane start that is never answered becomes honestly unavailable ("no answer from the voice engine") |
| `L7-transport-refusal[-full].png` | the lane-less rate refusal rendered, and NOT shown as a lane error/refusal |
| `unavailable-state.json` | the lane state, the `voice_session_start` frame and the server's fatal error for the cascade case |

## Honest gaps in this evidence

* **Audibility is not measured.** This host has no OS-output oracle (the same limitation the
  ducking lab records). What is proven is that the exact composed bytes were submitted to the
  browser's speech API and that "presented" is reported only from that utterance's end event —
  not that a human heard it. Real-ear acceptance remains the operator's Gate 7.
* **The real OS voice engine** was not exercised (only the deterministic stand-in above).
* **No live server socket** was used: the lab uses the transport seam. The composed
  browser↔server loop remains Gate 5's scripted-client artefact; the app-socket route itself
  is unit-tested (mocked socket) in `frameBus.test.ts`, `NativeVoiceLane.test.tsx` and
  `DriveModeDictate.native-lane.test.tsx`.
