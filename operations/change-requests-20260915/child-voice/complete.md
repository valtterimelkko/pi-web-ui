# Child V — handback

Parent: `01a0a410-f683-7422-bc57-055af50db3f2` · Child: `01a0a42e-eb8f-7422-bc57-05640c176744`
Tree: `/root/pi-web-ui-wt-voice` (branch `task/voicemode-multilane-desktop`) · Written during the run, so a partial
run still hands back what it proved.

**Not done by me (parent's job):** no commit, no push, no `npm run build`, no production, no service changes.

| Item | State |
|---|---|
| A — two-tab voice defect | reproduced, failing layer identified, fixed with TDD, live-validated |
| A — up-to-three-lane design note | written: `MULTILANE-DESIGN.md` (not implemented, by design) |
| B — desktop layout mode | implemented with TDD, browser-validated with paired screenshots |
| Operator decisions | listed at the end (§6) |

---

## 0. This run was interrupted once

My first turn was killed at 08:30:26 UTC by the `pi-web-ui.service` restart (all four children died).
Nothing had been written to my tree yet, so I re-ran from scratch. Everything long-running since then
was started with `systemd-run --scope --collect --unit=childvoice-*` so it lives **outside** the
service cgroup. Nothing was left in the service's cgroup.

---

## 1. Item A — the two-tab voice defect

### 1.1 How it was reproduced (exact steps)

No physical microphone is needed: Chromium's fake media device drives the **real** capture path
(`getUserMedia` → `MediaRecorder` → `/api/dictation/*`) through the **real** client modules.

```bash
# disposable server (source mode, own state dir, own port) — outside the service cgroup
ops/.../child-voice/harness/boot.sh server     # systemd-run --scope --collect --unit=childvoice-server
ops/.../child-voice/harness/boot.sh client     # vite dev on :3499 proxying VITE_API_TARGET=:3491
cd ops/.../child-voice/harness
# the harness imports playwright from the worktree; recreate the symlink first (removed on cleanup):
ln -sfn /root/pi-web-ui-wt-voice/node_modules/playwright      node_modules/playwright
ln -sfn /root/pi-web-ui-wt-voice/node_modules/playwright-core node_modules/playwright-core
VOICE_APP_URL=http://127.0.0.1:3499 VOICE_RUN_TAG=after-fix node two-tab-repro-v2.mjs
```

The harness itself does the rest:

1. deletes any pre-existing sessions, then creates **two** Pi sessions on the disposable server
   (Internal API over its unix socket; `zai/glm-5.3-flash` and `zai/glm-5.3`, no model turns);
2. launches one Chromium **persistent context** (one profile = one cookie jar = the operator's
   browser), logs in once, and opens **two tabs**;
3. puts **tab A** into Voice Mode on session A and **tab B** into Voice Mode on session B
   (verified against the client's own store: the tab's `currentSessionId` must equal the intended id);
4. instruments — observationally only — `navigator.mediaDevices.getUserMedia`, `MediaRecorder` and
   `/api/dictation*` fetches, and reads recorder `state` / track `readyState` **at read time**;
5. drives: record in A → record in B → exit A's surface while recording → double-tap in B
   (fast device *and* 900 ms-injected slow device) → one tap to stop → cross-tab floor test.

Evidence: `evidence/repro-v2.json`, `evidence/repro-v3.json` (**pre-fix**), `evidence/repro-after-fix.json`
(**post-fix**). Screenshots `evidence/10-…`–`19-…` (tagged `v2` / `v3` / `after-fix`).

### 1.2 Which layer actually failed

| Layer | Verdict | Evidence |
|---|---|---|
| Browser capture policy | **not the failure** | both tabs got their own live stream; two concurrent captures are allowed (`repro-after-fix.json`, `lane.A/B.recording`, both `readyState: live`) |
| Cross-tab contention on the device | **not the cause of the button symptom** | in the harness every `getUserMedia` resolved for both tabs |
| **Recorder state machine (`useDictation`)** | **THE FAILURE** | §1.3 |
| Surface enable/disable logic | contributory | the surface had no way to render "acquiring" — so it read as idle exactly while the browser was already capturing (the operator's words) |
| STT round trip | not implicated | every `/api/dictation/*` call returned 200, including both duplicate `start`s |
| Cross-tab playback arbitration | **a real, separate defect** | `crossTab.floorTakenInTabA`: tab A held the floor; tab B kept playing at **volume 1.0**, `ducked: false`, zero `setVolume` events — there is no cross-tab coordination at all (design note §3–§4) |

### 1.3 The defect, with observed bytes

**D1 — no single owner during acquisition.** A tap that lands while the device is still being acquired
started a *second* `MediaRecorder` and opened a second dictation session. One tap then released only
one of them:

```
PRE-FIX  evidence/repro-v3.json → step "start.doubleClick.thenOneTapStop"
  mic button label        : "Start recording"          ← the app says idle
  recordersRecording      : 1                          ← a recorder is still recording
  recorders               : [inactive, inactive, RECORDING, inactive]
  recorder tracks         : [... "audio:live" ...]     ← the microphone is still captured
  verdict                 : "LEAK PROVEN: after one tap the app shows idle while a MediaRecorder
                             is still recording and the microphone track is still live"
```

That is the operator's report exactly: *the browser tab shows recording, the app's button does not
activate*. Two taps are enough; the window only has to be wide (a second tab, a cold device, a
permission prompt — I injected 900 ms of device latency to make it deterministic and labelled it as
injected).

**D2 — no teardown on unmount.** Exiting the Voice Mode surface while recording left the recorder and
the track running, with no control anywhere in the app:

```
PRE-FIX  evidence/repro-v2.json → step "capture.tabA.afterExitWhileRecording"
  mic button present      : false       ← no control left
  recordersRecording      : 1
  liveTracksNow           : 1           ← browser indicator stays on
```

**D3 — the in-flight state was invisible.** `state` stayed `'idle'` throughout acquisition, so the
surface could not tell the operator (or itself) that capture was starting.

### 1.4 RED → GREEN per change (strict TDD; RED observed before each implementation)

| # | RED test (observed failing first) | GREEN change |
|---|---|---|
| 1 | `useDictation.test.ts` — "starts exactly one capture when a second tap lands while the first start is in flight" (2 gUM calls, 2 recorders) | one owned `Capture` object + an acquisition lock; the second tap is absorbed (`useDictation.ts`) |
| 2 | "does not open a second dictation session when the surface is tapped twice in quick succession" (2 `/start` POSTs) | same lock; only the owner streams chunks |
| 3 | "leaves no recorder running and no live microphone track when the hook unmounts while recording" | unmount cleanup releases the stream, stops the recorder and abandons the server recording (StrictMode-safe) |
| 4 | "tells the server to abandon an in-flight recording when the surface goes away" (0 `/abort` calls) | unmount → `POST /api/dictation/:id/abort` |
| 5 | "reports a visible in-flight state while the device is being acquired (never plain idle)" | `state: 'starting'` |
| 6 | `DriveModeDictate.test.tsx` — "names the acquisition window instead of looking idle…" | mic button renders "Starting microphone…" (disabled, amber, `aria-busy`) |
| 7 | `server/tests/unit/routes/dictation.test.ts` — `POST /api/dictation/:id/abort` (3 tests) | new idempotent route: drops the buffered audio, **no** transcription, **no** cleanup |
| 8 | (guards, already green, kept) | normal stop still transcribes + releases the device; permission failure releases the device and reports honestly; stop with no lane is a no-op |

Live post-fix re-run (`evidence/repro-after-fix.json`):

```
capture.tabA.afterExitWhileRecording : recordersRecording 0 | liveTracksNow 0 | track readyState "ended" | /abort → 200
start.doubleClick.slowDevice.inFlight: mic label "Starting microphone", disabled true, aria-busy "true"
start.doubleClick.slowDevice         : one new recorder only (the second tap was absorbed)
start.doubleClick.thenOneTapStop     : "no leak: one tap released every recorder" | liveTracksNow 0
```

### 1.5 Honest boundary of what I fixed

- **Fixed:** one tab's capture lifecycle — single owner, deterministic teardown, a truthful
  acquisition state, and a server route so an abandoned recording does not keep its buffered audio
  in memory (it was in-memory-only, but unbounded while the process lived).
- **Not fixed (deliberately):** cross-tab playback arbitration, lane identity, the 3-lane cap, the
  "another lane started talking" surprise. All of that is `MULTILANE-DESIGN.md`, for the operator to
  review first.
- **Not measured:** real microphone hardware, real OS device contention, Safari/Firefox. The
  reproduction uses Chromium with a fake device; the failure it exposes is in the app's own state
  machine, not in device arbitration.
- The 350 ms "announce before a hidden lane speaks" cue in the design note is a proposal, not tested.

---

## 2. Item B — the desktop layout mode

### 2.1 What was built

* `client/src/components/DriveMode/voiceLayout.ts` — the **pure** decision layer: the mode
  (`'mobile' | 'desktop'`), a persisted zustand store, and `resolveVoiceLayout(mode, viewportWidth)`
  which only splits when the window can hold two readable halves (`SPLIT_MIN_WIDTH = 1024`).
* `useVoiceLayout.ts` — mode + live viewport width (resize/orientationchange), returns the layout.
* `VoiceLayoutToggle.tsx` — the explicit two-button switch, visible in the surface; states plainly
  when a desktop preference cannot be honoured at this width.
* `DriveModeSessionPane.tsx` — the live session: reads **`useSessionStore`** and renders the shared
  `MessageList`/`MessageBubble` (no second transcript, no fork), with a header, a streaming dot and
  follow-the-live-end scrolling. Read-only: it can never send.
* `DriveModeOverlay.tsx` — renders the split only when `layout === 'split'`; otherwise the existing
  surface, unchanged.
* `DriveModeDictate.tsx` — hosts the toggle; nothing else about the mobile surface was restyled.

### 2.2 Tests (pure logic first, then the surface)

RED first (`voiceLayout.test.ts` failed to resolve the module), then GREEN: **13 tests** —
split on wide, degrade on narrow, mobile at every width, never split on an unknown/0 width,
`selectViewportWidth` guards, persistence round-trip, corrupt storage, unknown stored mode,
`setMode('sideways')` refused.

`voiceLayoutComponents.test.tsx` (**8 tests**) — the toggle marks the active mode and reports the
choice, and says so when degraded; the pane reads the real session store and shows Working/Idle.

`DriveModeOverlay.test.tsx` (**+4 tests**) — mobile mode never splits even at 1600 px; desktop mode
splits at 1600 px with the pane present; desktop mode at 420 px degrades (no split, no pane); the
choice survives a remount because it is persisted.

### 2.3 Browser validation (`harness/layout-shots.mjs` → `evidence/layout.json` + `shots/`)

Real Chromium, real client, disposable server. Every line below was read back from the DOM after the
interaction; the screenshots illustrate it.

| State | Measured |
|---|---|
| mobile mode @1440 | `split: false`, pane absent |
| desktop mode @1440 | `split: true`, pane present, **mic still works in the split** (`floorBanner: "You have the floor"`, mic `"Stop recording"`) |
| desktop split, pane follows the same store | message pushed through `useSessionStore` appears in the pane (`PANE-STORE-PROBE: true`); Read Aloud control present in the split |
| desktop split, confirmation card | card renders **inside the split** with Confirm / Cancel / Send reply (driven by the surface's real talker-turn bus — synthetic event, see boundary below) |
| desktop mode @430 | `split: false`, `degraded: true` ("Too narrow to split — showing the mobile layout.") |
| mobile mode @430 | `split: false`, unchanged surface |
| desktop mode, after reload | `split: true` — the preference persisted |

Paired screenshots for the operator: `shots/21-mobile-mode-1440.png`,
`shots/22-desktop-mode-1440-split.png`, `shots/24-desktop-mode-1440-session-pane-store.png`,
`shots/25-desktop-mode-1440-confirmation-card.png`, `shots/26-desktop-mode-430-degraded.png`,
`shots/27-mobile-mode-430.png`, `shots/28-desktop-mode-after-reload.png`.

**Boundary:** the confirmation card was exercised by emitting the surface's real
`talker_turn_result` on its real bus, not by a live talker turn (no talker model was wired on the
disposable server). Read-aloud was asserted present and enabled in the split, not audibly verified —
`/api/tts` has no credential on the disposable server. The voice *capture* path in the split
**was** exercised for real (getUserMedia → recorder → `/api/dictation/*`).

### 2.4 Operator decisions needed for Item B

1. Is the breakpoint (1024 px) right, or should the split hold at ~900 px?
2. In the split, the voice column is a flexible half of the window. Should it instead be a fixed
   comfortable width with the transcript taking the rest?
3. Should the toggle also be reachable from the Voice Mode **entry** screen (before a session is
   picked), so the mode can be chosen before the first session?
4. Should desktop mode default ON for wide screens on first use, or stay opt-in as it is now?

---

## 3. Changed-path inventory (this tree only; nothing committed)

Modified:

```
client/src/hooks/useDictation.ts                                     single-owner capture, teardown, 'starting'
client/src/components/DriveMode/useVoiceTurn.ts                       state union gains 'starting'
client/src/components/DriveMode/DriveModeDictate.tsx                  'starting' UI + layout toggle host
client/src/components/DriveMode/DriveModeOverlay.tsx                  desktop split rendering
client/src/components/Chat/DictationButton.tsx                        'starting' render/disable
server/src/routes/dictation.ts                                        POST /:id/abort
client/tests/unit/components/DriveMode/DriveModeDictate*.test.tsx     +2 lucide icons in 7 mocks; +2 new tests
client/tests/unit/components/DriveMode/DriveModeOverlay.test.tsx      +4 layout-mode tests, pane mock
server/tests/unit/routes/dictation.test.ts                            +3 abort tests
```

Added:

```
client/src/components/DriveMode/voiceLayout.ts
client/src/components/DriveMode/useVoiceLayout.ts
client/src/components/DriveMode/VoiceLayoutToggle.tsx
client/src/components/DriveMode/DriveModeSessionPane.tsx
client/tests/unit/hooks/useDictation.test.ts                          8 tests
client/tests/unit/components/DriveMode/voiceLayout.test.ts            13 tests
client/tests/unit/components/DriveMode/voiceLayoutComponents.test.tsx 8 tests
```

Verification run in this tree: `client` suite **1263 passed / 117 files**;
`npm run typecheck` clean (4 workspaces); `npm run lint` **0 errors** (304 pre-existing warnings).
Server suite result is in §5.

Out-of-tree (evidence, not code): `operations/change-requests-20260915/child-voice/{evidence,shots,logs,harness}`.

---

## 4. Things I could not do / found but did not fix

1. **The audio lab's own capture chain is broken on this host.** `npm run audio-lab -- doctor`
   reports **18/19**, failing `capture:chain` (`ENOENT … doctor-probe/capture/calibration.raw`):
   the lab's private PulseAudio daemon/sink cannot start here (`pactl info` → connection refused).
   So the lab's OS-output oracle lane could not be used, and the brief's suggested starting point
   was partly unavailable. I used the repo's real UI + real modules + Chromium fake media instead,
   which is what the brief actually needed (the defect is in the app's own state machine, not in
   audio rendering). **This is worth the parent's attention on its own**: a regression lab whose
   capture chain silently fails on this host will produce `indeterminate` at best.
2. **Cross-tab voice arbitration does not exist** (measured, §1.2). Design note only.
3. **The user gesture that triggers D1 in the field** is not recorded: I proved the mechanism, and
   the operator's report is consistent with it, but I did not observe it happening on their hardware.
4. **`useVoiceTurn`'s floor signal** still treats only `'recording'` as the operator's floor, not
   `'starting'`. Changing that would move the duck earlier by a few hundred ms; I left it alone to
   keep this change minimal. Flagged as a candidate for the multi-lane work.
5. **Server-side abandoned recordings**: now cleaned up when the surface goes away. A recording
   abandoned while the browser process is killed outright still leaves an in-memory entry (there is
   no TTL reaper). Bounded and process-local; flagged, not fixed.

## 5. Final verification (appended at the end of the run)

- client suite: **1263 passed / 117 files**
- server suite: `npx vitest run` in `server/` → **4348 passed, 4 failed, 2 skipped (4354)** — all 4 failures are
  inherited-environment artifacts across **two** files, not regressions:
  - `tests/unit/opencode/opencode-service-expanded.test.ts` — 3 failures from `OPENCODE_ENABLED=false`
    inherited from the service environment (`expected /not available/ but got 'OpenCode is disabled …'`);
  - `tests/unit/config/pi-max-sessions.test.ts` — 1 failure from `PI_MAX_SESSIONS=20` inherited, so the test
    asserting the default **when unset** sees the variable set (`expected '20' to be undefined`).
  Proven environmental: both files pass **34/34** with `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED` (full log:
  `logs/server-suite-full.log`). My diff touches neither file.
  Correction note: this section first named only the OpenCode file, because the first read was of a 25-line
  log tail; the full log shows the second file. The Agent OS candidate submitted for the environment lesson
  repeats that narrower reading — the corrective capture in this run's capture batch names the true split.
- `npm run typecheck` → clean · `npm run lint` → 0 errors
- disposable server + vite dev: stopped, scopes reset, sessions deleted, temp profiles removed.

## 6. Operator decisions requested

1. Multi-lane scope: **one machine** (client-only `BroadcastChannel`, no contract change) or
   **across devices** (server-side lane registry + contract bump)? Cap 3 ok?
2. Should a fourth lane *replace* a lane or *ask which* to hand over?
3. Is a short cue tone before a hidden lane speaks wanted, or is a visual marker enough?
4. Item B: breakpoint, column sizing, whether the toggle belongs on the entry screen, and whether
   desktop should default on for wide screens.
