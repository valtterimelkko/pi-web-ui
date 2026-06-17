# Automating OpenCode Model Refresh

> Status: **implemented**
>
> Audience: maintainers keeping Pi Web UI's OpenCode model list current as
> gateways (Kilo Gateway, OpenCode Zen) and upstream labs add models.
>
> Companion to [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md).

## Implemented shape (at a glance)

| Piece | Where |
|---|---|
| Snapshot/diff core (pure, tested) | `server/src/opencode/opencode-model-refresh.ts` |
| Orchestrator (`refreshModels()`: warm cache → idle-aware recycle → diff) | `server/src/opencode/opencode-service.ts` |
| Internal-API endpoint `POST /api/v1/models/refresh` | `server/src/internal-api/routes/models.ts` |
| Weekly CLI (thin socket client, fail-closed) | `scripts/opencode-refresh-models.ts` → `npm run opencode:refresh-models` |
| Persistent weekly scheduler (template) | `deploy/systemd/opencode-model-refresh.{service,timer}` |
| Host-side audit snapshot (ids only) | `~/.pi-web-ui/opencode-model-snapshot.json` (`OPENCODE_MODEL_SNAPSHOT_PATH`) |

Run it by hand any time:

```bash
npm run opencode:refresh-models            # warm cache + idle-aware recycle + diff
npm run opencode:refresh-models -- --json  # machine-readable
npm run opencode:refresh-models -- --no-recycle   # snapshot/diff only
```

## Goal

Whenever an LLM lab ships a new model and a gateway (Kilo Gateway, OpenCode Zen,
…) exposes it, that model should become selectable in the Pi Web UI OpenCode
runtime path **without manual code changes**, on at least a weekly cadence, and
the routing must keep working end to end — no broken model ids, no exposed API
keys, no interrupted sessions.

## TL;DR

- **Model surfacing is already automatic** for any provider on the allowlist
  (`OPENCODE_MODEL_PROVIDERS`, default `zai-coding-plan,kilo,opencode`). Pi Web UI
  reads `/config/providers` live on every `/api/models` call, so it has no model
  cache of its own.
- **OpenCode refreshes its own catalogue on a timer (~daily), without a restart.**
  Empirically observed: a `opencode serve` started at `Jun 16 13:33` had refreshed
  `~/.cache/opencode/models.json` at `Jun 17 12:33` (~23h later) while still running.
- So the only genuinely manual step is **adding a brand-new provider/gateway**,
  because that requires entering a credential (`opencode auth login`) — a secret
  action we should not, and largely cannot, fully automate.
- A small **weekly scheduled job** closes the remaining gaps: force a deterministic
  catalogue refresh, diff what changed, optionally auto-include newly-authenticated
  providers, and gracefully recycle the backend only if needed.

## The refresh chain (where models actually come from)

```text
LLM lab ships model
  -> gateway (Kilo / OpenCode Zen / …) lists it in its API
    -> models.dev registry records it
      -> opencode serve refreshes ~/.cache/opencode/models.json (≈ daily, no restart)
        -> GET /config/providers merges catalogue + authenticated providers (auth.json)
          -> OpenCodeService.getAvailableModels() reads it live (provider allowlist applied)
            -> GET /api/models?sdkType=opencode
              -> browser model picker (fetched when the picker opens)
```

Grounding facts (verified on this host, OpenCode `1.17.7`):

| Fact | Evidence |
|---|---|
| Catalogue is cached locally | `~/.cache/opencode/models.json` (~2.3 MB, sourced from `models.dev`) |
| Running serve refreshes it without restart | serve PID start `Jun 16 13:33` vs `models.json` mtime `Jun 17 12:33` |
| Credentials live only in OpenCode | `~/.local/share/opencode/auth.json` (mode `0600`); Pi Web UI never reads it |
| Pi Web UI holds no model cache | `getAvailableModels()` calls `/config/providers` on every request |
| Provider ids are stable routing keys | `kilo`, `opencode`, `zai-coding-plan`, `nvidia`, `moonshotai`, `openai` |

### Where staleness can still occur

1. **Catalogue TTL lag.** New models can take up to ~1 day to appear because that
   is OpenCode's own refresh cadence. A weekly job that force-refreshes removes
   the guesswork and makes the cadence explicit.
