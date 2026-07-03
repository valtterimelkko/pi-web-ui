# Session Metadata Unification — TDD Execution Plan

> **Audience:** an execution agent implementing this end-to-end.
> **Status:** approved plan, not yet started.
> **Golden rule:** this plan is only "done" when it is **proven working by live
> validation against a real browser** — not when the tests pass. You are known
> to declare victory early. Do not. Every phase has a **Quality Gate** and a
> **Live Validation** section that are *mandatory*, blocking, and must be
> reported with evidence (actual command output / observed values), never
> asserted from intent.

---

## 0. Why this exists (read this first)

Three pieces of **per-session user metadata** — **archived**, **pinned**, and
**display name** — are currently stored and synced by **three different
mechanisms with three different conflict policies**. That fragmentation has
already produced two production bugs:

1. Archive state differed per device / would not stick (fixed in commit
   `e644b1e`, but *misdiagnosed* — see below).
2. Archive/unarchive silently reverted on reload. **Real root cause:**
   `patchPreferences` sent the *entire* `archivedSessionPaths` array with
   `fetch(..., { keepalive: true })`; the browser enforces a **64 KiB quota
   shared across all in-flight keepalive requests** and rejects anything over it
   with `TypeError: Failed to fetch`. The `.catch` only `console.warn`ed, so the
   write never reached the server. Fixed in commit `9f4d54b` by moving **archive**
   to atomic per-path **delta endpoints**.

**Display names still ride the exact same landmine** (unbounded map + whole-object
keepalive PATCH), and **display names still use a `local-wins` merge** that can
resurrect a stale value across devices — the same class of bug we just fixed for
archive. This plan finishes the job: **one metadata model, one write channel,
one sync rule**, for all three — while keeping the **user-facing behavior of
pins and display names byte-for-byte identical**.

The misdiagnosis in `e644b1e` is the cautionary tale for this whole plan: the
previous agent *assumed* a root cause (localStorage union) instead of *proving*
it in a browser. The actual cause (keepalive quota) was only found by reproducing
it in real Chromium against production. **You must reproduce and prove, not
assume.**

---

## 1. Resource signposting (use these — full paths)

### Source you will change
- `client/src/store/sessionStore.ts` — the zustand session store. Relevant:
  - `archiveSession` / `unarchiveSession` / `archiveAllSessions` (already delta-based — the reference pattern to copy)
  - `pinSession` / `unpinSession` / `isSessionPinned` — **pin cap logic lives here (2 per runtime)**
  - `setSessionDisplayName` / `getSessionDisplayName` / `removeSessionDisplayName`
  - `initPreferences` — the three divergent reconciliation branches (archived: server-wins; pinned: server-wins + clean-stale + write-back; displayNames: **local-wins merge**)
  - the WS pin-confirmation handler that calls `get().pinSession(...)` (search `pin_session`)
  - the zustand `persist` `partialize` (search `partialize`) — controls what goes to localStorage
- `client/src/lib/api.ts` — `getPreferences`, `patchPreferences`, `archiveSessionPref`, `unarchiveSessionPref`, `archiveAllSessionsPref`, `postPreferenceDelta` (the delta helper — reuse/extend it)
- `client/src/components/Sidebar/Sidebar.tsx` — active/archived split, `getDisplayName` fallback chain, the "Archive all" button
- `client/src/components/Sidebar/SessionItem.tsx` — `handleArchive`, `handleTogglePin`, `handleStartEdit`/`handleSaveEdit`/`handleKeyDown`, `webUIDisplayName`
- `client/src/hooks/useWebSocket.ts` — `pinSession`/`unpinSession` send `pin_session`/`unpin_session` WS messages
- `server/src/routes/preferences.ts` — the prefs file, `PreferencesSchema`, `PreferencesMutex`, `withPrefsLock`, `readPreferences`/`writePreferences`, the delta helpers `addArchivedPath`/`removeArchivedPath`/`addArchivedPaths`, and the routes
- `server/src/session-cleanup.ts` — reads `prefs.pinnedSessionPaths` (auto-unpin after inactivity) and `prefs.archivedSessionPaths` (auto-delete after 90d). **Must keep working against the new model.**
- `server/src/websocket/connection.ts` — `handlePinSession`/`handleUnpinSession` (~line 2690), `handleGetSessions` (~line 2003) and the per-runtime session `path`/`id` assembly (~lines 2013–2076). This is where `(runtime, sessionId)` is available.
- `server/src/claude/claude-service.ts` — runtime in-memory pin set + `MAX_PINNED_SESSIONS = 2` (mirror exists in opencode/antigravity/pi services)

