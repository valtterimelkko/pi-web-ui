# Session Metadata Model (v2)

> How Pi Web UI stores and syncs the three pieces of per-session user metadata:
> **archived**, **pinned**, and **display name**.

This document covers the unified **v2** model. For the write/sync channel see
[`CODEBASE-MAP.md`](./CODEBASE-MAP.md); for the original incident context see
[`SESSION-METADATA-UNIFICATION-PLAN.md`](./SESSION-METADATA-UNIFICATION-PLAN.md).

---

## 1. Goals (why v2)

Three metadata fields used to live in three parallel structures with three
different sync rules. That fragmentation caused two real bugs:

1. **Archive/unarchive reverted on reload** — `patchPreferences` sent the whole
   `archivedSessionPaths` array (and later `sessionDisplayNames`) with
   `fetch(..., { keepalive: true })`; the browser rejects any in-flight
   keepalive body over **64 KiB**, so once those structures grew large the write
   was silently dropped (`TypeError: Failed to fetch`).
2. **Cross-device resurrection** — display names used a `local-wins` merge on
   load, so a stale value in one device's `localStorage` could overwrite a fresh
   rename from another device.

v2 fixes both structurally: **one keyed model, one write channel, one sync rule.**

---

## 2. The model

### Durable server file: `web-ui-prefs.json` (v2)

```jsonc
{
  "version": 2,
  "sessions": {
    "pi:019f28dd-…":     { "archived": true,                 "updatedAt": 1751560000123, "legacyKey": "/root/.pi/agent/sessions/…/….jsonl" },
    "claude:28bdeecd-…": { "pinned": true, "displayName": "Refactor", "updatedAt": 1751560111222, "legacyKey": "28bdeecd-…" }
  }
}
```

- **Key = `${runtime}:${sessionId}`** (`runtime` ∈ `pi|claude|opencode|antigravity`).
  - Pi sessions are keyed `pi:<uuid>`, where the uuid is the one in the `.jsonl`
    filename (which equals the `type:"session"` header id). This makes metadata
    **immune to Pi renaming the `.jsonl` file**.
  - Non-Pi sessions are keyed `<runtime>:<id>` (their path already equals the id).
  - Unresolvable bare ids land under `unknown:<id>`: preserved (lossless) but
    never matched against a sidebar session.
- **Per-record `updatedAt`** (epoch-ms) → **last-writer-wins** conflict
  resolution, enforced server-side on every delta write. A briefly-offline
  device's newer write is no longer lost to an older one.
- **`legacyKey`** preserves the original v1 key (path or id) so the compatibility
  window can re-derive the exact v1 arrays (a lossless round-trip).
- Absent fields mean "not archived / not pinned / no custom name".

The substrate is still **one JSON file + mutex + atomic tmp-rename**
(`withPrefsLock`). SQLite is the documented ceiling and is **not** implemented.

### One write channel: atomic per-item deltas

All mutations go through small, atomic, mutex-guarded server ops (never a
whole-object client write):

```
POST /api/preferences/archive     { sessionPath } | { key }
POST /api/preferences/unarchive   { sessionPath } | { key }
POST /api/preferences/archive-all { sessionPaths }            (non-keepalive; bulk)
POST /api/preferences/pin         { sessionPath } | { key }
POST /api/preferences/unpin       { sessionPath } | { key }
POST /api/preferences/display-name { sessionPath, name } | { key, name }   (name:null clears)
```

Each single-item body is a few hundred bytes — far under the 64 KiB keepalive
quota — so a rename/archive/pin survives an immediate hard-refresh. Endpoints
accept the **stable `key`** (Phase-2 clients) or the legacy **`sessionPath`**
(the server maps path→key via the session registry). Archiving auto-unpins.

### One sync rule

- **On load: adopt the server map.** `localStorage` is a pure offline read-cache;
  it is **never merged back** into the server. This single rule removes the whole
  "stale local resurrection" class.
- **Write failures are surfaced, not swallowed:** the client retries with backoff
  and, on final failure, **reverts the optimistic local change** so the client
  stays server-authoritative instead of silently desyncing.

---

## 3. v1 → v2 migration

Migration is **on read** (`readPreferences`): the first time a v1 file is seen it
is converted to the v2 `sessions` map and rewritten atomically, with a
`web-ui-prefs.json.v1.bak` backup for reversibility. It is **lossless** — the v1
arrays re-derived from the migrated v2 map are byte-equivalent to the original
(verified against a real copy of the production file). Runtime resolution for
bare ids uses the session registry; Pi paths map to `pi:<uuid>` via the filename.

`GET /api/preferences` returns the v2 `sessions` map **and** the derived legacy
arrays, so any still-cached older client bundle keeps working (compatibility
window) until a follow-up removes the legacy projection.

---

## 4. Session cleanup

`session-cleanup.ts` derives the pinned/archived sets from the v2 map (each
record's `legacyKey` is the path used for registry/fs lookups), preserving the
existing semantics: auto-unpin a pinned session after **24h** inactivity, and
auto-delete an archived session after **90d**.
