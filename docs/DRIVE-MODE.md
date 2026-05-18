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

## Key Files

### UI
- `client/src/components/DriveMode/DriveModeOverlay.tsx` — full-screen overlay and phase routing
- `client/src/components/DriveMode/DriveModeEntry.tsx` — entry chooser
- `client/src/components/DriveMode/DriveModeModelPicker.tsx` — model selection
- `client/src/components/DriveMode/DriveModeFolderPicker.tsx` — folder selection for new sessions
- `client/src/components/DriveMode/DriveModeSessionPicker.tsx` — continue-session picker
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