### Tests you will add/extend
- `server/tests/unit/routes/preferences.test.ts` — note it has **two harness styles**: a re-implemented local router (older tests) and a block that mounts the **real** `default` router via a temp `piAgentDir` (the "Delta archive endpoints" describe). **Use the real-router style for all new endpoint tests.**
- `client/tests/unit/store/sessionStore.test.ts` — the `initPreferences` describe mocks `../../../src/lib/api`; extend that mock for any new api functions.
- Client tests **must be run with the client vitest config** (jsdom). From repo root, `Storage`/`localStorage` are undefined and 2 tests fail spuriously. Run client tests as: `cd client && npx vitest run`.

### Config / prod facts
- Durable prefs file (prod): `/root/.pi/agent/web-ui-prefs.json` (= `config.piAgentDir` + `web-ui-prefs.json`). **~461 archived paths, ~120 KB — do not corrupt it.**
- Prod service: systemd `pi-web-ui.service`, port **3456**, host `pi.letsautomate.work`. `ALLOWED_ORIGINS=https://pi.letsautomate.work`.
- Env: `/root/pi-web-ui/.env.production` (contains `JWT_SECRET`, `AUTH_PASSWORD` as bcrypt — you cannot log in with a plaintext password).
- **Deploy = build + restart:** `npm run build` then `sudo systemctl restart pi-web-ui.service`. Verify with `systemctl is-active pi-web-ui.service` and `journalctl -u pi-web-ui.service -n 20 --no-pager`.
- Playwright chromium is installed at `/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome` (via `node_modules/playwright-core`).

### Docs to read before touching the areas they cover
- `CLAUDE.md` (root) — workflow + non-negotiable security rules
- `docs/CODEBASE-MAP.md`, `docs/ARCHITECTURE.md`
- `docs/PROTOCOL.md` — WebSocket message contracts (pin flow)
- `docs/LIVE-VALIDATION.md` and `docs/INTERNAL-API-ORCHESTRATION.md` — browserless runtime validation
- `docs/OBSERVABILITY.md` — logs/error codes for diagnosing failures

### Live-validation skill (signpost by NAME only — you have it under your own path)
- Use the skill named **`pi-web-ui-internal-api-orchestration`** for browserless
  orchestration / Internal-API-driven live validation (fan-out, runtime checks,
  dispatch-and-verify). Invoke it by name; do not hardcode a path.

---

## 2. Target architecture (the whole thing, end state)

**One model, one key, one write channel, one sync rule.**

### 2.1 Durable server model (`web-ui-prefs.json` v2)
Replace the three parallel structures with a single map keyed by a **stable
session identity**:

```jsonc
{
  "version": 2,
  "sessions": {
    "pi:019f28dd-…":     { "archived": true,                 "updatedAt": 1751560000123 },
    "claude:28bdeecd-…": { "pinned": true, "displayName": "Refactor", "updatedAt": 1751560111222 }
  }
}
```

- **Key = `${runtime}:${sessionId}`** (`runtime` ∈ `pi|claude|opencode|antigravity`).
  This is immune to Pi `.jsonl` filename changes and is meaningful cross-runtime.
  Both `sdkType` and `id` are already present in `handleGetSessions` and in the
  client `Session` objects.
