# Child P — create a session and pin it in one go — COMPLETE

**Session** `01a0a42e-e8c7-7422-bc57-0562a081bbea` · **Tree** `/root/pi-web-ui-wt-pin`
(branch `task/create-and-pin`, base `0798661`) · *not committed — parent owns git.*

**Report, verbatim:** *"can't create a session and pin it in the same go -
clicking the pin won't activate the pin - need to refresh browser in between.
(webui frontend)"*

**Outcome:** reproduced in a browser against a production-shaped disposable
server, root-caused, fixed with RED-first TDD, re-proved in the browser, and
sibling actions checked. Diff: **15 insertions / 5 deletions in one file**, plus
one new test file (4 tests). No server change was needed.

---

## 1. Root cause (precise)

A session's client-side entry **loses `sdkType` within ~0.8 s of creation**, and
`pinSession` then silently drops the pin.

1. **`session_created`** (server → client) adds the session optimistically
   *with* `sdkType` (`client/src/store/sessionStore.ts` ~1941).
2. **`session_update`** with `changeType: 'add'` follows **796 ms / 833 ms** later
   (measured twice; `server/src/index.ts` ~100 broadcasts it when the
   SessionWatcher sees the new `.jsonl`; `logs/browser-evidence.md` §4). Its
   `info` is a **projection** — `id, path, cwd, firstMessage, messageCount, name,
   createdAt, lastActivity` — and carries **no `sdkType`** (nor `model`,
   `effort`, `origin`). The declared wire type is `SessionInfo`, which *requires*
   `sdkType` (`shared/src/types.ts:63`, `server/src/websocket/protocol.ts:248`),
   so the payload does not honour its own type.
3. The client handler **replaced the entry wholesale**
   (`newSessions[existingIndex] = info`), erasing `sdkType`.
4. `pinSession(sessionPath)` (~1460) computes
   `targetRuntime = sessionRuntime(sessionPath)` → now `undefined`.
5. With `targetRuntime === undefined` it takes the *backward-compatible fallback*:
   `if (state.pinnedSessionPaths.length >= MAX_HUMAN_PINNED_SESSIONS_PER_RUNTIME) return state;`
   (`sessionStore.ts:1482`). That compares a **TOTAL** pinned set against a
   **PER-RUNTIME** cap of 5. The operator has **7 pins**, so `7 >= 5` →
   **the store returns unchanged (`added` stays false)**.
6. Because `added === false`, **the durable delta write is never issued** —
   `if (added) syncPreferenceDelta(() => pinSessionPref(...))`. The click looked
   inert and nothing was persisted, until a browser refresh restored `sdkType`
   from `sessions_list` (which *does* carry it) and the pin finally worked. That
   is the operator's "refresh the browser in between".

**Why this is the operator's bug and not a coincidence** (production artefacts,
read read-only):

| Prediction of this root cause | Observed in production |
|---|---|
| Client drops the pin → no durable write | `~/.pi/agent/web-ui-prefs.json`: **0 pinned `pi:` records**; the only 7 pins are `antigravity:`, untouched since **2026-09-10** |
| …but the WS `pin_session` is still sent, so the server claims it | journal: `[MultiSessionManager] Session retention claimed: … claim=web-ui` (07:50:58, 07:56:28) |
| Only bites when ≥5 pins exist | operator has 7 |
| The same pin works after a refresh | proved directly on the buggy build: `logs/browser-evidence.md` §2 |

**Why a clean environment hides it:** with fewer than 5 pins `7 >= 5` is false,
so the fallback lets the pin through and everything looks fine (my first four
probe runs, `probeA`, `probeD-fast`, `probeE-prodlike`, all passed). The defect
needs *both* the `sdkType` loss *and* an existing pin set.

**Secondary defect fixed in the same handler (same field-name confusion):** the
handler destructured `type` from the message, but the wire field is `changeType`
— `type` is always `'session_update'`, so `if (type === 'unlink')` was
**dead code** and deleted sessions were re-added/kept by the `else if (info)`
branch instead of being removed.

---

## 2. Fix (TDD, RED first)

`client/src/store/sessionStore.ts` — `session_update` case only:

