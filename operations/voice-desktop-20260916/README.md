# Voice Mode desktop rework — live validation record (2026-09-16)

This directory is the evidence record for the operator-requested Voice Mode
rework: the desktop session pane must render the real session view, lanes must
be usable in the desktop layout with a smaller session pane, and any lane's
worker must be switchable in place.

Plan of record: [`docs/plans/VOICE-MODE-DESKTOP-LANES-AND-SESSION-VIEW-PLAN.md`](../../docs/plans/VOICE-MODE-DESKTOP-LANES-AND-SESSION-VIEW-PLAN.md).

## What was validated, and how

Everything here was run against a **disposable validation server** (its own
directory, socket, token and ports) and a dev client whose API proxy points at
it — never production.

```bash
operations/voice-desktop-20260916/harness/boot.sh server   # disposable server + this dir's socket
operations/voice-desktop-20260916/harness/boot.sh client   # vite dev client, proxy -> that server
node operations/voice-desktop-20260916/harness/desktop-lanes.mjs
operations/voice-desktop-20260916/harness/boot.sh stop     # both transient scope units
```

- `harness/boot.sh` — boots both long-running pieces inside transient
  `systemd-run --scope --collect` units (`voicedesk-server`, `voicedesk-client`)
  so they live outside `pi-web-ui.service`'s cgroup, are nameable, and can be
  stopped without touching production. Ports 3521 (server) and 3522 (client),
  directory `/tmp/voice-desktop-srv`.
- `harness/desktop-lanes.mjs` — creates the fixture sessions through the
  Internal API, drives a **real** pi turn that produces a real three-tool group,
  then drives the real UI in Chromium (fake media devices) and asserts from the
  live DOM and the live client store. Screenshots illustrate the evidence; they
  are not the evidence.
- `evidence/desktop-lanes.json` — the machine-readable record: every probe,
  every assertion, every screenshot name, and the run's summary.
- `shots/` — the paired screenshots referenced by that record.
- `logs/` — the disposable server and client logs for the run.

## What the assertions cover

| Claim | How it is proven |
|---|---|
| The desktop pane is the real session view, not raw stream content | The pane's tool-group element ids and summary text equal the regular chat view's for the same session |
| Desktop holds the lane strip and up to three lanes plus the session | Three lane rows, cap "3 of 3", pane present, every lane surface still mounted |
| The session pane is a bottom panel of the voice column | The pane is the column's last child and shares the column with the voice block |
| Mobile is unchanged | No pane in the mobile layout, lanes still present |
| A lane's worker can be switched in place | Three lanes before and after, only the chosen slot changed, the switched lane becomes addressed |
| The pane follows the addressed lane | The pane's own session id equals the addressed lane, and re-addressing the tool-run worker brings its tool group back |
| The desktop voice controls are the compact variant | The surface reports the compact variant while the pane shares the column |

## Known limits

- The turn's tool group requires three or more consecutive tool messages; the
  harness asks the model for three parallel calls in one response so the group
  is produced deterministically. A model that splits the calls with prose would
  weaken the structural comparison.
- The pi model must be requested by its OpenRouter selector form on this
  disposable server; a bare vendor id resolves to the native provider and
  produces empty turns.
- The harness must close its browser context on every exit path. An open
  Playwright context keeps Node alive, and an unmatched parent process stays
  resident — the first runs left four zombie harnesses behind.