- Per-record **`updatedAt`** enables **last-writer-wins (LWW)** conflict
  resolution → true multi-device convergence, including a change made on a
  briefly-offline device (which naive "server always wins" would lose).
- Absent fields mean "not archived / not pinned / no custom name".

### 2.2 One write channel: atomic per-item deltas
All mutations go through small, atomic, mutex-guarded server ops (never a
whole-object client write). Generalize the pattern already shipped for archive:

```
POST /api/preferences/mutate
  { key, field: "archived"|"pinned"|"displayName", value, updatedAt }
```
(or discrete endpoints per field — implementer's choice, but **one consistent
mechanism**). Server applies LWW (`if incoming.updatedAt >= stored.updatedAt`),
persists atomically via `withPrefsLock`, returns the updated record (or full
map). Bulk "archive all" stays a **normal, non-keepalive** fetch with the full
list (large body is fine without keepalive).

### 2.3 One sync rule + localStorage demotion
- **On load: adopt the server map** (LWW-merge by `updatedAt`; if you keep it
  simpler, server-wins). Delete all three bespoke `initPreferences` branches.
- **localStorage becomes a pure offline read-cache** of the last GET. It is
  **never merged back** into the server. This single change structurally removes
  the entire class of "stale local resurrection" bugs (the root of both prior
  incidents).
- **Write failures are surfaced, not swallowed:** retry with backoff; on final
  failure, **revert the optimistic local change** and show a subtle,
  non-blocking indication. No more silent `console.warn`-and-diverge.

### 2.4 Persistence substrate
Keep the **single JSON file + mutex + atomic tmp-rename** for now — it is
consistent with the rest of the app (the session registry is JSON too) and fine
at ~1k sessions. **SQLite** (`session_prefs(key PK, archived, pinned,
display_name, updated_at)`, per-row upserts, no full-file rewrite) is the
theoretical ceiling and is documented in **Phase 3** as *optional, scale-gated,
do-not-implement-unless-asked*.

---

## 3. The UX contract that MUST NOT change

Live validation must confirm each of these still behaves exactly as today. Copy
this list into your validation checklist and tick every item **in a real
browser**.

### 3.1 Archive (already shipped — must not regress)
- Sidebar splits sessions: **active** = sessions whose key is *not* archived;
  **Archived** = archived ones (`Sidebar.tsx` split logic).
- The **Archived** section is collapsible (chevron rotates), shows a **count
  badge**, and only appears when there are archived sessions or it's expanded.
  Archived list scrolls within ~200px max-height.
- Per-session archive/unarchive via the context menu **and** the inline action
  button; icon toggles (`Archive` ↔ `ArchiveRestore`).
- **Archiving a session auto-unpins it** (archived sessions must not consume a
  pin slot).
- The **"Archive all"** button (Sessions header) archives every currently-active
  session after a confirm dialog, then expands the Archived section. Restores
  are one-by-one from the Archived section.
- The text/cwd filter applies to **both** active and archived lists.

### 3.2 Pins (behavior must stay identical)
- **Cap: at most 2 pinned sessions *per runtime* (`sdkType`).** Enforced in the
  client store `pinSession` (counts same-runtime pins; blocks a 3rd) **and** on
  the server per runtime service (`MAX_PINNED_SESSIONS = 2`). Backward-compatible
  fallback: if a session's runtime is unknown, cap at 2 total. **Keep both.**
- Pinning **protects a session from idle cleanup**. Server-side `session-cleanup`
  auto-unpins a pinned session after inactivity (`DEFAULT_PIN_INACTIVITY_MS` =
  24h) using the **durable pin set in prefs** — this must keep working.
- The **flow must stay**: UI toggles pin → `useWebSocket` sends `pin_session` /
  `unpin_session` → server `handlePinSession` updates the runtime service's
  in-memory pin set (process-protection) and broadcasts confirmation → client
  store persists the durable pin. Do **not** collapse the WS runtime hop; only
  change the **durable persistence** underneath (prefs write) to the unified
  delta model.
