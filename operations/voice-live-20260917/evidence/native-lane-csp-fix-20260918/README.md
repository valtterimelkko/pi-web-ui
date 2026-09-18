# Native voice lane — capture under the production CSP (2026-09-18)

**Class:** operator-reported field failure, fixed and live-validated. **Status:** fixed (`5992f84`), deployed.

## The report

> "The native voice lane does not work. Open mic, the button does not work at all. If I click on
> push-to-talk and hold to talk, it claims that I don't have a microphone at all. […] 'start listening' […]
> says microphone unavailable, failed to load worklet module script. A dependency or cross-origin script
> failed to load."

The legacy relay lane kept working throughout, which is the clue that matters: two different capture
paths, only one of them broken.

## Cause (reproduced, not inferred)

`audioWorklet.addModule()` is a **script fetch**, so the page's `script-src` governs it. Production's
policy is helmet's default — `script-src 'self'`, **no `blob:`** — and the capture session's only worklet
URL was a `blob:`. Every dev-server run worked because the dev server sends no CSP at all; the deployed UI
could never start capture. Open mic, *Start listening* and push-to-talk failed together because all three
drive the **same** capture path.

## Evidence (this directory)

Real Chromium, real built bundle, exact production CSP, real UI, fake capture device — served at
`127.0.0.1:3598` from `client/dist` behind a preview proxy that injects the production CSP header
byte-for-byte, proxying API + websocket to a disposable validation server (`--dir /tmp/pi-voice-csp`).

`result.json` records:

| Check | Result |
|---|---|
| Same-origin worklet asset, under the production CSP | `loaded` |
| Blob-URL worklet, same page, same policy | `refused: AbortError: Unable to load a worklet's module.` (**the operator's error, reproduced**) |
| Native lane, **open mic** → `Start listening` | `capture: "live"`, `listening: "true"` |
| Native lane, **push-to-talk** (held) | `capture: "live"` |
| CSP violations in the whole run | none |
| Worklet/CSP console errors, failed requests | none |

Screenshots `0`–`6` walk the same path: login → Voice Mode → the seeded pi session → the native lane
opened → open mic listening → push-to-talk held.

Negative control: the blob refusal above is the old code path in the same page under the same policy —
so the asset is not merely "also present"; it is the path that works.

## Produced by

`voices` mode (conductor) on 2026-09-18, with the readiness of the fixture server recorded in the run
(`result.json` → `testidsAfterOpen`, `consoleWorkletLines`).
