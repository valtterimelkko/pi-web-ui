# Drive Mode

> **Class:** canonical shipped-feature doc. **Status:** current. **Last verified:** 2026-09-17. **Corpus:** Voice Mode — see [`VOICE-MODE-INDEX.md`](./VOICE-MODE-INDEX.md).
>
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
lane's session is swapped, and the lane keeps its order and slot. Both controls
are **named** — the lane row carries a labelled “Switch”, the surface a
“Switch session” button next to the worker's name — because an icon-only glyph
was not findable (operator, 2026-09-16).

### Which lane speaks, and when

Every lane is a mounted voice surface, so **every lane speaks at its own turn
end, whichever lane is selected** — the spoken answers queue through the one
shared voice and are played one at a time. Non-addressed lanes are visually
hidden (`invisible pointer-events-none`) but stay mounted, and their session's
streaming state is tracked, so their readers still fire.

The reading level is **per session**: setting Headlines while addressing one lane
sets *that lane's* level, not a global one (a lane with no choice reads at the
shared default). The “already spoken” record (`client/src/lib/spokenLedger.ts`) is scoped **per lane**
via `contentScopeFor`: two workers answering with the same words are two events and
both speak, while within one lane the auto path and read-aloud still share a record
and never say the same answer twice.

### What is never spoken

Routine Agent OS injections — the automated session-end memory capture — are
**structurally marked at their source**: the capture prompt arrives as a pi custom
message carrying `customType: 'agent-os-capture'` (emitter
`agent-os-inject` in the `pi-enhancement` repo; kill switch
`AGENT_OS_INJECT_CAPTURE_MARKING=0`), not as a user message. The spoken-turn scan
in `client/src/components/DriveMode/useAnswerReader.ts` treats a marked injection
as an **upper bound**: the housekeeping turn it triggers is never read aloud,
while the operator's own work between their words and the injection still is.

The match is **structural** — `role === 'custom' && customType ===
'agent-os-capture'`, never a text heuristic — so an operator prompt that quotes
the injection wording verbatim is still spoken. The packet lane's separate
`agent-os` type rides *inside* the operator's turn and is deliberately **not** a
boundary, and no other extension's custom message can silence a turn (operator
decision, 2026-09-16). Because every rendered projection drops `role: 'custom'`
entries, the capture prompt no longer shows as a user bubble in the session view;
the assistant's answer about the capture still does. The operator confirmed this on
2026-09-16 as the intended behaviour — **leave it invisible**, rather than render a
housekeeping line — so this is a decision, not an oversight.

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
