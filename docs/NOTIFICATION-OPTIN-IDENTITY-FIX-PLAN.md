# Plan: Fix notification opt-in desync (Pi dual-id) via canonical `pi:<uuid>` identity

> **Status:** ready for execution. **Owner runtime of the bug:** Pi (Claude / OpenCode /
> Antigravity are unaffected). **Approach:** normalize the notification opt-in identity
> to the same stable bare-UUID that the v2 session-metadata layer already uses — **do not
> change `session.id`, do not touch rename/pin/archive.** TDD-first: write the failing
> test, then the code, then validate (unit → lint → typecheck → build → live).

---

## 0. TL;DR for the executing agent

The notification bell in the sidebar goes out of sync (shows **off** after a reload even
though notifications keep arriving, and can't be turned off) because **Pi sessions carry
two identifiers** and the opt-in is keyed on whichever one the sidebar happens to show:

- **Live / just-created session** → sidebar `session.id` = the file **basename**
  `2026-07-02T17-16-54-733Z_019f23d5-…` (the Pi SDK runtime `session.sessionId`).
- **After reload** → sidebar `session.id` = the **bare UUID** `019f23d5-…` (the
  `type:"session"` header `.id`, emitted by the server's session-list cache).

The opt-in is stored under whatever id was showing at click time. On reload the id flips,
the toggle's `GET` looks up under the other form, finds nothing → shows **off**. The Pi
event observer is keyed on the **file path** (stable), so notifications keep firing — hence
"off in the UI but still notified," plus double-notify when the operator re-toggles.

**The fix:** make the notification opt-in identity for Pi always the **bare UUID**, derived
deterministically from the session **path** (`…_<uuid>.jsonl` → `<uuid>`). This is the exact
canonical identity the recently-shipped v2 metadata model standardized on
(`toV2Key` → `pi:<uuid>`, see `server/src/routes/session-meta.ts`). Because the bare UUID
also equals the reloaded sidebar `session.id`, **deep links keep working with no hook
change**, and existing broken opt-ins **self-heal** after a one-time normalization pass.

**Why not the alternatives** (already evaluated — do not reopen):
- *Change `session.id` to be stable*: rejected. `session.id` is the input to
  `sessionKeyOf()` (`client/src/store/sessionStore.ts:202`), which keys the just-shipped v2
  rename/pin/archive model. Changing it would fork that model's client-side keys and regress
  it. Leave `session.id` untouched.
- *Key notifications by raw path*: works, but then the Telegram deep link
  (`?session=<path>`) no longer matches `useDeepLinkSession`'s `sessions.find(s => s.id ===
  targetId)`. Normalizing to the bare UUID avoids that entirely.

---

## 1. Required reading before writing any code (full paths)

**Docs (read first):**
- `/root/pi-web-ui/docs/NOTIFICATIONS.md` — notification layer contract & architecture.
- `/root/pi-web-ui/docs/SESSION-METADATA.md` — the v2 keyed model + `pi:<uuid>` canonical id
  that this fix aligns to.
- `/root/pi-web-ui/docs/LIVE-VALIDATION.md` — how disposable validation servers + scenarios work.
- `/root/pi-web-ui/CLAUDE.md` — required workflow, security rules, validation shortcuts.

**Canonical identity helper (the thing to reuse):**
- `/root/pi-web-ui/server/src/routes/session-meta.ts`
  - `PI_UUID_RE` (line ~50) and `piSessionIdFromPath(sessionPath)` (line ~58) — extract the
    UUID from a Pi `.jsonl` path. **This is the reference implementation to share.**
  - `toV2Key()` (line ~69) — `pi:<uuid>` construction. Read for the pattern; you don't call it
    from the notification path, you reuse the UUID extraction.

**Server — notification layer:**
- `/root/pi-web-ui/server/src/notifications/notification-manager.ts` — orchestrator;
  `serviceKey()` (line ~223) already keys the Pi observer by **path**; `optIn/optOut/getOptIn`;
  `init()` (line ~98) rehydration — **the migration/normalization pass goes here.**
- `/root/pi-web-ui/server/src/notifications/notification-store.ts` — durable opt-in map keyed
  by `record.sessionId` (`getOptIn`/`setOptIn`/`removeOptIn`). Runtime-agnostic — keep it that way.
- `/root/pi-web-ui/server/src/notifications/types.ts` — `OptInRecord` shape.
- `/root/pi-web-ui/server/src/notifications/notification-formatter.ts` — `buildDeepLink()`
  emits `?session=<sessionId>`. **No change needed** (sessionId becomes the UUID → matches).

**Server — the two entry points that create opt-ins:**
- `/root/pi-web-ui/server/src/routes/notifications-web.ts` — **browser/cookie-auth** route
  (`POST/DELETE/GET /api/sessions/:id/notifications*`). Has `runtime` + `sessionPath` in the
  POST body. **Primary edit site.**
- `/root/pi-web-ui/server/src/internal-api/routes/notifications.ts` — **Internal-API** route
  (token-auth, used by scripts + live validation). Resolves runtime + path from the registry
  (`entry.path`). **Normalize here too so both entry points agree.**

**Client — the toggle + deep link:**
- `/root/pi-web-ui/client/src/components/Sidebar/SessionNotifyToggle.tsx` — the bell. Has
  `sessionId`, `sdkType`, `sessionPath`, `label` props. **Primary client edit site.**
- `/root/pi-web-ui/client/src/components/Sidebar/SessionItem.tsx:463` — where the toggle is
  mounted (passes `session.id`, `session.sdkType`, `session.path`).
- `/root/pi-web-ui/client/src/hooks/useDeepLinkSession.ts` — reads `?session=<id>`, matches
  `sessions.find(s => s.id === targetId)`, switches by `target.path`. **No change required;**
  optional hardening in §6.

**Shared package (where the shared helper lands):**
- `/root/pi-web-ui/shared/src/` (`index.ts` re-exports every module). Add the helper here so
  both client and server import one implementation.

**Existing tests to extend (do not rewrite; add cases):**
- `/root/pi-web-ui/client/tests/unit/components/Sidebar/SessionNotifyToggle.test.tsx`
- `/root/pi-web-ui/server/tests/unit/routes/notifications-web.test.ts`
- `/root/pi-web-ui/server/tests/unit/internal-api/notifications-routes.test.ts`
- `/root/pi-web-ui/server/tests/unit/notifications/notification-manager.test.ts`
- `/root/pi-web-ui/server/tests/unit/notifications/notification-store.test.ts`
- `/root/pi-web-ui/server/tests/integration/notifications-lifecycle.test.ts`
- `/root/pi-web-ui/server/src/live-validation/scenarios.ts` — the `notify-on-agent-end`
  scenario (line ~182).

---

## 2. Ground-truth facts (verified against the live box — trust these)

- File name vs header id, for a real Pi session:
  - basename: `2026-07-02T17-16-54-733Z_019f23d5-624d-7ca3-b34c-53b6732c2b44`
  - header `type:"session"` `.id`: `019f23d5-624d-7ca3-b34c-53b6732c2b44`
  - `piSessionIdFromPath("…/2026-07-02T17-16-54-733Z_019f23d5-….jsonl")` → the bare UUID.
- The reloaded sidebar `session.id` (from `server/src/pi/session-list-cache.ts:117`,
  `id = headerId`) = the **bare UUID**.
- The live-session `session.id` (from `handleNewSession`/`session_created` in
  `server/src/websocket/connection.ts` → `agentSession.sessionId`) = the **basename**.
- `session.path` (both live and reloaded) = the full `…_<uuid>.jsonl` path → so
  `piSessionIdFromPath(session.path)` yields the bare UUID in **both** states. **This is the
  anchor the fix relies on.**
- The v2 metadata layer already normalizes to `pi:<uuid>` and resolves archive/pin/name by
  **path** via `legacyKey` — so this fix does not interact with it. Confirm you are **not**
  editing `sessionKeyOf`, `toV2Key`'s callers, `preferences.ts`, or `session-meta.ts` logic
  (other than possibly re-exporting the shared UUID helper).

---

## 3. Design (what to build)

### 3.1 Shared canonical-identity helper
Create `/root/pi-web-ui/shared/src/notification-identity.ts` (name is a suggestion) exporting:

```ts
/** Extract the Pi session UUID from a `…_<uuid>.jsonl` path. Null for non-Pi/no match. */
export function piSessionIdFromPath(sessionPath: string): string | null;

/**
 * Stable opt-in identity used as the notification key across browser + internal API.
 * Pi: the bare UUID from the path (falls back to the given id if the path has no match).
 * All other runtimes: the id unchanged (their id already equals their path).
 */
export function canonicalOptInId(
  runtime: 'pi' | 'claude' | 'opencode' | 'antigravity',
  sessionId: string,
  sessionPath: string,
): string;
```

- Reuse the exact `PI_UUID_RE` from `session-meta.ts`. To keep **one** source of truth, have
  `server/src/routes/session-meta.ts` import `piSessionIdFromPath` from `@pi-web-ui/shared`
  and re-export it (preserving its current public API; its unit coverage still applies).
  *(Fallback if the import churn is undesirable: duplicate the regex in shared with a
  `// keep in sync with session-meta.ts` comment. Prefer the single-source version.)*
- Wire the new module into `/root/pi-web-ui/shared/src/index.ts`.
- Rebuild shared so client/server pick it up (`npm run build` at root builds workspaces; or
  build the shared workspace explicitly).

### 3.2 Client — `SessionNotifyToggle.tsx`
- Compute `const optInId = canonicalOptInId(sdkType, sessionId, sessionPath)` once.
- Use `optInId` (URL-encoded) in **all three** fetch URLs (GET on mount, POST opt-in,
  DELETE opt-out). **Keep the POST body exactly as today**: `{ runtime: sdkType, sessionPath,
  label }`. The body still carries the real `sessionPath` (the server needs it for the Pi
  observer's `serviceKey`).
- **Nothing else changes.** See §5 for the UI behavior that must stay byte-identical.

### 3.3 Server — `notifications-web.ts` (defense in depth + return value)
- On **POST**, normalize server-side too:
  `const sessionId = canonicalOptInId(runtime, req.params.id, sessionPath);` build the
  `OptInRecord` with that `sessionId` and the real `sessionPath`; return the normalized
  `sessionId` in the response body.
- GET/DELETE only receive `:id`; the client already sends the canonical id, so they key
  consistently. (Do **not** try to normalize GET/DELETE server-side — they lack the path and
  applying the Pi regex to a non-Pi id/path would mis-extract.)

### 3.4 Server — `internal-api/routes/notifications.ts`
- In `handleOptIn`, after resolving `entry` from the registry, set
  `record.sessionId = canonicalOptInId(runtime, sessionId, entry.path ?? sessionId)` so
  Internal-API opt-ins and browser opt-ins land under the **same** key for Pi.

### 3.5 Server — one-time normalization/migration (`NotificationManager.init()`)
- In `init()`, **before** rehydration (`for (const record of optIns) this.attach(record)`):
  1. `const optIns = this.deps.store.listOptIns();`
  2. For each `record`, compute `canonical = canonicalOptInId(record.runtime, record.sessionId,
     record.sessionPath)`.
  3. If `canonical !== record.sessionId`: this is a legacy basename-keyed (or otherwise
     divergent) record. Re-key it: `store.removeOptIn(record.sessionId)` then
     `store.setOptIn({ ...record, sessionId: canonical })`.
  4. **Dedupe:** if two legacy records collapse to the same `canonical`, keep the one with the
     newest `optedInAt`; drop the other (prevents the double-notify husk).
  5. Log one `info` line with the count normalized/deduped.
- Keep the store runtime-agnostic (the runtime awareness lives in the manager, which already
  computes `serviceKey` by runtime). Rehydration then attaches observers from the normalized
  records only → **no duplicate observers → no double-notify.**
- *(Optional, cosmetic):* leave `delivery-log.json`/`outbox.json` `notification.sessionId`
  values as-is; the log is historical. Do not spend effort rewriting them.

### 3.6 Deep link
- No change needed: `notification.sessionId` is now the bare UUID, which equals the reloaded
  sidebar `session.id`, so `useDeepLinkSession`'s `sessions.find(s => s.id === targetId)`
  matches. Add a live check (§7) that tapping the link opens the session after reload.

---

## 4. TDD execution order (write the failing test first, every step)

1. **Shared helper tests** → `shared/src/notification-identity.test.ts`:
   - `piSessionIdFromPath("…/2026-07-02T17-16-54-733Z_019f23d5-….jsonl")` → `"019f23d5-…"`.
   - `piSessionIdFromPath("019f23d5-…")` (bare uuid, no `.jsonl`) → `null`.
   - `piSessionIdFromPath("2026-…_019f23d5-…")` (basename, no `.jsonl`) → `null`.
   - `canonicalOptInId('pi', <basename>, <path>)` → bare UUID.
   - `canonicalOptInId('pi', <bareUuid>, <path>)` → same bare UUID (idempotent).
   - `canonicalOptInId('claude', id, id)` → `id` unchanged. Then implement the helper.
2. **Client toggle test** → extend `SessionNotifyToggle.test.tsx`:
   - New: with `sdkType='pi'`, `sessionId=<basename>`, `sessionPath=<…_uuid.jsonl>`, assert
     **all three** fetches hit `/api/sessions/<uuid>/notifications*` (the desync regression).
   - New: with `sdkType='pi'`, `sessionId=<uuid>` (reloaded form) + same path → also `<uuid>`.
   - Non-Pi: URL id unchanged.
   - **All existing assertions must still pass** (Bell/BellOff/spinner, DELETE on opt-out,
     idle-toast cases, no-toast-while-streaming, `stopPropagation`). Then implement §3.2.
3. **Browser route test** → extend `notifications-web.test.ts`:
   - POST pi with `sessionPath` whose basename differs from `:id` → persisted `record.sessionId`
     is the bare UUID; response `optIn.sessionId` is the UUID.
   - GET/DELETE by the UUID resolve the same record. Non-Pi unchanged. Then implement §3.3.
4. **Internal-API route test** → extend `notifications-routes.test.ts`:
   - pi opt-in where registry `entry.path` is a `…_uuid.jsonl` → `record.sessionId` = UUID.
     Then implement §3.4.
5. **Manager migration test** → extend `notification-manager.test.ts` (and/or
   `notification-store.test.ts` for the store-level dedupe):
   - Seed opt-ins with a pi record keyed by **basename** (+ a duplicate keyed by the **UUID**
     with an older `optedInAt`). Call `init()`. Assert: `getOptIn(<uuid>)` returns the newer
     record; `getOptIn(<basename>)` is `undefined`; exactly **one** observer attached for that
     session (no double-notify). Then implement §3.5.
6. **Integration** → extend `notifications-lifecycle.test.ts`: full opt-in (via live basename
   id) → normalized → `agent_end` → single delivery → opt-out by UUID clears it.

Run continuously: `npm test` (root, all workspaces) plus the targeted files, e.g.
`npm test -w server -- notification` and `npm test -w client -- SessionNotifyToggle`.

---

## 5. UI logic that MUST remain identical (do not change the UX)

The fix changes **only the identifier in the three fetch URLs**. Every observable behavior of
`SessionNotifyToggle.tsx` must stay byte-for-byte the same. Verify each of these is unchanged
(they are the current contract — preserve it exactly):

1. **Icon states:** `BellOff` (gray, `text-gray-400`) when off; `Bell` (blue,
   `text-blue-500`) when on; `Loader2` spinner (`animate-spin`, `opacity-50 cursor-wait`)
   while a request is in flight.
2. **Mount behavior:** on mount, `GET /api/sessions/<id>/notifications` with
   `credentials: 'include'`; `on = Boolean(data?.optIn)`. Failures are swallowed (never break
   the session list). Effect re-keys on the session identity.
3. **Click behavior:** `event.stopPropagation()` (clicking the bell must **not** switch/open
   the session). If currently on → `DELETE …/opt-in`; else → `POST …/opt-in` with body
   `{ runtime, sessionPath, label }`. Only flip local `on` state when `res.ok`.
4. **Idle toast (keep exactly):** when turning **on** and the session is **not**
   `streaming`/`busy` (`useSessionStore … sessionData[id]?.status`), show one `info` toast:
   *"Notifications on — this session is idle, so you'll get notified starting with its next
   reply."* No toast when turning on a streaming/busy session; no toast on opt-out.
5. **`title`/`aria-label`:** "Notifications on — click to turn off" / "Enable agent_end
   notifications"; aria "Disable notifications" / "Enable notifications".
6. **Disabled while loading.**

The new post-fix behavior the operator should observe: **after a reload, the bell reflects the
true server state** (stays on if opted in), **turning it off actually stops notifications**,
and **no double-notifications**. Nothing about the visual/interaction design changes.

---

## 6. Optional hardening (only if cheap; not required for correctness)
- `useDeepLinkSession.ts`: broaden the match to
  `sessions.find(s => s.id === targetId || s.path === targetId)` so a deep link is robust to
  either identifier form. Add a unit test if you do this.

---

## 7. Live validation (REQUIRED — do not skip; this is where past attempts fell short)

Use the Pi Web UI Internal-API orchestration skill — invoke it by name:
**`pi-web-ui-internal-api-orchestration`** (you have this skill under your own path; use the
name, not a path). It covers booting a disposable validation server and driving the runtimes
over the Unix socket.

### 7.1 Browserless runtime validation (all four runtimes)
- Boot a disposable validation server (isolated dirs) per the skill / `docs/LIVE-VALIDATION.md`
  and `CLAUDE.md` "Runtime-aware validation shortcuts".
- Run the `notify-on-agent-end` scenario for `--runtime pi|claude|opencode|antigravity`
  (`server/src/live-validation/scenarios.ts:182`). It proves origin-independent `agent_end`
  delivery still works after the change.
- **Add a targeted regression assertion for the Pi desync:** opt a Pi session in using the
  **live basename** id, then read the opt-in state back using the **bare-UUID** id, and assert
  the record is found (pre-fix this returns null). If the scenario harness can't express both
  id forms, do this via a short orchestration snippet using the Internal-API client.

### 7.2 Real-browser validation of the toggle (the actual user-visible bug)
- Localhost: use **`webapp-testing`** (manages the dev server) for a headless Playwright check;
  for interactive/visual use **`playwright-cli`**. Steps:
  1. Create/open a **Pi** session, send a turn so it's live.
  2. Click the bell → on. Confirm the idle-toast logic matches §5.
  3. **Reload the page.** Assert the bell is **still on** (this is the fix).
  4. Click the bell → off. Trigger another `agent_end`. Assert **no** notification arrives
     (opt-out truly works) and there is **no double** delivery from a stale husk.
  5. Confirm the bell click did **not** switch sessions (`stopPropagation`).
  6. Deep link: from a delivered notification's `?session=<uuid>`, load the app fresh and
     assert `useDeepLinkSession` opens the right session.
- Explicitly diff the observed UI behavior against §5 — the visual states, toast text, and
  click semantics must be unchanged.

### 7.3 Production live validation (operator permits it — use it)
The operator grants permission to validate against **production**. Past agents did an
incomplete job precisely because they avoided prod; do the real thing, carefully:
- **Prod topology (per operator setup — verify before acting):** systemd service
  `pi-web-ui.service`, port **3456**, public host `pi.letsautomate.work`. Redeploy after code
  changes = build then `sudo systemctl restart pi-web-ui.service`.
- The browser **cannot** reach the Internal-API Unix socket; the public URL sits behind an
  external auth gateway. Validate the browser routes on **`localhost:3456`** using a
  **minted-JWT auth cookie** (the operator's established localhost pattern) rather than the
  public URL.
- **Do not disturb the operator's real opt-ins.** The opt-in store is live at
  `~/.pi-web-ui/notifications/opt-ins.json` and the operator actively uses it. Use a
  **throwaway** session for the opt-in/reload/opt-out test and **opt out + confirm cleanup**
  when done. Never delete or rewrite the operator's existing opt-in records; the migration in
  §3.5 must be a superset-preserving normalization, not a reset.
- Confirm on prod: opt in on a live Pi session → reload → bell still on → opt out → no further
  notifications; the migration ran once on restart and left the operator's other opt-ins intact
  (spot-check `opt-ins.json` before/after: same sessions represented, Pi keys now bare UUIDs,
  no duplicate husks).

---

## 8. Final gate (run all before declaring done — from `CLAUDE.md`)
1. `npm run docs:check-agent-guides`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run build`
5. `npm test` (root — client + server + shared workspaces) + the targeted notification tests.
6. Live validation §7 (browserless all-runtimes + real-browser Pi + production).
7. `git status --short`, `git diff --stat`, `git diff --cached --stat`; verify **no** secrets,
   tokens, cookies, session dumps, or local machine files are staged (the repo is public).
8. Update `docs/NOTIFICATIONS.md` with a short note that Pi opt-ins are keyed by the canonical
   bare UUID (aligned with the v2 metadata `pi:<uuid>` identity) and that a one-time
   normalization runs on manager init.

---

## 9. Acceptance criteria
- Opting in on a **live** Pi session and reloading leaves the bell **on** (server state and UI
  agree). Turning it off **stops** notifications. **No double** notifications after re-toggle.
- Telegram deep links open the correct Pi session after reload.
- The four-runtime `notify-on-agent-end` live scenario passes; Pi cross-id read-back passes.
- Claude / OpenCode / Antigravity opt-in behavior is unchanged.
- `sessionKeyOf`, `session.id`, and the v2 rename/pin/archive model are **untouched** and
  their tests remain green (no regression to the last five commits' work).
- All of §8 is green, including production validation with the operator's data left intact.
