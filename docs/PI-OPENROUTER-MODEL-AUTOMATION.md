# Automating Pi + OpenRouter Model Refresh

> Status: **implemented**
>
> Audience: maintainers keeping Pi Web UI's **Pi runtime** model list current as
> the OpenRouter gateway and upstream labs add models.
>
> This is the Pi-SDK analogue of the OpenCode automation — see
> [`OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md) for that path.

## Implemented shape (at a glance)

| Piece | Where |
|---|---|
| Pure transform/filter core (fetch → Pi SDK provider config) | `server/src/pi/pi-openrouter-refresh.ts` |
| Orchestrator (`refreshOpenRouterModels()`: fetch → cache → register → diff) | `server/src/pi/pi-service.ts` |
| Cache-load at boot (`loadOpenRouterCache()`) | `server/src/pi/pi-service.ts` |
| Internal-API endpoint `POST /api/v1/models/refresh` (with `runtime=pi`) | `server/src/internal-api/routes/models.ts` |
| Weekly CLI (thin socket client, fail-closed) | `scripts/pi-refresh-openrouter-models.ts` → `npm run pi:refresh-models` |
| Persistent weekly scheduler (template) | `deploy/systemd/pi-openrouter-model-refresh.{service,timer}` |
| Host-side cache (ids + public metadata only) | `~/.pi-web-ui/pi-openrouter-models.json` (`PI_OPENROUTER_MODELS_CACHE_PATH`) |
| Host-side audit snapshot (ids only) | `~/.pi-web-ui/pi-openrouter-model-snapshot.json` (`PI_OPENROUTER_MODELS_SNAPSHOT_PATH`) |

Run it by hand any time:

```bash
npm run pi:refresh-models            # fetch + cache + register + diff
npm run pi:refresh-models -- --json  # machine-readable
```

Or over the Internal API:

```bash
curl --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $(cat ~/.pi-web-ui/internal-api-token)" \
  -H "Content-Type: application/json" \
  -X POST -d '{"runtime":"pi"}' \
  http://localhost/api/v1/models/refresh
```

## Goal

Whenever an LLM lab ships a model and **OpenRouter** exposes it, that model
should become selectable in the Pi Web UI **Pi runtime** model picker **without
manual code changes**, on at least a weekly cadence, and the routing must keep
working end to end — no broken model ids, no exposed API keys, no interrupted
sessions. OpenRouter currently exposes ~300+ models, so the picker relies on its
search box; new models simply flow in.

## TL;DR

- **Model surfacing is automatic.** Pi Web UI fetches OpenRouter's public
  `/api/v1/models` endpoint, transforms it into a Pi SDK provider config, caches
  it host-side, and registers it into the running `ModelRuntime`. New models
  within OpenRouter appear with **zero** config after a refresh.
- **No secrets are stored anywhere in this repo or in Pi Web UI's files.**
  OpenRouter is a *built-in* Pi SDK provider. The **preferred** auth path is to
  authenticate once with the Pi SDK so the key lives in `~/.pi/agent/auth.json`
  (mode 0600, gitignored) — exactly like the OAuth providers (openai-codex,
  anthropic, …). The server reads `auth.json`; no env entry is required. (The Pi
  SDK also auto-detects `OPENROUTER_API_KEY` from the env as an optional
  fallback.) The registered provider config uses an env-reference
  (`$OPENROUTER_API_KEY`) resolved lazily by the SDK, so the cache file and
  snapshot contain **only public model ids and pricing/capability metadata —
  never the key**.
- **A small weekly scheduled job** closes the freshness gap: fetch the live
  catalogue, cache + register it, and diff what changed. Fail-closed: a failed
  fetch never clobbers the existing cache/snapshot with an empty result.
- **The one prerequisite is authenticating OpenRouter (non-secret action):**
  `pi auth login`, which writes the key to the gitignored `auth.json`.
  Registration is gated on `ModelRuntime.hasConfiguredAuth('openrouter')`, so
  models surface only once auth exists.

## The refresh chain (where models actually come from)

```text
LLM lab ships model
  -> OpenRouter lists it in GET https://openrouter.ai/api/v1/models  (public)
    -> pi:refresh-models fetches + transforms + caches it
      -> PiService.refreshOpenRouterModels() registers it into the ModelRuntime
        -> GET /api/models?runtime=pi
          -> browser model picker (fetched when the picker opens)
            -> setModel("openrouter/<model-id>") routes via the Pi SDK
```

Grounding facts:

| Fact | Evidence |
|---|---|
| OpenRouter is a built-in Pi SDK provider | `provider-attribution.js` adds OpenRouter headers for `provider === "openrouter"`; `env-api-keys.js` maps `openrouter → OPENROUTER_API_KEY` |
| Auth lives in auth.json (preferred) | `pi auth login` writes the key to `~/.pi/agent/auth.json`; `ModelRuntime.hasConfiguredAuth('openrouter')` is then true and `ModelRuntime.getAuth()` resolves it. `OPENROUTER_API_KEY` env var is an optional fallback |
| Pi Web UI holds only a public-metadata cache | `~/.pi-web-ui/pi-openrouter-models.json` (model ids, names, context windows, pricing, capabilities) |
| Routing uses the SDK's built-in OpenRouter path | registered config sets `baseUrl=https://openrouter.ai/api/v1`, `api=openai-completions`; the SDK adds `HTTP-Referer` / `X-OpenRouter-Title` attribution |
| Slash/colon-bearing ids round-trip | e.g. `openrouter/openai/gpt-4o:extended` → picker value `openrouter/openai/gpt-4o:extended` → `setModel` splits on the first `/` → `find("openrouter", "openai/gpt-4o:extended")` |

### Where staleness can occur

1. **Catalogue lag.** New models appear only after a refresh runs. The weekly
   job makes the cadence explicit; run `pi:refresh-models` ad hoc for instant
   updates.
2. **Provider not authenticated.** If OpenRouter has no credential in
   `~/.pi/agent/auth.json` (and `OPENROUTER_API_KEY` is unset), models are cached
   (ready) but not surfaced as available — they cannot route without the key.
   Authenticate once with `pi auth login` (writes the gitignored `auth.json`).
3. **Browser caching of the picker.** The picker fetches `/api/models` when
   opened; an already-open client won't see changes until it refetches.

None of these require a Pi Web UI **server** restart — registering is in-process
and the picker refetches on open. (A restart does reload the on-disk cache via
`loadOpenRouterCache()`, which is how models survive reboots without a fetch.)

## What is filtered

OpenRouter exposes endpoints that are not useful for an agentic coding session.
`transformOpenRouterCatalogue()` keeps only **text-output chat models** and
excludes:

- image-generation-only output (`text->image`),
- audio / TTS / music output (`text->audio`, including models that also emit
  text, e.g. music generation),
- embedding / transcription endpoints.

The result is ~300+ selectable models. The filter is a pure, unit-tested
function (`isOpenRouterChatModel`) — loosen or tighten it there.

## How it actually works

`refreshOpenRouterModels()` (in `pi-service.ts`), invoked via
`POST /api/v1/models/refresh` with `{ runtime: "pi" }`:

```text
1. fail closed if surfacing is disabled (PI_OPENROUTER_MODELS_ENABLED=false)
2. fetch the public OpenRouter /api/v1/models catalogue (throws on failure)
3. transform → filter → dedupe → sort into a Pi SDK provider config
4. write the cache (PI_OPENROUTER_MODELS_CACHE_PATH) — public metadata only
5. register the provider into the live ModelRuntime (iff `hasConfiguredAuth('openrouter')`)
6. build a snapshot {openrouter: [ids]}, diff against the previous snapshot
7. persist the snapshot; return { counts, registered, diff, ... }
```

The pure pieces — `transformOpenRouterCatalogue`, `isOpenRouterChatModel`,
`isReasoningModel`, cache read/write, and the shared snapshot/diff helpers — live
in `pi-openrouter-refresh.ts` and are unit-tested independently of the backend.
The snapshot/diff helpers are shared with the OpenCode automation
(`opencode-model-refresh.ts`), since they are provider-agnostic.

At boot, `PiService.initialize()` calls `loadOpenRouterCache()`, which registers
the cached catalogue (if any) so the model list survives a restart without a
network fetch. `registered` in the refresh result tells you whether the live
registry was actually updated (needs the key).

## Scheduling (systemd timer)

Templates live in `deploy/systemd/`. Install host-specific copies (kept out of
the repo) and enable the timer:

```bash
sudo cp deploy/systemd/pi-openrouter-model-refresh.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-openrouter-model-refresh.timer
systemctl list-timers pi-openrouter-model-refresh.timer   # confirm next run
journalctl -u pi-openrouter-model-refresh.service          # see diffs / errors
```

`OnCalendar=Mon *-*-* 04:45:00` (staggered from the OpenCode timer) with
`Persistent=true` so a run missed while the host was off fires on next boot. cron
works too (`@weekly cd /path && npm run pi:refresh-models`). The server resolves
OpenRouter auth from `~/.pi/agent/auth.json` (provisioned once via `pi auth
login`), so no secret needs to live in the service unit's environment.

## Robustness considerations

- **Fail closed, never break routing or empty the picker.** If a fetch produces
  an empty/garbled result or throws, keep the previous cache and snapshot and
  exit non-zero; never overwrite good state with bad.
- **No secret exposure.** The job reads public model metadata only — never key
  material. Cache and snapshot files contain ids and public pricing/capability
  data, and live under `~/.pi-web-ui/` (host-only, gitignored).
- **Idempotence.** Re-running with no upstream change is a near-no-op (diff
  empty; registration is a cheap in-process replace).
- **Don't interrupt running work.** Registration is in-process and does not
  recycle or restart anything; active sessions are unaffected.

## What to read next

- [`./OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md) — the
  OpenCode equivalent (different runtime, same snapshot/diff core).
- `server/src/pi/pi-service.ts` — `refreshOpenRouterModels()` and
  `loadOpenRouterCache()`.
- `server/src/pi/pi-openrouter-refresh.ts` — the pure transform/filter core.