2. **New provider not on the allowlist.** A newly-authenticated gateway will not
   show until its id is added to `OPENCODE_MODEL_PROVIDERS` (or it is set to `all`).
3. **New provider needs newer binary.** Occasionally a provider/capability only
   exists after an `opencode upgrade`.
4. **Browser caching of the picker.** The picker fetches `/api/models` when opened;
   an already-open client won't see changes until it refetches.

None of these require a Pi Web UI **server** restart — our layer is stateless
with respect to models. Items 1–3 are entirely on the OpenCode side.

## Relevant OpenCode CLI levers

```bash
opencode models [provider]   # list available models (great for diff/verify in a script)
opencode auth list           # list authenticated providers (ids only, no secrets printed)
opencode auth login [url]    # add a provider/gateway credential (INTERACTIVE / secret)
opencode upgrade [target]    # upgrade the binary (occasionally needed for new providers)
opencode serve               # the long-lived backend Pi Web UI talks to
```

## What is already done (Tier 0)

Implemented in this repo:

- Provider **allowlist** (`OPENCODE_MODEL_PROVIDERS`) at the service layer; default
  includes Kilo Gateway and OpenCode Zen. New **models** within an allowlisted
  provider appear with **zero** config.
- Slash-bearing gateway model ids (e.g. `kilo/meta-llama/llama-3.1-8b-instruct`)
  are preserved through dispatch.
- `thinking` config writes are scoped to `zai-coding-plan` so enabling other
  gateways can't corrupt `opencode.json` for models that don't support that option.

This already satisfies "new models become selectable automatically" for the
configured gateways once OpenCode's catalogue updates.

## The weekly job (Tier 1 — implemented)

A single idempotent run, driven by a systemd timer (weekly). It owns
**determinism, verification, and surfacing**, not credential entry. The logic
lives in `OpenCodeService.refreshModels()` behind `POST /api/v1/models/refresh`;
`scripts/opencode-refresh-models.ts` is the thin scheduled client.

### Responsibilities

1. **Force a catalogue refresh** (don't wait for the ~daily TTL):
   - simplest: `rm -f ~/.cache/opencode/models.json` then `opencode models >/dev/null`
     to repopulate, or `opencode upgrade` if a binary bump is also desired.
2. **Verify the backend reports the fresh catalogue**:
   - call `GET /config/providers` on the running serve and confirm provider count
     and a sample of expected ids; fail closed (log + alert) if the endpoint is
     unreachable or empty.
3. **Diff and record what changed**:
   - compare the new model id set per allowlisted provider against the previous
     run's snapshot (stored under `~/.pi-web-ui/opencode-model-snapshot.json`);
     log additions/removals. This is the "did anything change" signal and the
     audit trail.
4. **Recycle the backend only if required**:
   - if `/config/providers` already reflects the refresh (the common case — serve
     re-reads the catalogue), do nothing.
   - otherwise trigger a **graceful** recycle. The process manager already supports
     idle-aware recycling (`OPENCODE_SERVER_MAX_UPTIME_MS`) and **defers while any
     session is running**, so reuse that path rather than a blind `kill`.
5. **Surface to the browser**:
   - no server restart needed; the next time a client opens the picker it refetches
     `/api/models`. Optionally emit a lightweight "models updated" notice.

### New providers (the one semi-manual step)

Adding a brand-new gateway is two actions, only the first of which is secret:

1. `opencode auth login` and paste the key — **must stay manual/operator-driven**;
   the key is written to `auth.json`, never to this repo. (A locked-down host could
   script this by reading a key from a secret manager into `opencode auth login`'s
   input, but the secret must come from a vault, never from tracked files.)
2. Make it visible in the UI — either:
   - set `OPENCODE_MODEL_PROVIDERS=all` once, so every authenticated provider is
     surfaced and **no future edit is ever needed** (recommended for a single-user
     deployment that trusts its own `auth list`); or
   - have the weekly job reconcile the allowlist from `opencode auth list`,
     appending newly-authenticated provider ids to a managed list and (optionally)
     prompting before widening exposure.

### Scheduling (systemd timer)

Templates live in `deploy/systemd/`. Install host-specific copies (kept out of the
repo) and enable the timer:

```bash
sudo cp deploy/systemd/opencode-model-refresh.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-model-refresh.timer
systemctl list-timers opencode-model-refresh.timer   # confirm next run
journalctl -u opencode-model-refresh.service          # see diffs / errors
```

`OnCalendar=Mon *-*-* 04:30:00` with `Persistent=true` so a run missed while the
host was off fires on next boot. Adjust the day/time in the `.timer`. The service
unit's `PATH` must include both `node`/`npm` and the `opencode` binary (for the
cache-warm step). cron works too (`@weekly cd /path && npm run opencode:refresh-models`).