```diff
-            const { type, sessionId, info } = msg as {
-              type: 'add' | 'change' | 'unlink';
+            const { changeType, sessionId, info } = msg as unknown as {
+              changeType: 'add' | 'change' | 'unlink';
               sessionId: string;
               info?: Session;
             };
-            if (type === 'unlink') {
+            if (changeType === 'unlink') {
...
-                  const newSessions = [...state.sessions];
-                  newSessions[existingIndex] = info;
+                  // MERGE, never replace (partial projection keeps client fields)
+                  const newSessions = [...state.sessions];
+                  newSessions[existingIndex] = { ...state.sessions[existingIndex], ...info };
```

`client/tests/unit/store/sessionStore-create-and-pin.test.ts` (new, 4 tests):

| Test | Guards |
|---|---|
| `keeps sdkType when the SessionWatcher session_update lands on a new session` | the exact regression |
| `pins a session created and pinned in one go even when five other sessions are already pinned` | the reported outcome **and** the durable `pinSessionPref` call |
| `preserves client-held fields the watcher projection does not carry` | `origin` (sidebar recency) + `model` |
| `removes the session on a changeType unlink update` | the dead-code fix |

**RED → GREEN, both fixes isolated.** First RED run (fix not yet written):
`Tests 3 failed (3)` — sdkType stripped, pin list `['a0'..'a4']` without the new
path, unlink kept the row. GREEN after the fix: `4 passed`. The merge fix alone
was then re-checked by temporarily restoring `= info` (plain edit + restore, no
git mutation; `grep -c TEMP-REVERT` = 0 afterwards):

```
Tests  3 failed | 1 passed (4)
  FAIL keeps sdkType ...            FAIL pins a session created and pinned in one go ...
  FAIL preserves client-held fields ...      PASS removes the session on a changeType unlink update
```

i.e. tests 1/2/3 are the merge fix, test 4 is the `changeType` fix.

---

## 3. Browser before/after (same production-shaped state)

Disposable validation server + vite dev client, both in their **own systemd
scopes** (`pin-child-validation.scope`, `pin-child-vite.scope` → verified
`/system.slice/…`, *not* `pi-web-ui.service`), seeded with read-only copies of
the operator's prefs (1146 records, 7 pins) and session registry (1917 entries).
Full detail: `logs/browser-evidence.md`; raw JSON/PNGs in `logs/browser/`.

| | BEFORE (`verifyA/verifyB-prodlike`, 08:47–08:48) | AFTER (`verifyC-fixed`, 08:52) |
|---|---|---|
| entry after watcher update | `sdkStatus: "sdkType-lost"` | `sdkStatus: "sdkType-never-lost"` |
| pin glyph after click | `amber: 0 → 0` (button still "Pin session (protect from cleanup)") | `amber: 0 → 1` |
| `pin_session` on the wire | sent | sent |
| durable `POST /api/preferences/pin` | **absent** | **200** |
| prefs file | no new pi pin | `pi:01a0a443… {"pinned":true}` (total 8) |

Control on the **buggy** build (08:49, before the fix): fresh load →
`top[].sdk = "pi"` → click → `before=0 after=1`, `POST /api/preferences/pin -> 200`
(`control-fresh-load.png`). That is the operator's workaround, reproduced.

Screenshots: `verifyA-prodlike-after-click.png` (unpinned) vs
`verifyC-fixed-after-click.png` (pinned) — same session flow, same seeded state.

---

## 4. Siblings (same class: acting on a just-created session)

Measured on one just-created session, same run as the timing above:

| Action | Result |
|---|---|
| rename | **applied immediately** (`Renamed in one go` visible) — never affected: it is path-keyed, not runtime-keyed |
| pin | **applied immediately** (store 7 → 8) |
| unpin | **applied immediately** (store 8 → 7, glyph cleared) |
| archive | **applied immediately** (active rows 1 → 0, archived 1085 → 1086) — also path-keyed |
| watcher update | lands **796 / 833 ms** after creation, i.e. always before a human can click |

Only the **pin** needed `sdkType`; rename/unpin/archive were path-keyed and
therefore survived the field loss. The merge fix additionally restores `model`
and `origin` (the latter feeds the sidebar's 14-day window for
`native-discovered` sessions, which the field loss had silently widened to 30
days for any discovered session that received a `session_update`).

