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
