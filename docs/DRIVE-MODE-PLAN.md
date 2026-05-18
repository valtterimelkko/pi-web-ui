# Drive Mode — Historical Execution Plan

> **Status:** Implemented. This file is retained as historical planning/reference material; use [`DRIVE-MODE.md`](./DRIVE-MODE.md) for the current feature overview.
> **Scope:** Frontend-only feature (zero backend changes)
> **Branch strategy:** Single feature branch `feature/drive-mode` from current HEAD. All tasks commit to this branch. Agents work in parallel worktrees where noted, merged back via squash.

---

## Table of Contents

1. [Feature Summary](#1-feature-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Module Dependency Graph](#3-module-dependency-graph)
4. [Module Specification: Frontend](#4-frontend-modules)
5. [Module Specification: Backend](#5-backend-modules)
6. [Integration Points](#6-integration-points)
7. [Testing Plan](#7-testing-plan)
8. [Edge Cases](#8-edge-cases)
9. [Git Strategy](#9-git-strategy)
10. [Acceptance Criteria](#10-acceptance-criteria)

---

## 1. Feature Summary

Drive Mode is a full-screen, distraction-free overlay that turns Pi Web UI into a voice-first, hands-off interface. The user activates it via a steering-wheel button in the header, the entire UI is replaced by a large, high-contrast screen with very few touch targets.

**Core loop:** Speak → Send → Listen. No chat messages displayed. No tool output. Just large buttons and status text.

**Wizard flow:**
1. **Entry** — Choose "New Session" or "Continue Session"
2. **Model Pick** (new session path) — Pick from 4 pre-selected models
3. **Session Pick** (continue path) — Pick from active sessions
4. **Dictate** — Main loop: press to speak, press again to send. Agent works. When done, Read Aloud appears.

---

## 2. Architecture Overview

### State Machine

```
ENTRY ──┬── "New Session" ──────► MODEL_PICK ──► DICTATE (after session created)
        │                                         │
        └── "Continue Session" ──► SESSION_PICK ──┘
                                                   │
                                          ┌────────┘
                                          ▼
                                    AGENT_WORKING
                                          │
                                    agent_end event
                                          │
                                          ▼
                                    READ_ALOUD_READY
                                          │
                           ┌──────────────┼──────────────┐
                           ▼              ▼               ▼
                      (read aloud)   (speak again)   (exit)
                           │              │
                           ▼              ▼
                      AUDIO_PLAYING    DICTATE
                           │
                     audio ends / stop
                           │
                           ▼
                        DICTATE
```

### File Map

```
client/src/
├── components/
│   ├── DriveMode/                    ← NEW directory
│   │   ├── index.ts                  ← barrel export
│   │   ├── DriveModeOverlay.tsx      ← full-screen overlay shell + phase routing
│   │   ├── DriveModeEntry.tsx        ← entry screen (New / Continue)
│   │   ├── DriveModeModelPicker.tsx  ← 4-option model selector
│   │   ├── DriveModeSessionPicker.tsx← simple session list
│   │   ├── DriveModeDictate.tsx      ← mic button + status + read aloud controls
│   │   └── driveModeModels.ts        ← model definitions (pure data, no React)
│   └── Navigation/
│       ├── IntegratedHeader.tsx       ← MODIFY: add Drive Mode button
│       └── BottomNav.tsx             ← MODIFY: add Drive Mode entry on mobile
├── hooks/
│   ├── useDictation.ts              ← MODIFY: export start/stop separately
│   └── useDriveModeDictation.ts     ← NEW: dictation variant that sends prompt directly
├── store/
│   ├── driveModeStore.ts            ← NEW: Zustand store for overlay state
│   └── uiStore.ts                   ← MODIFY: add driveModeOpen state + actions
└── App.tsx                          ← MODIFY: mount DriveModeOverlay

client/tests/unit/
├── store/
│   └── driveModeStore.test.ts       ← NEW
├── hooks/
│   └── useDriveModeDictation.test.ts← NEW
└── components/
    └── DriveMode/
        ├── DriveModeOverlay.test.tsx ← NEW
        ├── DriveModeEntry.test.tsx   ← NEW
        ├── DriveModeModelPicker.test.tsx ← NEW
        ├── DriveModeSessionPicker.test.tsx ← NEW
        └── DriveModeDictate.test.tsx ← NEW
```

### Pre-Selected Models (hardcoded in `driveModeModels.ts`)

| Display Name | Model ID | SDK Type |
|---|---|---|
| Kimi for Coding | `kimi-for-coding` | `pi` |
| GLM-5.1 | `zai-coding-plan/glm-5.1` | `opencode` |
| Codex / GPT-5.4 | `codex/gpt-5.4` | `pi` |
| Codex / GPT-5.5 | `codex/gpt-5.5` | `pi` |

---

## 3. Module Dependency Graph

```
Layer 0 (no dependencies — can start immediately, in parallel):
  ├── A. driveModeStore.ts
  ├── B. driveModeModels.ts
  └── C. useDictation.ts modifications (export start/stop)

Layer 1 (depends on Layer 0):
  ├── D. useDriveModeDictation.ts (depends on C)
  ├── E. uiStore.ts changes (depends on A for type awareness)
  └── F. driveModeStore tests (depends on A)

Layer 2 (depends on Layer 1):
  ├── G. DriveModeEntry.tsx (depends on A, B)
  ├── H. DriveModeModelPicker.tsx (depends on A, B)
  ├── I. DriveModeSessionPicker.tsx (depends on A)
  └── J. DriveModeDictate.tsx (depends on A, D)

Layer 3 (depends on Layer 2):
  ├── K. DriveModeOverlay.tsx (depends on G, H, I, J)
  └── L. Component tests for G, H, I, J

Layer 4 (depends on Layer 3):
  ├── M. IntegratedHeader.tsx changes (depends on A, K)
  ├── N. BottomNav.tsx changes (depends on A, K)
  └── O. App.tsx changes (depends on K)

Layer 5 (depends on Layer 4):
  ├── P. DriveModeOverlay.test.tsx (integration-level)
  └── Q. Final lint/typecheck/build verification
```

### Parallelisation Summary

| Parallel Group | Tasks | Notes |
|---|---|---|
| **Group 1** (all in parallel) | A, B, C | No dependencies between them |
| **Group 2** (all in parallel) | D, E, F | D depends on C; E depends on A; F depends on A |
| **Group 3** (all in parallel) | G, H, I, J | Each depends on different Layer 1 outputs |
| **Group 4** (all in parallel) | K, L | K depends on all Layer 2; L can start as Layer 3 components land |
| **Group 5** (sequential) | M, N, O | Small integration touches, can be one commit |
| **Group 6** | P, Q | Final verification |

---

## 4. Frontend Modules

### Module A: `client/src/store/driveModeStore.ts`

**Purpose:** Zustand store managing Drive Mode overlay state.

**Dependencies:** None (Layer 0).

**State shape:**

```typescript
export type DriveModePhase =
  | 'entry'
  | 'model-pick'
  | 'session-pick'
  | 'dictate'
  | 'agent-working'
  | 'read-aloud-ready'
  | 'audio-playing';

export interface DriveModeModel {
  id: string;
  displayName: string;
  sdkType: 'pi' | 'claude' | 'opencode';
}

interface DriveModeState {
  isOpen: boolean;
  phase: DriveModePhase;
  selectedModelId: string | null;
  activeSessionId: string | null;
  lastAssistantText: string | null;

  open: () => void;
  close: () => void;
  setPhase: (phase: DriveModePhase) => void;
  selectModel: (modelId: string) => void;
  setActiveSession: (sessionId: string) => void;
  setLastAssistantText: (text: string | null) => void;
  reset: () => void;
}
```

**Implementation notes:**
- Use `zustand` with `create` (no persist — Drive Mode state resets on page load).
- `open()` sets `isOpen: true`, `phase: 'entry'`, clears all other fields.
- `close()` sets `isOpen: false`, clears all fields.
- `reset()` clears to entry state but keeps `isOpen: true` (used when user goes "Back").
- Export `DRIVE_MODE_MODELS: DriveModeModel[]` constant array with the 4 pre-selected models.

**File also creates:** `client/src/components/DriveMode/driveModeModels.ts` — separate pure-data file with the model definitions. The store imports from this file.

**Testing:** See Module F.

---

### Module B: `client/src/components/DriveMode/driveModeModels.ts`

**Purpose:** Pure data file with pre-selected model definitions.

**Dependencies:** None (Layer 0).

**Contents:**

```typescript
import type { DriveModeModel } from '../../store/driveModeStore';

export const DRIVE_MODE_MODELS: DriveModeModel[] = [
  {
    id: 'kimi-for-coding',
    displayName: 'Kimi for Coding',
    sdkType: 'pi',
  },
  {
    id: 'zai-coding-plan/glm-5.1',
    displayName: 'GLM-5.1',
    sdkType: 'opencode',
  },
  {
    id: 'codex/gpt-5.4',
    displayName: 'Codex / GPT-5.4',
    sdkType: 'pi',
  },
  {
    id: 'codex/gpt-5.5',
    displayName: 'Codex / GPT-5.5',
    sdkType: 'pi',
  },
];
```

**Testing:** Simple constant assertion test — verify array length is 4, verify each model has required fields, verify no duplicate IDs.

---

### Module C: `client/src/hooks/useDictation.ts` — Modifications

**Purpose:** Export `startRecording` and `stopRecording` as named functions in addition to `toggle`, so Drive Mode can control recording start/stop independently.

**Dependencies:** None (Layer 0).

**Changes:**
1. The current `startRecording` and `stopRecording` callbacks are already `useCallback`-wrapped but not exposed. Add them to the return object:

```typescript
return { state, errorMessage, toggle, startRecording, stopRecording };
```

2. No other changes to the hook. The existing `toggle` function remains for backward compatibility. `DictationButton.tsx` continues using `toggle`.

**Testing:** Existing tests for `useDictation` should still pass. No new tests needed — the functions were already internal and are now just exposed.

---

### Module D: `client/src/hooks/useDriveModeDictation.ts`

**Purpose:** A thin wrapper around `useDictation` that sends the transcript directly as a prompt instead of putting it in the draft store. This is the key behavioral difference for Drive Mode.

**Dependencies:** Module C (needs `useDictation` to expose `startRecording`/`stopRecording`).

**Implementation:**

```typescript
import { useCallback } from 'react';
import { useDictation } from './useDictation';
import { useWebSocket } from './useWebSocket';

export function useDriveModeDictation(sessionId: string | null) {
  const { sendPrompt } = useWebSocket();

  const handleTranscript = useCallback((text: string) => {
    if (sessionId) {
      sendPrompt(text);
    }
  }, [sessionId, sendPrompt]);

  const dictation = useDictation(handleTranscript);

  return {
    state: dictation.state,
    errorMessage: dictation.errorMessage,
    startRecording: dictation.startRecording,
    stopRecording: dictation.stopRecording,
    toggle: dictation.toggle,
  };
}
```

**Key difference from normal dictation:** `handleTranscript` calls `sendPrompt(text)` directly instead of going through `setDraft()`. The text is sent to the agent immediately with no edit step.

**Testing:** See testing plan section.

---

### Module E: `client/src/store/uiStore.ts` — Modifications

**Purpose:** Add `driveModeOpen` state to the existing UI store so other components (header, bottom nav) can react to it.

**Dependencies:** Module A (for type reference only — no runtime import needed).

**Changes to `uiStore.ts`:**

1. Add to the `UIState` interface:

```typescript
driveModeOpen: boolean;
openDriveMode: () => void;
closeDriveMode: () => void;
```

2. Add to the store implementation:

```typescript
driveModeOpen: false,
openDriveMode: () => set({ driveModeOpen: true }),
closeDriveMode: () => set({ driveModeOpen: false }),
```

3. In `DriveModeOverlay`, use `driveModeStore` directly (not uiStore) for the main state machine. But `uiStore.driveModeOpen` is the canonical "is the overlay showing" flag that the header button toggles.

**Alternative considered:** Put everything in `driveModeStore` and don't touch `uiStore`. But `uiStore` is already the convention for modal/overlay open states (settingsOpen, modelSelectorOpen, etc.). Keeping it there is consistent.

**Testing:** Add tests to existing `uiStore` test file if one exists, or add assertions in the driveModeStore test.

---

### Module G: `client/src/components/DriveMode/DriveModeEntry.tsx`

**Purpose:** Entry screen showing two large buttons: "New Session" and "Continue Session".

**Dependencies:** Module A (store), Module B (models — not directly, but the store re-exports).

**Props:**

```typescript
interface DriveModeEntryProps {
  onNewSession: () => void;
  onContinueSession: () => void;
}
```

**Layout:**
- Centered vertically and horizontally.
- App title/logo at top: "Pi Drive Mode" in text-2xl font-bold.
- Subtitle: "Voice-first, hands-free" in text-gray-500.
- Two large rounded-rect buttons, ~80% width, min-h-16:
  - **"New Session"** — blue bg, white text. Calls `onNewSession`.
  - **"Continue Session"** — gray bg with border, gray-700 text. Calls `onContinueSession`. Disabled if no active sessions exist (check `sessionStore.sessions.length`).
- Exit button at bottom: "Exit Drive Mode" in text-sm text-gray-400.

**Accessibility:**
- `aria-label` on both buttons.
- Focus management: auto-focus "New Session" on mount.

---

### Module H: `client/src/components/DriveMode/DriveModeModelPicker.tsx`

**Purpose:** Shows 4 pre-selected model cards as a vertical radio group.

**Dependencies:** Module A, Module B.

**Props:**

```typescript
interface DriveModeModelPickerProps {
  onSelect: (model: DriveModeModel) => void;
  onBack: () => void;
}
```

**Layout:**
- Title: "Choose a Model" in text-xl font-semibold, centered.
- 4 model cards stacked vertically, ~90% width:
  - Each card: rounded-xl border-2, p-4.
  - Selected state: border-blue-500 bg-blue-50.
  - Unselected: border-gray-200.
  - Content: model display name (text-lg font-medium) + SDK badge (small pill: "Pi" in blue, "OC" in emerald).
  - Tap to select (radio behavior — only one selected at a time).
- Footer: "Back" button (left), "Create Session" button (right, disabled until model selected).

**Behavior:**
- Internal `useState` for selected model ID.
- On "Create Session" tap: calls `onSelect(selectedModel)`.
- The parent (DriveModeOverlay) handles the actual session creation + model setting.

---

### Module I: `client/src/components/DriveMode/DriveModeSessionPicker.tsx`

**Purpose:** Shows active (non-archived) sessions as a simple tappable list.

**Dependencies:** Module A.

**Props:**

```typescript
interface DriveModeSessionPickerProps {
  onBack: () => void;
  onSelectSession: (sessionId: string, sessionPath: string) => void;
}
```

**Layout:**
- Title: "Continue a Session" in text-xl font-semibold, centered.
- Scrollable list, max-h-[70vh]:
  - Each row: rounded-lg border p-4, tap to select.
  - Content: session display name (or firstMessage truncated to 50 chars, or "New session"), model name in text-sm text-gray-500, SDK badge.
  - Active session (matching `currentSessionId`) gets a subtle blue left border.
- Empty state: "No active sessions" message.
- Footer: "Back" button.

**Data source:** Read `sessions` from `useSessionStore`, filter out archived ones (check against `archivedSessionPaths`). Also filter out sessions with no `path` (defensive).

**Behavior:**
- On session tap: calls `onSelectSession(session.id, session.path)`.
- The parent handles `switchSession` + phase transition.

---

### Module J: `client/src/components/DriveMode/DriveModeDictate.tsx`

**Purpose:** The main Drive Mode screen — mic button, status text, and read aloud controls.

**Dependencies:** Module A (store), Module D (dictation hook), Module E (uiStore for read aloud).

**Props:**

```typescript
interface DriveModeDictateProps {
  sessionId: string;
  modelName: string;
  sessionDisplayName: string;
  onExit: () => void;
}
```

**Layout:**

```
┌─────────────────────────────────────────────┐
│  [X Exit]                                   │  ← top-right, small
│                                             │
│         Session Name  (text-lg font-medium) │
│         model-name    (text-sm text-gray-500│
│                                             │
│                                             │
│              ┌─────────────┐                │
│              │             │                │
│              │  🎤 MIC    │                │  ← ~120px circle
│              │   BUTTON   │                │
│              │             │                │
│              └─────────────┘                │
│                                             │
│            "Tap to speak"                   │  ← status text, centered
│                                             │
│      ┌──────────┐    ┌──────────┐           │
│      │ 🔊 Read  │    │ ⏩ 1.25x │           │  ← only when phase is read-aloud-ready
│      │   Aloud  │    │          │           │     or audio-playing
│      └──────────┘    └──────────┘           │
│                                             │
└─────────────────────────────────────────────┘
```

**State management:**

1. **Mic button** uses `useDriveModeDictation(sessionId)`.
   - `idle` / `error` → Shows "Tap to speak" label, button is white/blue.
   - `recording` → Shows "Listening..." label, button pulses red ring, `navigator.vibrate(100)` on start.
   - `processing` → Shows "Processing..." label, button shows spinner.

2. **Phase tracking** — watches `isStreaming` from `sessionStore`:
   - When dictation finishes (`stopRecording` returns) → transcript is sent as prompt (handled by `useDriveModeDictation`) → phase transitions to `agent-working`.
   - When `isStreaming` changes from `true` to `false` → agent finished → phase transitions to `read-aloud-ready`.

3. **Read Aloud button** uses `useReadAloud('drive-mode')`:
   - Only visible when phase is `read-aloud-ready` or `audio-playing`.
   - Extracts last assistant message text from `sessionStore.messages` (filter `role === 'assistant'`, take last, extract plain text from content).
   - Calls `readAloud.play(assistantText)`.
   - During playback: button shows "Stop Reading", speed toggle shows "1.25x" or "1x".
   - When audio ends: phase transitions back to `dictate` (ready for next turn).

4. **Speed toggle** uses the same `toggleSpeed()` from `useReadAloud`. Shared singleton state with the normal UI.

5. **Mic re-activation:** User can tap the mic button at any time (even during read-aloud-ready). This stops any playing audio and starts a new dictation cycle.

**Status text mapping:**

| Phase | Dictation State | Status Text |
|---|---|---|
| `dictate` | `idle` | "Tap to speak" |
| `dictate` | `recording` | "Listening..." |
| `dictate` | `processing` | "Processing..." |
| `agent-working` | — | "Agent working..." |
| `read-aloud-ready` | — | "Done — listen or speak" |
| `audio-playing` | — | "Reading aloud..." |

**Assistant text extraction logic:**

```typescript
function getLastAssistantText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p: ContentPart) => p.type === 'text')
          .map((p: ContentPart) => p.text);
        if (textParts.length > 0) return textParts.join('\n');
      }
    }
  }
  return null;
}
```

This should be a shared utility, potentially in `driveModeStore.ts` or a small `client/src/lib/driveModeUtils.ts` file.

---

### Module K: `client/src/components/DriveMode/DriveModeOverlay.tsx`

**Purpose:** Full-screen overlay shell that routes between phase screens.

**Dependencies:** Modules G, H, I, J (all phase components).

**Implementation:**

```typescript
export function DriveModeOverlay() {
  const isOpen = useUIStore((s) => s.driveModeOpen);
  const closeDriveMode = useUIStore((s) => s.closeDriveMode);
  const { phase, close, selectedModelId, activeSessionId } = useDriveModeStore();
  const { createNewSession, switchSession, setModel } = useWebSocket();

  if (!isOpen) return null;

  // Phase routing
  switch (phase) {
    case 'entry':
      return <DriveModeEntry ... />;
    case 'model-pick':
      return <DriveModeModelPicker ... />;
    case 'session-pick':
      return <DriveModeSessionPicker ... />;
    case 'dictate':
    case 'agent-working':
    case 'read-aloud-ready':
    case 'audio-playing':
      return <DriveModeDictate ... />;
  }
}
```

**Session creation flow (model-pick → dictate):**
1. User selects model, taps "Create Session".
2. `DriveModeOverlay` determines `sdkType` from the selected model's `sdkType` field.
3. Calls `createNewSession(undefined, sdkType)` (no CWD specified — uses server default).
4. Waits for `session_created` event (already handled by `sessionStore`).
5. After session is created (watch `currentSessionId` change), calls `setModel(modelId)`.
6. Transitions phase to `dictate`.

**Session continuation flow (session-pick → dictate):**
1. User taps a session.
2. Calls `switchSession(sessionPath)`.
3. After `session_switched` event, transitions phase to `dictate`.

**Close behavior:**
- Calls `closeDriveMode()` (uiStore) + `close()` (driveModeStore).
- Stops any playing audio via `stopCurrentAudio()` from `useReadAloud`.
- Stops any active dictation recording.

**Overlay wrapper:**

```jsx
<div className="fixed inset-0 z-50 bg-white dark:bg-gray-950 flex flex-col">
  {/* Escape key handler */}
  {/* Phase content */}
</div>
```

**Escape key:** `useEffect` listener for `keydown` → if `Escape`, call `close()`.

**Dark mode:** The overlay uses the same `dark:` classes as the rest of the app. All colors are defined with both light and dark variants.

---

### Module M: `client/src/components/Navigation/IntegratedHeader.tsx` — Modifications

**Purpose:** Add Drive Mode button to desktop header.

**Dependencies:** Module K (overlay component exists), Module E (uiStore).

**Changes:**
1. Import `Car` from `lucide-react` (steering wheel icon).
2. Import `useUIStore` for `openDriveMode`.
3. Add button to the right side of the desktop header, after the session action buttons:

```jsx
<button
  onClick={openDriveMode}
  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
  title="Drive Mode"
  aria-label="Enter Drive Mode"
>
  <Car className="w-4 h-4 text-gray-500 dark:text-gray-400" />
</button>
```

4. Position: inside the `currentSessionId` conditional block, or always visible (even without a session, since Drive Mode can create one).

**Decision:** The button should always be visible (not conditional on having a session), because Drive Mode's entry screen offers session creation.

---

### Module N: `client/src/components/Navigation/BottomNav.tsx` — Modifications

**Purpose:** Add Drive Mode entry point on mobile.

**Dependencies:** Module K, Module E.

**Changes:**
1. Import `Car` from `lucide-react`.
2. Add a Drive Mode button to the "More" dropdown menu:

```jsx
<button
  onClick={() => { openDriveMode(); setMoreOpen(false); }}
  className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md w-full"
>
  <Car size={16} />
  Drive Mode
</button>
```

3. Import `useUIStore` for `openDriveMode`.

---

### Module O: `client/src/App.tsx` — Modifications

**Purpose:** Mount the DriveModeOverlay in the app tree.

**Dependencies:** Module K.

**Changes:**
1. Import `DriveModeOverlay` from `./components/DriveMode`.
2. Add `<DriveModeOverlay />` in `AuthenticatedApp`, after `<SettingsModal />` and before `<ToastContainer />`:

```jsx
<SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
<DriveModeOverlay />
<ToastContainer />
```

---

### Module P: `client/src/components/DriveMode/index.ts`

**Purpose:** Barrel export file.

**Contents:**

```typescript
export { DriveModeOverlay } from './DriveModeOverlay';
export { DRIVE_MODE_MODELS } from './driveModeModels';
```

---

## 5. Backend Modules

**No backend changes required.** Drive Mode is a pure frontend feature that reuses:

| Existing Backend API | Usage |
|---|---|
| `POST /api/dictation/warmup` | Pre-warm OpenAI STT client |
| `POST /api/dictation/start` | Start recording session |
| `POST /api/dictation/:id/stream` | Stream audio chunks |
| `POST /api/dictation/:id/finish` | Finish + transcribe + cleanup |
| `POST /api/tts` | Generate TTS audio |
| `WS type: 'new_session'` | Create new session |
| `WS type: 'switch_session'` | Switch to existing session |
| `WS type: 'prompt'` | Send user message |
| `WS type: 'set_model'` | Set model on session |
| `WS event: 'agent_end'` | Detect agent completion |

---

## 6. Integration Points

### 6.1 Dictation → Prompt (critical path)

Normal flow: `useDictation` → `onTranscript(text)` → `setDraft(sessionId, text)` → user edits → Send button.

Drive Mode flow: `useDriveModeDictation` → `onTranscript(text)` → `sendPrompt(text)` → immediate send.

The `useDriveModeDictation` hook wraps `useDictation` but replaces the callback. No changes to the server-side dictation pipeline.

### 6.2 Agent Completion Detection

The overlay watches `isStreaming` from `sessionStore`:
- `true` → `false` transition = agent finished.
- Then extracts last assistant message text from `sessionStore.messages`.

This is the same signal that the normal chat UI uses to re-enable the message input.

### 6.3 Read Aloud Integration

Drive Mode uses the **same** `useReadAloud` hook and the **same** module-level singleton (`audioCtx`, `currentSource`, `playbackRate`). This means:
- Speed setting persists between normal UI and Drive Mode.
- Starting audio in Drive Mode stops any audio playing in the normal UI (and vice versa).
- The hook's message-ID parameter doesn't matter for singleton state; Drive Mode passes a fixed string like `'drive-mode'`.

### 6.4 Session Lifecycle

Sessions created in Drive Mode are real sessions. When the user exits Drive Mode:
- The session appears in the sidebar.
- All messages exchanged in Drive Mode are visible in the chat view.
- The session can be continued normally.

### 6.5 Dark Mode

All Drive Mode components use `dark:` Tailwind classes. The overlay reads `theme` from `uiStore`.

---

## 7. Testing Plan

### 7.1 Unit Tests

#### `client/tests/unit/store/driveModeStore.test.ts`

```
describe('driveModeStore')
  ├── initialState
  │   ├── isOpen is false
  │   ├── phase is 'entry'
  │   └── selectedModelId is null
  ├── open()
  │   ├── sets isOpen to true
  │   ├── sets phase to 'entry'
  │   └── clears all other fields
  ├── close()
  │   ├── sets isOpen to false
  │   └── clears all fields
  ├── setPhase()
  │   └── transitions phase correctly
  ├── selectModel()
  │   └── sets selectedModelId
  ├── setActiveSession()
  │   └── sets activeSessionId
  ├── setLastAssistantText()
  │   └── sets lastAssistantText
  ├── reset()
  │   ├── keeps isOpen true
  │   └── resets phase to 'entry', clears selections
  └── idempotency
      └── calling open() when already open resets state
```

#### `client/tests/unit/components/DriveMode/driveModeModels.test.ts`

```
describe('driveModeModels')
  ├── has exactly 4 models
  ├── each model has id, displayName, sdkType
  ├── no duplicate IDs
  ├── expected model IDs match specification
  └── each sdkType is 'pi' or 'opencode'
```

#### `client/tests/unit/hooks/useDriveModeDictation.test.ts`

**Requires mocking:** `useDictation`, `useWebSocket`.

```
describe('useDriveModeDictation')
  ├── returns dictation state from useDictation
  ├── exposes startRecording, stopRecording, toggle
  ├── when transcript received with valid sessionId
  │   └── calls sendPrompt with transcript text
  ├── when transcript received with null sessionId
  │   └── does not call sendPrompt
  ├── when sessionId changes
  │   └── uses new sessionId for subsequent transcripts
  └── does not call setDraft (verify no draft interaction)
```

#### `client/tests/unit/components/DriveMode/DriveModeEntry.test.tsx`

**Requires mocking:** `useSessionStore` (for sessions count).

```
describe('DriveModeEntry')
  ├── renders "New Session" button
  ├── renders "Continue Session" button
  ├── renders "Exit Drive Mode" button
  ├── clicking "New Session" calls onNewSession
  ├── clicking "Continue Session" calls onContinueSession
  ├── "Continue Session" is disabled when no sessions exist
  ├── "Continue Session" is enabled when sessions exist
  ├── "Exit" button calls onExit (if prop provided) or calls close on store
  ├── has correct aria-labels
  └── auto-focuses "New Session" button on mount
```

#### `client/tests/unit/components/DriveMode/DriveModeModelPicker.test.tsx`

**Requires mocking:** `driveModeModels`.

```
describe('DriveModeModelPicker')
  ├── renders all 4 models
  ├── each model shows displayName
  ├── each model shows correct SDK badge
  ├── tapping a model selects it (radio behavior)
  ├── only one model selected at a time
  ├── "Create Session" button disabled until model selected
  ├── "Create Session" enabled after model selected
  ├── clicking "Create Session" calls onSelect with selected model
  ├── clicking "Back" calls onBack
  └── keyboard navigation between models
```

#### `client/tests/unit/components/DriveMode/DriveModeSessionPicker.test.tsx`

**Requires mocking:** `useSessionStore` (sessions, archivedSessionPaths).

```
describe('DriveModeSessionPicker')
  ├── renders session list from store
  ├── filters out archived sessions
  ├── shows session display name (name > firstMessage > "New session")
  ├── shows model name per session
  ├── shows SDK badge per session
  ├── highlights current session
  ├── shows empty state when no sessions
  ├── clicking a session calls onSelectSession with correct id and path
  ├── clicking "Back" calls onBack
  ├── list scrolls when many sessions
  └── handles sessions without name or firstMessage gracefully
```

#### `client/tests/unit/components/DriveMode/DriveModeDictate.test.tsx`

**Requires mocking:** `useDriveModeDictation`, `useReadAloud`, `useSessionStore`, `useDriveModeStore`.

```
describe('DriveModeDictate')
  ├── mic button
  │   ├── renders large circular button
  │   ├── shows "Tap to speak" when idle
  │   ├── shows "Listening..." when recording
  │   ├── shows "Processing..." when processing
  │   ├── clicking calls toggle on dictation hook
  │   └── shows error message when in error state
  ├── status text
  │   ├── "Tap to speak" in dictate/idle phase
  │   ├── "Listening..." in dictate/recording phase
  │   ├── "Processing..." in dictate/processing phase
  │   ├── "Agent working..." in agent-working phase
  │   ├── "Done — listen or speak" in read-aloud-ready phase
  │   └── "Reading aloud..." in audio-playing phase
  ├── read aloud button
  │   ├── not visible in dictate/agent-working phase
  │   ├── visible in read-aloud-ready phase
  │   ├── clicking calls readAloud.play with assistant text
  │   ├── shows "Stop Reading" during playback
  │   └── stops audio when "Stop Reading" clicked
  ├── speed toggle
  │   ├── shows "1.25x" when speed is default
  │   ├── toggles to "1x" when clicked
  │   └── only visible when read aloud button is visible
  ├── mic re-activation during read-aloud-ready
  │   ├── stops playing audio
  │   └── starts new dictation cycle
  ├── session info display
  │   ├── shows session display name
  │   └── shows model name
  └── exit button
      └── calls onExit
```

#### `client/tests/unit/components/DriveMode/DriveModeOverlay.test.tsx`

**Requires mocking:** `useUIStore`, `useDriveModeStore`, `useWebSocket`, `useSessionStore`.

```
describe('DriveModeOverlay')
  ├── returns null when isOpen is false
  ├── renders overlay when isOpen is true
  ├── phase routing
  │   ├── renders DriveModeEntry for phase 'entry'
  │   ├── renders DriveModeModelPicker for phase 'model-pick'
  │   ├── renders DriveModeSessionPicker for phase 'session-pick'
  │   └── renders DriveModeDictate for phase 'dictate'/'agent-working'/'read-aloud-ready'
  ├── session creation flow
  │   ├── creates session with correct sdkType
  │   ├── sets model after session creation
  │   └── transitions to dictate phase
  ├── session continuation flow
  │   ├── switches to selected session
  │   └── transitions to dictate phase
  ├── escape key closes overlay
  ├── close stops playing audio
  └── close stops active recording
```

#### `client/tests/unit/components/Navigation/IntegratedHeader.test.tsx` (extend existing)

```
describe('IntegratedHeader — Drive Mode button')
  ├── renders Drive Mode button
  ├── button has Car icon
  ├── clicking calls openDriveMode
  └── button has correct aria-label
```

#### `client/tests/unit/components/Navigation/BottomNav.test.tsx` (extend existing)

```
describe('BottomNav — Drive Mode')
  ├── shows Drive Mode in "More" dropdown
  ├── clicking Drive Mode calls openDriveMode
  └── closes "More" dropdown after clicking Drive Mode
```

### 7.2 Test Utilities

Create `client/tests/unit/components/DriveMode/helpers.tsx` with shared test helpers:

```typescript
// Mock providers for wrapping Drive Mode components in tests
export function createDriveModeWrapper(overrides?: Partial<StoreState>) { ... }

// Helper to trigger phase transitions in tests
export function setDriveModePhase(phase: DriveModePhase) { ... }

// Helper to simulate agent completion
export function simulateAgentEnd() { ... }

// Helper to mock last assistant message
export function setLastAssistantMessage(text: string) { ... }
```

### 7.3 E2E Test (optional, post-merge)

An E2E test for the full Drive Mode flow would require a running server with mocked runtime backends. This is out of scope for the initial implementation but should be tracked as a follow-up.

Suggested E2E test outline:
1. Login → see header
2. Click Drive Mode button
3. Click "New Session"
4. Select model → verify session created
5. Mock dictation → send prompt
6. Mock agent response → verify Read Aloud appears
7. Click Read Aloud → verify audio plays
8. Click Exit → verify overlay closes, session visible in sidebar

---

## 8. Edge Cases

### 8.1 Microphone Permission Denied
- **What happens:** `useDictation` sets `state: 'error'` with `errorMessage: 'Microphone permission denied.'`.
- **Drive Mode behavior:** Show the error message below the mic button in red text. The mic button returns to tappable state (idle). User can try again after granting permission.
- **No crash, no stuck state.**

### 8.2 No Microphone Available
- **What happens:** `useDictation` sets `state: 'error'` with `errorMessage: 'No microphone found.'`.
- **Drive Mode behavior:** Same as permission denied — show error, allow retry.

### 8.3 Dictation Transcription Fails
- **What happens:** `useDictation` sets `state: 'error'` with server error message.
- **Drive Mode behavior:** Show error text. Phase stays at `dictate`. User can tap mic again.
- **Agent never receives a prompt** (transcript callback is not called on error).

### 8.4 Session Creation Fails
- **What happens:** WebSocket `session_created` event never arrives, or an error event arrives.
- **Drive Mode behavior:** Show toast error via `useUIStore.addToast`. Phase stays at `model-pick`. User can try again.
- **Detection:** Set a 10-second timeout after `createNewSession`. If no `session_created` event for the new session, show error.

### 8.5 Model Setting Fails
- **What happens:** `set_model` WebSocket message sent but no `model_changed` confirmation, or model is rejected by the runtime.
- **Drive Mode behavior:** Session is still created and usable (just with default model). Proceed to `dictate` phase. Show a subtle warning toast.

### 8.6 No Active Sessions for "Continue"
- **What happens:** User enters Drive Mode, taps "Continue Session", but there are zero active sessions.
- **Drive Mode behavior:** "Continue Session" button on the entry screen is **disabled** (grayed out, not clickable). The session picker screen shows an empty state message: "No active sessions. Create a new one instead."

### 8.7 Agent Produces No Text Output
- **What happens:** Agent finishes (`agent_end`) but the last assistant message has no text content (only tool calls, or only thinking blocks).
- **Drive Mode behavior:** Phase transitions to `read-aloud-ready`, but `lastAssistantText` is `null`. The Read Aloud button is **disabled** with a tooltip "No text to read". Status shows "Done — no text output". User can tap mic to continue.

### 8.8 Agent Produces Very Long Output
- **What happens:** Last assistant message is > 4000 characters (TTS API limit).
- **Drive Mode behavior:** Truncate text to 4000 chars with "..." before sending to TTS. Show a subtle indicator that output was truncated for audio.

### 8.9 Network Disconnect During Drive Mode
- **What happens:** WebSocket disconnects while in Drive Mode.
- **Drive Mode behavior:** Show "Connection lost" status. The existing WebSocket reconnection logic handles reconnect. On reconnect, the session continues. Drive Mode stays open throughout.

### 8.10 User Closes Drive Mode During Recording
- **What happens:** User taps Exit while dictation is recording.
- **Drive Mode behavior:** `close()` calls `stopCurrentAudio()` and calls `stopRecording()` on the dictation hook. Any partial recording is discarded (no transcript sent).

### 8.11 User Closes Drive Mode During Agent Work
- **What happens:** User taps Exit while agent is streaming.
- **Drive Mode behavior:** Overlay closes. Agent continues working in the background. When user returns to the normal chat view, the messages are there.

### 8.12 User Closes Drive Mode During Audio Playback
- **What happens:** User taps Exit while TTS is playing.
- **Drive Mode behavior:** `close()` calls `stopCurrentAudio()`. Audio stops immediately.

### 8.13 Multiple Rapid Phase Transitions
- **What happens:** User quickly taps mic → stop → mic → stop in rapid succession.
- **Drive Mode behavior:** Each `stopRecording` is asynchronous. The `useDictation` hook handles this internally — it ignores `stopRecording` if there's no active recorder. No race condition.

### 8.14 Session Switched During Drive Mode
- **What happens:** A background process switches the current session while Drive Mode is open.
- **Drive Mode behavior:** Drive Mode tracks its own `activeSessionId` in `driveModeStore`, independent of `sessionStore.currentSessionId`. The overlay does not change when background sessions change.

### 8.15 Dark Mode Toggle While Drive Mode Is Open
- **What happens:** User toggles theme while Drive Mode overlay is showing.
- **Drive Mode behavior:** Overlay re-renders with dark classes. All components use `dark:` variants. No layout shift.

### 8.16 Escape Key While in Entry Screen
- **What happens:** User presses Escape on the entry screen.
- **Drive Mode behavior:** Same as Exit — closes the overlay.

### 8.17 Mobile: Virtual Keyboard Opens
- **What happens:** Drive Mode doesn't have text inputs, but the browser might show a keyboard if something gets focused.
- **Drive Mode behavior:** No text inputs exist in Drive Mode. Only buttons. Keyboard should not appear.

### 8.18 Browser Tab Becomes Hidden
- **What happens:** User switches tabs while Drive Mode is active (recording or playing).
- **Recording:** `MediaRecorder` may pause in some browsers. When tab becomes visible again, recording continues or may need restart. Show status update.
- **Audio:** `AudioContext` may be throttled. Audio resumes when tab is visible. The `ended` event still fires correctly.

---

## 9. Git Strategy

### Branch

- **Feature branch:** `feature/drive-mode` from `master` (or current default branch).
- **All work commits to this branch.**

### Commit Strategy

Each module gets its own commit, in dependency order. Commits should be small, atomic, and have clear messages.

| Commit | Module(s) | Message | Depends on |
|---|---|---|---|
| 1 | A, B | `feat(drive-mode): add drive mode store and model definitions` | — |
| 2 | C | `feat(drive-mode): export start/stop from useDictation hook` | — |
| 3 | D | `feat(drive-mode): add useDriveModeDictation hook for direct prompt sending` | Commit 2 |
| 4 | E | `feat(drive-mode): add driveModeOpen state to uiStore` | Commit 1 |
| 5 | G | `feat(drive-mode): add DriveModeEntry component` | Commit 1 |
| 6 | H | `feat(drive-mode): add DriveModeModelPicker component` | Commit 1 |
| 7 | I | `feat(drive-mode): add DriveModeSessionPicker component` | Commit 1 |
| 8 | J | `feat(drive-mode): add DriveModeDictate component with mic + read aloud` | Commit 3 |
| 9 | K, P | `feat(drive-mode): add DriveModeOverlay with phase routing` | Commits 5-8 |
| 10 | M | `feat(drive-mode): add Drive Mode button to IntegratedHeader` | Commit 9 |
| 11 | N | `feat(drive-mode): add Drive Mode entry to BottomNav` | Commit 9 |
| 12 | O | `feat(drive-mode): mount DriveModeOverlay in App.tsx` | Commit 9 |
| 13 | F + all tests | `test(drive-mode): add unit tests for store, hooks, and components` | Commits 1-12 |

### Merge Strategy

- **Squash merge** `feature/drive-mode` into `master` with a single commit.
- **OR** keep individual commits for history (team preference).
- **Run full CI** before merge: `npm run lint && npm run typecheck && npm run build && npm test`.

---

## 10. Acceptance Criteria

### Functional

- [ ] Drive Mode button visible in header (desktop) and "More" menu (mobile).
- [ ] Clicking button opens full-screen overlay.
- [ ] Entry screen shows "New Session" and "Continue Session".
- [ ] "Continue Session" disabled when no active sessions.
- [ ] Model picker shows exactly 4 models with correct names and SDK badges.
- [ ] Selecting a model and tapping "Create Session" creates a real session with that model.
- [ ] Session picker shows active sessions, excludes archived ones.
- [ ] Tapping a session switches to it and enters dictate phase.
- [ ] Mic button starts recording on tap, stops on second tap.
- [ ] Transcript is sent directly as prompt (no textarea/draft step).
- [ ] Status text updates correctly through all phases.
- [ ] Read Aloud button appears only after agent finishes.
- [ ] Read Aloud plays the last assistant message text.
- [ ] Speed toggle switches between 1x and 1.25x.
- [ ] Speed setting persists between normal UI and Drive Mode.
- [ ] Tapping mic during read-aloud-ready stops audio and starts new dictation.
- [ ] Exit button closes overlay and stops all audio/recording.
- [ ] Escape key closes overlay.
- [ ] Sessions created in Drive Mode appear in normal sidebar after exit.
- [ ] Messages exchanged in Drive Mode are visible in normal chat view.

### Non-Functional

- [ ] All buttons have `aria-label` attributes.
- [ ] Status text uses `role="status"` + `aria-live="polite"`.
- [ ] Mic button vibrates on start/stop (when `navigator.vibrate` available).
- [ ] Overlay uses `z-50` and covers full viewport.
- [ ] No layout shift on dark mode toggle.
- [ ] No console errors during normal flow.

### Testing

- [ ] All unit tests pass (`npm test`).
- [ ] Lint passes (`npm run lint`).
- [ ] Typecheck passes (`npm run typecheck`).
- [ ] Build passes (`npm run build`).
- [ ] No regressions in existing tests.

---

## Appendix A: Key Reference Files for Implementing Agents

| What | File |
|---|---|
| Dictation hook | `client/src/hooks/useDictation.ts` |
| Read aloud hook | `client/src/hooks/useReadAloud.ts` |
| WebSocket actions | `client/src/hooks/useWebSocket.ts` |
| Session store | `client/src/store/sessionStore.ts` |
| UI store | `client/src/store/uiStore.ts` |
| App layout | `client/src/App.tsx` |
| Desktop header | `client/src/components/Navigation/IntegratedHeader.tsx` |
| Mobile nav | `client/src/components/Navigation/BottomNav.tsx` |
| Session model type | `client/src/store/sessionStore.ts:115-126` |
| Message type | `client/src/store/sessionStore.ts:128+` |
| Model selector | `client/src/components/Settings/ModelSelector.tsx` |
| Session creation modal | `client/src/components/Session/NewSessionModal.tsx` |
| Session list item | `client/src/components/Sidebar/SessionItem.tsx` |
| Chat view (dictation wiring) | `client/src/components/Chat/ChatView.tsx:38-46` |
| Read aloud button | `client/src/components/Chat/ReadAloudButton.tsx` |
| Message bubble (read aloud wiring) | `client/src/components/Chat/MessageBubble.tsx` |
| Test setup | `client/tests/unit/setup.ts` |
| Existing store tests | `client/tests/unit/store/` |
| Existing component tests | `client/tests/unit/components/` |

## Appendix B: Zustand Store Pattern

All stores in this project use the same pattern. Follow it exactly:

```typescript
import { create } from 'zustand';

interface MyState {
  // state fields
  isOpen: boolean;
  // actions
  open: () => void;
  close: () => void;
}

export const useMyStore = create<MyState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
```

No middleware unless persistence is needed. Drive Mode store does NOT need persistence.

## Appendix C: Component Test Pattern

Follow the existing pattern from `client/tests/unit/components/Sidebar/`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentName } from '../../../src/components/...';

// Mock stores
vi.mock('../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(() => ({ /* state */ })),
}));

describe('ComponentName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render', () => {
    render(<ComponentName {...props} />);
    expect(screen.getByText('expected text')).toBeInTheDocument();
  });
});
```