## Robustness considerations

- **Fail closed, never break routing.** If a refresh produces an empty/garbled
  catalogue, keep the previous snapshot and alert; never let the picker end up empty.
- **Don't interrupt running work.** Only recycle via the idle-aware path; check
  for active sessions first.
- **No secret exposure.** The job reads provider *names* (`opencode auth list`,
  `/config/providers`) and model ids only — never key material. Snapshot/diff files
  contain ids, not secrets, and live under `~/.pi-web-ui/` (host-only).
- **Capability awareness (optional polish).** `/config/providers` includes
  `capabilities` (`reasoning`, `toolcall`, `input.image`, …) and `cost`. The job
  (or `getAvailableModels`) could tag free models and filter out non-tool-call
  models so the picker only offers models that actually work for agentic use.
- **Binary drift.** Track the installed `opencode --version`; if `opencode upgrade`
  runs, re-verify the API shape (`/config/providers` is large and occasionally
  reshaped between versions — the service already tolerates array/dict forms).
- **Idempotence.** Re-running the job with no upstream changes must be a no-op
  (diff empty, no recycle).

## How it actually works

`refreshModels()` (in `opencode-service.ts`), invoked via `POST /api/v1/models/refresh`:

```text
1. fail closed if OpenCode is unavailable
2. (warmCache, default on) spawn `opencode models` to refresh the on-disk cache
3. (recycle, default on) if no session is running, recycle the backend so it
   reloads the catalogue; if a session is running, skip and report recycleDeferred
4. read getAvailableModels() (allowlist applied) -> build snapshot {provider: [ids]}
5. read previous snapshot (OPENCODE_MODEL_SNAPSHOT_PATH), diff added/removed
6. persist the new snapshot; return { counts, recycled, diff, ... }
```

The pure pieces — `buildModelSnapshot`, `diffModelSnapshots`, `read/writeSnapshot`
— live in `opencode-model-refresh.ts` and are unit-tested independently of the
backend. The scheduler (`scripts/opencode-refresh-models.ts`) is a thin client
that calls the endpoint over the Unix socket and exits non-zero on failure.

A future enhancement is a UI "refresh models" button that hits the same endpoint,
making the scheduler just one of several triggers.

## Open questions — resolved

1. **Does deleting `models.json` force a re-fetch on a running server?**
   **Answered (verified on OpenCode 1.17.7):** `opencode models` (a separate
   process) re-fetches models.dev and rewrites `~/.cache/opencode/models.json`,
   but the **running `opencode serve` serves its catalogue from memory** and does
   not re-read the file per request. A serve started `Jun 16 13:33` had refreshed
   the cache itself by `Jun 17 12:33` (~daily timer). → The weekly job both warms
   the cache (`opencode models`) **and** recycles the backend so the fresh
   catalogue is actually served. This is exactly what `refreshModels()` does.
2. **Does the running serve pick up a newly-authenticated provider without a
   recycle?** Treated conservatively as "no" — the idle-aware recycle in
   `refreshModels()` covers both new models and newly-authenticated providers.
3. **Single-user `all` vs managed allowlist?** **Decision:** keep the curated
   default (`zai-coding-plan,kilo,opencode`) since that covers the stated goal
   (Kilo + Zen), and the refresh **diff surfaces any newly-authenticated provider**
   so an operator can opt in by adding its id or setting `OPENCODE_MODEL_PROVIDERS=all`.
   New *models* within already-allowlisted providers need no action at all.

## What to read next

- [`./OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md) — auth
  storage, credential-safe routing, the allowlist.
- `server/src/opencode/opencode-service.ts` — `getAvailableModels()` and the
  allowlist resolver.
- `server/src/opencode/opencode-process-manager.ts` — idle-aware recycle logic.
</content>
</invoke>
