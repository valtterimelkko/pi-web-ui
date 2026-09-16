# Voice Mode: real session pane, lanes in the desktop layout, per-lane session switch

**Date:** 2026-09-16
**Status:** implemented, unit + real-browser validated 2026-09-16 (see `operations/voice-desktop-20260916/complete.md`); production deploy via the audited restart path.
**Follow-up (same day, operator):** 4. *"regardless of what lane I have selected,
will every lane give its headlines when it is its turn?"* and 5. *"make sure we
have quick switching of talker to a different worker session available — I don't
see that yet."* → §Follow-up below.
**Scope:** client Voice Mode (`client/src/components/DriveMode/*`), plus its unit
tests. No server, protocol or contract change.

## The operator's request (verbatim, 2026-09-16)

1. *"when the screen is split and displays the session, it's super raw content,
   maybe directly from the SDK stream or so — not organised like in the regular
   session view. fix this. it should look just like the outputs looks when in
   regular session view without voice mode."*
2. *"we earlier added the lanes, and I can only see the lanes within the mobile
   view, not in the desktop view … because we are having maximum three lanes, I
   want to add the lanes to the desktop view … I wonder if the session view …
   could be much smaller … like just one fourth of the screen height … on the
   bottom of it … basically in the same block, in the same column, if you will,
   together with the kind of like the voice mode tools just below them. So that
   would then fit maximum three lanes together."*
3. *"I don't see an easy 'switch session' button that would allow me to adjust
   quickly (per lane) what session / worker is the voice mode attached to …
   Especially for the lanes, it should be very useful so I don't have to exit
   the voice mode entirely and then having to 'rebuild' the 3 lanes view again
   from scratch."*

## Intent

- **D1 — one session view, not two.** `DriveModeSessionPane` currently renders
  the legacy flat `MessageList` (`MessageBubble` per store message). The regular
  chat view renders `VirtualizedMessageList`, which is where tool calls are
  grouped (`findConsecutiveToolRuns` / `ToolGroupContainer`), where skill
  payloads are collapsed and where per-tool verbosity lives. That difference —
  not the event pipeline — is the "raw content" the operator sees. The pane
  will render the same list from the same store with the same
  `messagesToLiveMessages` adapter, so there is one transcript rendering path.
- **D2 — lanes are a desktop feature too.** Lanes became reachable only from the
  voice-only layout: the desktop branch rendered no `LaneStrip` at all, so the
  "+" that adds a second lane did not exist in desktop mode. The desktop
  arrangement becomes: lane strip and the addressed lane's voice controls in the
  main block, with the live-session pane as a **bottom panel of the same
  column** (~¼ of the window height, minimum 150px) instead of a side-by-side
  half. That keeps the max-three-lane strip workable and keeps the session
  visible. A `compact` variant tightens the voice controls in desktop mode so
  three lanes plus the pane fit a laptop-height window.
- **D3 — switch the worker per lane, in place.** `Switch session` is offered on
  the addressed lane's surface (works in single-lane and lane mode) and on every
  lane row in the strip. It opens the existing session picker *over* the mounted
  lanes (the phase never changes, no lane unmounts, capture/card/focus survive),
  and it swaps only the chosen lane's session — single-lane switches the
  addressed session without creating a lane. Capture in the switched lane is
  finalised into its own talker first, exactly as add/remove already do, so the
  operator's words are never dropped.

## Follow-up (operator, 2026-09-16 — same day, after the deploy)

- **F1 — every lane speaks at its own turn.** Answered by inspection and pinned by
  tests: each lane is a mounted surface with its own answer reader, so a lane
  speaks when ITS session finishes a turn, whichever lane is addressed. This
  exposed a real defect: the shared "already spoken" record was keyed on the
  words alone, so two lanes answering with the SAME words collapsed into one
  speaker — the second lane was silent. The record is now **scoped per lane**
  (`contentScopeFor`), which keeps P16's never-twice rule intact *within* a lane
  (auto path and read-aloud share the scope) while two lanes get two events.
  4 client tests, all red before the change.
- **F2 — the switch control must be findable.** The per-lane switch existed but
  was an icon-only refresh glyph; the operator did not find it. Every lane row now
  carries a labelled **"Switch"** control (word shown from `sm` up, icon on
  phones) and the addressed surface's **"Switch session"** button is a named
  action next to the worker's name.
- **F3 — reading level is per lane.** Reported honestly, not changed: setting
  Headlines while addressing one lane sets that lane's level only; other lanes
  keep their own level or the shared default.

## Non-goals

- No server-side, protocol or contract change.
- No change to the talker, the floor/arbiter, the confirmation card, read-aloud
  or the digest path.
- No new lane count: the cap stays 3.
- Cross-tab playback arbitration stays out of scope (previously deferred; the
  operator has not asked for it here).

## TDD list

1. `voiceLayout.test.ts` — the resolved arrangement is `'desktop'` (not the
   retired `'split'`); width degradation and persistence unchanged.
2. `voiceLayoutComponents.test.tsx` — `DriveModeSessionPane` renders the shared
   virtualized session list (with tool grouping) for the addressed session, and
   reports streaming from that session's projection, not the global one.
3. `DriveModeOverlay.test.tsx` — desktop mode renders the voice block and the
   session pane in ONE column (pane after the voice block in DOM order, pane
   carries the desktop marker, the lane strip is present); mobile mode renders
   no pane; narrow windows still degrade.
4. `DriveModeOverlay.lanes.test.tsx` — desktop + lanes renders the strip rows
   and the pane together; the "+" is reachable in desktop mode.
5. `LaneStrip.test.tsx` — every lane row offers "switch session" and reports the
   lane it belongs to.
6. `DriveModeOverlay.lanes.test.tsx` / `DriveModeOverlay.test.tsx` — the switch
   flow: single-lane switch does not add a lane and does not change phase;
   multi-lane switch replaces exactly one lane, subscribes the new session and
   addresses it; the old session is unsubscribed.
7. `DriveModeDictate` tests — the switch control is offered only when the
   surface is given a switch handler, and the compact variant is a prop, not a
   hidden global.

## Quality gates

- `npm run typecheck`, `npm run lint`, `npm run build`
- client unit suite (`npm run test --workspace client` or the client vitest run)
- focused DriveMode + layout tests green, RED-first for every new behaviour
- `npm run docs:check-agent-guides` if either agent guide is touched (it should
  not need to be)

## Live validation (required — this is a browser surface)

Disposable validation server + real client bundle + real runtime session that
produces tool calls, then a real Chromium:

1. A real session with several tool calls is driven to completion on a
   disposable server.
2. The same session is screenshotted in the **regular chat view** and in the
   **Voice Mode desktop pane**; the two must show the same structure (grouped
   tool cards, same collapsed/expanded shape), not a raw event list.
3. Desktop mode is screenshotted with **three lanes** plus the session panel, at
   a laptop viewport and at a phone viewport (mobile must stay unchanged and
   pane-free).
4. The switch control is exercised for real: switch a lane's session while
   three lanes are held, and show that the lane keeps its place and the pane
   follows the addressed session — no exit, no rebuild.
5. Screenshots + a findings note land under
   `operations/voice-desktop-20260916/evidence/`.

## Rollback

Client-only change: reverting the merge/topic commit restores the previous
surface; the layout preference is stored under `pi-voice-mode-layout` and its
stored values (`mobile` / `desktop`) are unchanged, so no migration is needed.
