# Voice Mode desktop rework — completion record (2026-09-16)

Operator request (verbatim, 2026-09-16):

1. the split-screen session view shows *"super raw content, maybe directly from
   the SDK stream or so — not organised like in the regular session view. fix
   this. it should look just like the outputs looks when in regular session view
   without voice mode."*
2. lanes are *"only … within the mobile view, not in the desktop view"*, and the
   session view *"could be much smaller … like just one fourth of the screen
   height … on the bottom of it … in the same block, in the same column … together
   with the kind of like the voice mode tools just below them. So that would then
   fit maximum three lanes together."*
3. *"I don't see an easy 'switch session' button that would allow me to adjust
   quickly (per lane) what session / worker the voice mode is attached to."*

## What was delivered

| # | Change | Where |
|---|---|---|
| 1 | The desktop session pane renders the shared `VirtualizedMessageList` (the chat screen's list) through the same adapter, and follows the **addressed** session's own projection | `client/src/components/DriveMode/DriveModeSessionPane.tsx` |
| 2 | Desktop is ONE column — lane strip + voice block on top, live session as a **bottom panel** (¼ height, min 150px, max 45%) of the same column; lanes are reachable in desktop mode; compact voice controls while the pane shares the column | `DriveModeOverlay.tsx`, `DriveModeDictate.tsx`, `voiceLayout.ts` |
| 3 | **Switch session** on the addressed surface and on every lane row: the picker opens over the mounted lanes (phase untouched), swaps only that lane's slot, and the pane follows | `DriveModeOverlay.tsx`, `LaneStrip.tsx`, `DriveModeDictate.tsx` |

Supporting changes: the picker takes a title so the two flows name themselves
("Add a lane" / "Switch session"); the resolved layout value is `desktop` (was
`split`) and the minimum width constant is `DESKTOP_MIN_WIDTH`; the pane and the
surface expose `data-drive-session` / `data-testid="drive-mode-surface"` for
observability.

## Evidence

### Unit / static

- client suite **1368/1368** green (127 files), including 40+ assertions added
  for this work.
- `tsc --noEmit` clean in `client`; `eslint` clean on every changed file.
- client coverage thresholds comfortably met (lines 74.3 ≥ 56, functions
  64.5 ≥ 53, branches 79.1 ≥ 74).
- Docs: `docs:check-agent-guides` and `docs:check-links` pass.

### Real browser (disposable server + real pi turn)

`operations/voice-desktop-20260916/harness/desktop-lanes.mjs` — **23/23
assertions passed**, `evidence/desktop-lanes.json`, screenshots `shots/01–09`.

The decisive ones:

- the pane's tool group is the **same element id and the same summary text** as
  the regular chat view's for the same session
  (`tool-group-toolu_bdrk_01VZf1r2vJd5dzHfuZHzmznL`, "Ran 3 commands(3 tools)");
- desktop holds **three lane rows** with cap "3 of 3" **and** the session pane,
  at 1440×900 and 1440×1140;
- switching a lane's session leaves **three lanes** with only that slot changed,
  makes it the addressed lane, and the pane re-points to it (and back again when
  the tool-run worker is re-addressed);
- mobile keeps the lanes and renders **no** pane.

### What was NOT covered

- Live microphone/audio paths were not re-validated here (unchanged by this
  work); the harness uses Chromium's fake media devices.
- The talker/floor/confirmation-card behaviour inside the desktop layout was
  previously validated (Child V, 2026-09-15) and is unchanged by this rework.

## Findings worth keeping

1. **The raw pane was a rendering-path defect, not a data defect.** The pane
   used the legacy flat `MessageList`; the chat screen uses
   `VirtualizedMessageList`, which is where tool runs group. One renderer is the
   fix.
2. **The desktop layout could not hold lanes at all** — its branch rendered no
   `LaneStrip`, so the "+" did not exist there.
3. **A pi model on the disposable server must be requested by its OpenRouter
   selector** (`openrouter/<vendor>/<model>`); the bare vendor id resolves to the
   native provider and produced empty turns that look like a UI bug.
4. **Harness hygiene**: an open Playwright context keeps Node alive after a
   fatal, which left four zombie harnesses; the harness now closes the context on
   every exit path and uses a per-run browser profile.
5. **CI was already red before this work**: the changed-source warning ratchet
   failed on master at `aada20d` (one ESLint error in the 2026-09-15 operations
   archive plus the global warning ceiling). Fixed here: the inner-declaration
   error is corrected, and `operations/**` harness files get the same
   `no-console` exemption as `scripts/**` (their console output is the point of
   a CLI driver). Ratchet now reports 318 ≤ 326 with no violations.

## Production

Deployed with `scripts/restart-pi-web-ui.sh --reason …` after verifying a
genuinely drained production (busy sessions counted from `/sessions`, never
`activeTurns`, which read 0 while a pinned session was mid-turn — measured again
today: `activeTurns 0` beside one running pinned session in `/root/si`).

Deploy verification (all three independent):

| Check | Result |
|---|---|
| Service + health | `pi-web-ui.service` active, `/api/health` 200, Internal API contract 1.44.0 |
| Bundle identity | production serves `assets/index-C18SauY2.js`, byte-identical to the freshly built `client/dist/assets/index-C18SauY2.js`, and that bundle contains the new markers (`drive-session-panel`, `drive-mode-column`, `drive-switch-session`, "Switch session", "Add a lane") |
| Real browser | `harness/prod-smoke.mjs`: HTTP 200, React mounted, login screen rendered, zero page errors (only the expected pre-auth 401) |

Production was `:3456` (`node server/dist/index.js`), so a deploy is
`npm run build` + the audited restart. The restart recorded its requester
(`RESTART-REQUESTED … reason=deploy Voice Mode desktop session pane …`).

## Follow-up round (operator, same day: "will every lane give its headlines?" + "quick switching … I don't see that yet")

### F1 — a real defect in multi-lane speech, fixed

**Question asked:** with two or three lanes open and only Headlines on, does every
lane read its headlines at its own turn, regardless of the selected lane?

**Answer, from the code:** yes for speaking — every lane is a mounted voice
surface with its own answer reader, so each lane speaks when ITS session finishes
a turn, whichever lane is addressed; the answers queue through the one shared
voice. **But** the shared "already spoken" record was keyed on the words only
(`spokenLedger.claim(text)` in the default content scope), so two lanes answering
with the SAME words collapsed into one speaker: the second lane was silent.

**Fix:** the content scope is now per lane — `contentScopeFor(laneKey)` in
`client/src/lib/spokenLedger.ts`, passed by `DriveModeDictate` to the answer
reader (`contentScope`) and to read-aloud (`useReadAloud(id, ledgerScope)`).
Within one lane the auto path and read-aloud still share a scope, so P16's
never-say-it-twice rule is unchanged; two lanes are now two events.

**Evidence:** `client/tests/unit/components/DriveMode/DriveModeDictate.lanes-speech.test.tsx`
— 4 tests (identical short answers in two lanes; different answers in two lanes;
identical Headlines digests in two lanes; one lane's read-aloud vs its own
auto path). All 4 fail with the scope removed (verified by neutering
`contentScopeRef.current`) and pass with it. Client suite 128 files / 1372 tests.

Browser evidence (`evidence/desktop-lanes.json`, `shots/10-every-lane-speaks.png`):
with Worker Alpha selected, both Alpha and Bravo were asked the same question over
the Internal API; the recorder on the real `speechArbiter` shows an answer-tier
submission from EACH lane (`<laneSessionId>answer-auto-0`), i.e. a lane that was
not selected spoke at its own turn. Byte-identical answers from two real pi turns
are NOT asserted in the browser: this host's global Agent OS hooks inject
recall/capture text into a pi turn, so two real turns cannot be made
word-for-word identical here (the step records the observed text). The strict
collision case is pinned by the unit tests above.

**Found and reported, not changed (F3):** the reading level is per session.
Setting Headlines while addressing one lane sets *that* lane's level; other lanes
keep their own level, or the shared default (Summary) if they never had one. A
lane added later starts from the shared default.

### F2 — the switch was there but unfindable

The per-lane switch existed (icon-only `RefreshCw`) and the surface had a small
grey "Switch session" pill. Operator: "I don't see that yet."

- every lane row now shows a labelled **"Switch"** control (word from `sm` up,
  icon on phones so the 430px row still fits) — `data-testid="lane-switch"`;
- the addressed surface's **"Switch session"** is a named blue action under the
  worker's name with a tooltip — `data-testid="drive-switch-session"`.

Pinned by `LaneStrip.test.tsx` ("the switch control is labelled…") and
`DriveModeDictate.switch-session.test.tsx`, and asserted in the real browser:
`laneSwitchLabels: ["Switch","Switch","Switch"]` with all three labels actually
rendered at 1440, and all three rows still carrying the control at 430.