- Pin/unpin is reflected immediately in the UI (pin icon state) and survives
  reload and other devices.

### 3.3 Display names (behavior must stay identical)
- **Resolution/fallback order (unchanged):**
  `sessionDisplayNames[key]` → `session.name` → `session.firstMessage` →
  `"New session"` (see `Sidebar.getDisplayName`; `SessionItem` uses
  `getSessionDisplayName`). Reproduce this order exactly against the new model.
- Inline rename: enter edit mode (context menu / edit affordance), typing +
  **Enter** or the check button **saves a trimmed** name (empty → no change);
  **Escape** / the X cancels and restores the previous value.
- A saved name persists across reload and across devices. Clearing a name
  reverts to the fallback chain.
- **Behavioral change to fix (this is intended):** display-name conflict
  resolution changes from `local-wins` to the unified LWW/server-authoritative
  rule. This is invisible in single-device use; validate that a rename still
  sticks and that a rename on device B is not resurrected by device A's stale
  cache. This is the *only* intended change in observable multi-device behavior —
  the single-device UX is unchanged.

**If any single-device UX detail above changes, the plan has failed. UX parity is
a release gate.**

---

## 4. Execution phases (TDD, all mandatory gates)

> **TDD discipline:** for every change — write the failing test first, watch it
> fail for the right reason, implement, watch it pass. Keep diffs minimal.
> Never weaken a test to make it pass.

### Standard Quality Gate (run at the end of EVERY phase; all must be green)
1. `npm run typecheck`
2. `npm run lint` — **0 errors** (pre-existing warnings are acceptable; do not add errors)
3. `npm run build`
4. Server tests: `npx vitest run server/tests/unit/routes/preferences.test.ts server/tests/unit/session-cleanup.test.ts`
5. Client tests: `cd client && npx vitest run` (full suite; jsdom). Must stay green (baseline: 681 passing).
6. `npm run docs:check-agent-guides` (AGENTS.md == CLAUDE.md)
7. **Live Validation for the phase (Section 5) — passed with captured evidence.**

**Do not report a phase complete unless all 7 are green and you have pasted the
actual output.** "Should work" / "the tests cover it" is not acceptance.

---

### Phase 0 — Baseline, safety net, and reproduce-the-problem harness
Goal: be able to prove behavior before and after, and never corrupt prod prefs.

1. **Snapshot prod prefs**: copy `/root/.pi/agent/web-ui-prefs.json` to a
   scratch backup and record the archived/pinned/displayName counts. You will
   diff against this after every prod test and **restore it to the exact
   baseline** at the end of each live-validation run.
2. **Stand up the live-validation harness** (details in Section 5): mint a JWT
   from `JWT_SECRET`, drive `http://127.0.0.1:3456` in Playwright chromium.
