# Drive Mode

> Drive Mode is a shipped frontend feature.

## What It Is

Drive Mode is a distraction-reduced, voice-first overlay for Pi Web UI. It is designed for quick session creation or continuation without exposing the full chat surface.

Typical flow:

1. open Drive Mode
2. choose **new** or **continue**
3. pick a model or existing session
4. dictate a prompt
5. wait while the agent works
6. optionally use read-aloud

## Talking to your agent (Voice Mode)

When you dictate, your words go to a helper agent (the *talker*) — never straight to the working session:

- your words are passed on as spoken — tidied only when they ramble, never rewritten;
- the worker never knows the talker or your voice exists — it just receives an instruction;
- before anything reaches the worker, a confirmation card shows the exact text that will be sent. When the tidying changed your words, the card says so, shows the fragments it took out, and offers **Send my exact words** — your original wording instead of the tidied relay. When nothing visible changed it makes no tidy claim at all. **Confirm** sends the tidied text, **Cancel** drops it, and typed text replies to the talker instead.

## Layout modes, lanes and switching workers

Voice Mode has two layout modes, chosen by the operator and remembered per browser
(`pi-voice-mode-layout`):

- **Mobile** — the original voice-only surface. Full height, no session pane.
- **Desktop** — the same voice block (lane strip plus the addressed worker's
  controls), with the **live session as a bottom panel of the same column**
  (about a quarter of the window, minimum 150px). The pane is the *real* session
  view: it renders the shared `VirtualizedMessageList` from the same session
  store as the chat screen, so tool calls group, skills collapse and verbosity
  matches the normal session view exactly.
  A desktop preference on a window narrower than 1024px degrades to the mobile
  surface rather than squeezing both.

Up to **three lanes** may be held in one tab. A lane is another worker session; the
lane strip shows each lane's floor state, switches which worker you are addressing
with one tap, and the cap is always visible ("2 of 3"). At the cap the "+" asks
rather than silently adding a fourth lane.

**Switch session** re-points a voice surface at a different worker *in place*: from
the addressed surface, or from any lane's row. The picker opens over the mounted
lanes (the phase never changes, so capture, cards and focus survive), only that
lane's session is swapped, and the lane keeps its order and slot.

## Key Files

### UI
- `client/src/components/DriveMode/DriveModeOverlay.tsx` — full-screen overlay, phase routing, the one-column layout and the lane set
- `client/src/components/DriveMode/LaneStrip.tsx` — lane rows, addressing, switching, closing, the cap
- `client/src/components/DriveMode/DriveModeSessionPane.tsx` — the live session pane (shared session list)
- `client/src/components/DriveMode/voiceLayout.ts` / `useVoiceLayout.ts` — the persisted layout mode and the resolved arrangement
- `client/src/components/DriveMode/DriveModeEntry.tsx` — entry chooser
- `client/src/components/DriveMode/DriveModeModelPicker.tsx` — model selection
- `client/src/components/DriveMode/DriveModeFolderPicker.tsx` — folder selection for new sessions
- `client/src/components/DriveMode/DriveModeSessionPicker.tsx` — continue/switch-session picker
- `client/src/components/DriveMode/DriveModeDictate.tsx` — dictation / read-aloud control surface
- `client/src/components/DriveMode/driveModeModels.ts` — curated model list

### State and hooks
- `client/src/store/driveModeStore.ts` — Drive Mode state machine
- `client/src/store/uiStore.ts` — overlay open/close flag
- `client/src/hooks/useDriveModeDictation.ts` — prompt send flow for dictated input

### App integration
- `client/src/App.tsx` — mounts the overlay
- `client/src/components/Navigation/IntegratedHeader.tsx` — Drive Mode entry point
- `client/src/components/Navigation/BottomNav.tsx` — mobile entry point
- `client/src/components/Chat/ChatView.tsx` / `client/src/components/Sidebar/Sidebar.tsx` / `client/src/components/Session/NewSessionModal.tsx` — additional open triggers

## Why It Matters For Debugging

Drive Mode can look like a separate product flow, but it still relies on the same backend session creation and prompt dispatch paths as the rest of the app. When debugging it:

- check the Drive Mode store and overlay first
- then check the ordinary WebSocket/session creation flow
- do **not** assume it has a separate backend path
- for dictation/read-aloud failures, check the `/api/dictation` or `/api/tts` response and provider configuration; the E2E suite treats provider availability as an explicit prerequisite rather than pretending an unavailable provider is a UI regression
- read-aloud uses browser audio permissions/user-gesture handling, so a generated TTS response can still fail to play until the operator taps the control again