### Documented, NOT fixed (outside this brief's root cause; parent to decide)

1. **Cap unit mismatch** — `client/src/store/sessionStore.ts:1482`:
   `if (targetRuntime === undefined && state.pinnedSessionPaths.length >= MAX_HUMAN_PINNED_SESSIONS_PER_RUNTIME) return state;`
   compares a total count against a per-runtime cap of 5 (`shared/src/constants.ts:81`).
   After the fix this branch is only reachable for a genuinely unknown runtime
   (no test covers it). Recommended: let the authoritative server cap decide
   (it already answers `session_pin_error`, which the client surfaces as a
   toast) instead of silently dropping. Left as-is deliberately: it is a
   behaviour change the brief did not ask for and no existing test pins it.
2. **Stale preferences read can erase a just-made pin** (proved, latent):
   `initPreferences` (~1561) does `set({ sessionMeta: meta, ... })`
   unconditionally, so a `GET /api/preferences` response that was *fetched
   before* a pin and *delivered after* it wipes the pin from the client while
   the server keeps it (`logs/browser-evidence.md` §5; the durable write had
   already returned 200). Measured window with the production-sized prefs file:
   **13–34 ms**, so it cannot explain an every-time symptom; recommend a
   generation/last-write guard when someone owns that area.
3. **The watcher's `info` payload omits `sdkType` while its declared type
   `SessionInfo` requires it** (`shared/src/types.ts:68`,
   `server/src/websocket/protocol.ts:248`, projection at `server/src/index.ts:100`).
   The client fix makes the client robust to it, but the server payload is still
   a lie against its own type; adding `sdkType` to that projection would be the
   complementary hardening. Not changed here (minimal diff, client-side cause).

---

## 5. Changed paths (owned by this child)

```
 M client/src/store/sessionStore.ts                                    (+15 / -5)
?? client/tests/unit/store/sessionStore-create-and-pin.test.ts         (new, 4 tests)
```

Nothing else in the worktree is modified (`git status --short` shows only these
two lines). No server file, no shared file, no docs.

## 6. Gates run

| Command | Result |
|---|---|
| `cd client && npx vitest run tests/unit/store/sessionStore-create-and-pin.test.ts` | RED first (`3 failed`), then **4 passed** |
| `cd client && npx vitest run` | **1231 passed / 115 files** (no regressions) |
| `cd client && npx tsc --noEmit` | clean |
| `npx eslint client/src/store/sessionStore.ts client/tests/unit/store/sessionStore-create-and-pin.test.ts` | 0 errors, 18 pre-existing warnings |

Not run (out of scope for a child): `npm run build`, root `npm test` across all
workspaces, Playwright E2E — the parent re-runs those at merge. The change is
client-only, so server suites are unaffected.

## 7. Could not do / caveats

- **No live production reproduction.** Production was never touched; the
  root cause is proved on a disposable server seeded with the operator's own
  prefs shape, and corroborated by production artefacts read read-only
  (prefs file + journal).
- The harness's final "pin again after `page.reload()`" step times out in
  `pin-verify.mjs` (the sidebar list is not yet populated 3 s after reload when
  the 1 MB seeded registry is in play). The equivalent control was run
  separately as `pin-control.mjs` (fresh load), so the after-refresh claim rests
  on that run, not on the failing step. Both `verifyA` and `verifyC` fail that
  step identically, so it cannot be read as a before/after difference.
- The very first harness attempt (08:38) measured nothing useful — it raced the
  login screen; the fixed harness is the one in `logs/harness/`.
- One earlier probe (`probeE-prodlike`) ran against operator-shaped prefs but
  still passed, because the seeded registry had not been picked up by the
  session list; that is why the decisive runs wait for the store's own entry to
  lose `sdkType` before clicking.
- The 08:30:26 `pi-web-ui.service` restart killed this child mid-recon; no work
  was lost (nothing had been written yet), and every later disposable process
  was run under `systemd-run --scope` per the new rule.

## 8. Cleanup

All disposable processes stopped and their scope units reset; `/tmp/pin-child/validation`
removed; harness + evidence copied into `logs/` beside this handback. The only
sessions created were in the disposable server's own session dir. The child
declared presence on the Agent OS board (`pi-01a0a42e-…`) at start.