3. **Reproduce the display-name landmine BEFORE fixing it** (prove the problem,
   don't assume it): in a real browser, issue two concurrent `keepalive` PATCHes
   with a >64 KiB `sessionDisplayNames` body and observe the `TypeError: Failed
   to fetch` rejection. Capture the output. This is your "before" evidence and
   guards against fixing a non-problem.
4. Establish the baseline green Quality Gate on the current tree.

**Gate:** baseline reproduction captured; all 7 gate items green; prod prefs
restored to snapshot.

---

### Phase 1 — Unify the WRITE + SYNC layer (keep path keys, keep legacy storage)
Goal: eliminate the display-name keepalive landmine and the local-wins
resurrection bug; make all three fields use **one write channel** and **one
reconciliation rule** — **without** yet changing the on-disk key/shape. Lowest
risk, highest immediate value.

**Server (TDD):**
1. Add delta endpoints for pins and display names mirroring the archive ones,
   with Zod validation and `withPrefsLock` atomicity:
   - `POST /api/preferences/pin` `{ sessionPath }` (respect nothing about caps
     here — caps stay client + runtime-service; server delta just persists),
     `POST /api/preferences/unpin` `{ sessionPath }`
   - `POST /api/preferences/display-name` `{ sessionPath, name }` and
     `{ sessionPath, name: null }` (or a `DELETE`-style clear) — atomic single-key
     upsert/delete on `sessionDisplayNames`.
   - Reuse the helper pattern of `addArchivedPath`/`removeArchivedPath`.
2. Tests (real-router harness): add/remove/idempotent/clear/validation-400 for
   each, plus a "large display-name map persists in one call" test.

**Client (TDD):**
3. `api.ts`: add `pinSessionPref`, `unpinSessionPref`, `setDisplayNamePref`,
   `clearDisplayNamePref` via the existing `postPreferenceDelta` helper
   (single-item bodies → `keepalive: true`; any bulk op → non-keepalive).
4. `sessionStore.ts`:
   - Route the **durable** pin persistence (the `patchPreferences` call reached
     via the WS `pin_session` confirmation handler and `pinSession`/`unpinSession`)
     through the new delta functions. **Keep the WS runtime hop and the 2/runtime
     cap exactly as-is.**
   - Route `setSessionDisplayName`/`removeSessionDisplayName` through the delta
     functions instead of the whole-object PATCH.
   - `initPreferences`: collapse the three branches into **one** rule
     (server-authoritative on load; localStorage is cache-only, never written
     back). Remove the `local-wins` display-name merge and the pin write-back
     "pump". Keep the "clean pinned-also-archived" invariant, but express it once.
   - Add **failure handling**: on a delta write rejection, retry-with-backoff;
     on final failure, revert the optimistic state.
   - Confirm `partialize` still caches these fields to localStorage as a *read
     cache* only.
5. Update `sessionStore.test.ts` to assert the new delta calls are used and the
   whole-object `patchPreferences` is **not** used for pins/display names
   (regression guard, same shape as the archive guard already there).

**Docs:** update `docs/CODEBASE-MAP.md` (and any prefs/PROTOCOL notes) to
describe the unified delta channel. Keep AGENTS.md == CLAUDE.md.

**Gate:** Standard Quality Gate + Phase-1 Live Validation (Section 5.2).

---

### Phase 2 — Unify the DATA MODEL (stable keys + LWW + migration)
Goal: move on-disk to the `sessions` keyed map (v2), keyed by `(runtime,
sessionId)` with per-record `updatedAt`/LWW. Bigger change, needs migration and
a compatibility window.

**Server (TDD):**
1. Introduce `web-ui-prefs.json` **v2** shape (`version: 2`, `sessions` map).
   Extend `PreferencesSchema` to accept v1 (legacy arrays) **and** v2.
2. **Migration on read**: if a v1 file is seen, convert legacy
   `archivedSessionPaths`/`pinnedSessionPaths`/`sessionDisplayNames` into the
   `sessions` map (write a `.bak` first; migrate atomically). Legacy Pi keys are
   `.jsonl` paths → map to `pi:<sessionId>` using the id derivable from the
   session list / file header (document exactly how; add a test with a real Pi
   path fixture). Non-Pi legacy keys are already ids → `claude|opencode|
   antigravity:<id>`.
3. **Compatibility window**: `GET /api/preferences` returns the v2 `sessions`
   map **and** derived legacy arrays (`archivedSessionPaths`, etc.) so any
   still-cached older client bundle keeps working; accept both legacy path-based
   and new key-based delta writes. Keep this window until you have live-verified
   all clients updated, then a follow-up removes it.
4. Convert the delta helpers + endpoints to operate on records with LWW
   (`updatedAt`); keep the auto-unpin-on-archive invariant.
5. **`session-cleanup.ts`**: update `autoUnpinInactivePinnedSessions` and
   `autoDeleteArchivedSessions` to derive pinned/archived sets from the v2 map
   (via registry lookups by `(runtime,id)`), preserving the 24h/90d semantics.
   Add/extend `server/tests/unit/session-cleanup.test.ts` fixtures for v2.

**Client (TDD):**
6. Introduce a single `sessionMeta` slice keyed by `(runtime, id)` (derive the
   key from each `Session`'s `sdkType`+`id`). Reimplement `isSessionArchived`,
   `isSessionPinned`, `getSessionDisplayName` selectors on top of it.
   **Selectors must return identical results to today for the same sessions.**
7. Update `Sidebar.tsx` split + `getDisplayName` and `SessionItem.tsx`
   handlers to use keys instead of `session.path`. **No visual/interaction
   change.** The `getDisplayName` fallback order stays exactly:
   `custom → session.name → session.firstMessage → "New session"`.
8. Send `updatedAt` on every mutation; adopt LWW on load.
9. Update store tests + add cross-device convergence tests (LWW: newer wins;
   stale local does not resurrect).

**Docs:** update CODEBASE-MAP / PROTOCOL / a short `docs/SESSION-METADATA.md`
describing the v2 model, keys, LWW, and migration.

**Gate:** Standard Quality Gate + Phase-2 Live Validation (Section 5.3),
including a **migration test on a real copy of the prod prefs file** (see 5.3).

---

### Phase 3 — (Optional, scale-gated) SQLite substrate — DO NOT implement now
Documented as the ceiling only. A per-row `session_prefs` table removes the
full-file rewrite and scales to 10k+ sessions. **Do not implement unless the
operator explicitly asks.** If asked later: keep the exact same delta API and
UX; only swap the storage engine behind `withPrefsLock`-equivalent
transactions; migrate JSON → SQLite once with a backup.

---

## 5. Live Validation (mandatory, blocking) — and you MAY use production

> The operator has **explicitly granted production access for live validation**.
> The previous incident happened because an agent could not / did not validate
> against real behavior and *assumed* a root cause. **Do not repeat that.**
> Production is `pi.letsautomate.work` on port 3456 (systemd `pi-web-ui.service`);
> you may inspect it, hit its API, drive it in a browser, rebuild, and restart
> it. **You must restore `web-ui-prefs.json` to its captured baseline after every
> run and confirm the count matches.**

### 5.1 How to drive prod in a real browser (this is the proven method)
Prod sits **behind an external auth gateway** (`auth.letsautomate.work`), so a
public-URL browser gets redirected. **Bypass it by driving the app directly on
`http://127.0.0.1:3456`** (same Node server), which only needs the app's own
cookie:
1. `AUTH_PASSWORD` is bcrypt → you cannot curl-login. Instead **mint a JWT**:
   read `JWT_SECRET` from `/root/pi-web-ui/.env.production` and
   `jwt.sign({ userId: 'default-user' }, secret, { expiresIn: '1h' })` (use the
   repo's `jsonwebtoken`).
2. In Playwright (`node_modules/playwright-core`, chromium at
   `/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`), set cookie
   `accessToken=<jwt>` for domain `127.0.0.1`, then `page.goto('http://127.0.0.1:3456/')`.
3. From that page you can call the app's own API with `credentials:'include'` and
   exercise the **real** fetch/keepalive code path, and drive the **real UI**.
4. Alternatively, for **browserless** orchestration/runtime checks, use the
   **`pi-web-ui-internal-api-orchestration`** skill (disposable validation server
   over a Unix socket). Note the shared-env caveat: a server started here shares
   prod `~/.pi/agent`; isolate `PI_AGENT_DIR` for the validate server or you can
   trigger prod cleanup. For metadata-persistence checks, prefer the direct-prod
   browser method above — it exercises the exact production code and data.

### 5.2 Phase-1 live validation checklist (real browser, prod)
Prove the *mechanism* and the *UX parity*. Capture actual output for each.
- **Keepalive is no longer a landmine:** two concurrent `keepalive` **display-name**
  delta writes → **both HTTP 200** (contrast with the Phase-0 "before" rejection).
- **Persistence round-trips:** set a display name, pin, and archive on throwaway
  test keys via the delta endpoints; GET back → all present; then clear each →
  GET back → all gone. (Use `__verify_*` throwaway keys; do not touch real
  sessions; restore prefs.)
- **UX parity in the actual UI** (Section 3 checklist), especially: rename via
  Enter and via check button; Escape cancels; empty name is a no-op; fallback
  chain renders correctly; pin toggles and the **2/runtime cap blocks a 3rd**;
  archive auto-unpins; "Archive all" + one-by-one restore.
- **No silent failure:** force a delta write to fail (e.g., temporarily point at
  a bad endpoint in a throwaway test) and confirm the optimistic state **reverts**.
- Restore prod prefs to baseline; confirm count matches.

### 5.3 Phase-2 live validation checklist (real browser, prod)
- **Migration on a real copy:** copy the actual prod `web-ui-prefs.json` to a
  temp `piAgentDir`, boot the server against it (isolated), confirm it migrates
  v1 → v2 with **zero loss** (archived count, pinned set, and every display name
  preserved; Pi paths correctly mapped to `pi:<id>`). Diff counts before/after.
- **Compatibility window:** an older-style (path-based, legacy-array) client
  request still works against the v2 server; a new key-based client works; both
  converge.
- **LWW convergence:** simulate device A (older `updatedAt`) and device B (newer)
  writing the same field; newer wins; the stale value does **not** resurrect on
  reload.
- **Cleanup still works:** with the v2 model, `session-cleanup` still auto-unpins
  after inactivity and respects 90d archive retention (unit + a targeted live check).
- Full Section 3 UX checklist again in the real UI (nothing changed for the user).
- Restore prod prefs to baseline; confirm count matches.

### 5.4 Deploy verification
After deploying (`npm run build` + `sudo systemctl restart pi-web-ui.service`):
- `systemctl is-active pi-web-ui.service` → `active`
- confirm the running build contains the new endpoints (grep the built
  `server/dist/routes/preferences.js`)
- re-run one persistence round-trip against the **restarted** prod instance.

---

## 6. Definition of Done (all required)
- [ ] Phases 1 and 2 implemented (Phase 3 only if explicitly requested).
- [ ] All three metadata concerns use **one** write channel, **one** sync rule,
      **one** keyed model; localStorage is cache-only; failures revert.
- [ ] **Every item in the Section 3 UX contract verified unchanged in a real
      browser** — with captured evidence.
- [ ] Standard Quality Gate green with pasted output (typecheck, lint 0-errors,
      build, server tests, full client suite, docs-sync).
- [ ] Live Validation 5.2 and 5.3 passed with pasted evidence; prod prefs
      restored to the captured baseline (count verified).
- [ ] Deployed to prod and verified (5.4).
- [ ] Docs updated; AGENTS.md == CLAUDE.md.
- [ ] Committed to the **existing `master`** branch (no new branches) and pushed.

## 7. Guardrails / anti-patterns (you specifically must avoid)
- **Do not claim done from green unit tests alone.** Live validation in a real
  browser is the acceptance bar.
- **Do not assume the root cause of anything — reproduce it** (Phase 0 exists for
  this reason; it is how the real bug was found and the previous misdiagnosis
  avoided).
- **Do not change single-device UX** for pins or display names. UX parity is a gate.
- **Do not corrupt prod prefs.** Snapshot, and restore to the exact baseline
  after every run; verify counts.
- **Do not reintroduce whole-object keepalive writes** for any unbounded field.
- **Do not create a new branch.** Commit to `master`, push.
- **Keep diffs minimal**; do not weaken or delete tests to go green.
