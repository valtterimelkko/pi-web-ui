# Phase 3 live validation — control actions lazy-load (S5 live evidence)

- Date: 2026-09-24, disposable server `/tmp/pi-validation-p1` (source mode, Phase 3 build), session registered but not loaded after server restart (the incident shape), fixture still holding the fence.
- Session: `01a0d3ae-dc54-76c3-8b50-91e8c0c82699`

## set_thinking_level on the unloaded session (the Phase 0 RED-3 call)

Phase 0 RED (unmodified master): `404 SESSION_NOT_FOUND "Pi session not loaded"` in 0.0077s.

Phase 3 build:

```
{"success":true,"action":"set_thinking_level","level":"high"}
HTTP 200 in 0.478883s
```

The lazy-load follows the dispatch-path pattern (subscribe internal client → re-apply stored model binding outside the model lock → act → hand the load back).

## Create-time thinkingLevel read-back (S5 investigation conclusion)

- `POST /sessions {runtime:'pi', model:'zai/glm-5.3-flash', thinkingLevel:'max'}` → **201** with `"thinkingLevel":"max"` — the level sticks on the current tree; the historical "reads back null" observation is explained by the create response never carrying a thinkingLevel field at all (the request value was persisted to session meta but never echoed).
- Fix: the create response now echoes the **actual post-clamp level** read from the runtime, or `thinkingLevel: null` plus a `thinkingLevelNote` explaining that the model reported no active level for the requested effort.
- Control create: `{thinkingLevel:'high'}` on the default model → echoes `"thinkingLevel":"high"`.

Raw evidence: `live-p3-thinking.txt`, `live-p3-create-flash-max.txt` in this directory.
