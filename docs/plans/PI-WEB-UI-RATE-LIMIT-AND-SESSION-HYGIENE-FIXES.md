# Pi Web UI — rate-limit and session-hygiene fix list

> **RESOLVED 2026-08-21** — all items implemented in commit `f092fc2` (server
> changes dormant until the next production restart; client bundle already in
> `client/dist`, live on hard reload). Decisions applied: cap stays 100/60s;
> auto-archive 30d feeding the 90-day retention delete with a **7-day minimum
> dwell** in archived state before deletion is eligible (freshly auto-archived
> sessions get a grace period; legacy hand-archived records are grandfathered);
> dry-run is the DEFAULT (`SESSION_CLEANUP_DRY_RUN=true`) logging would-unpin /
> would-archive / would-delete counts until flipped; sidebar defaults to recent
> 30d + unarchived with Show-all. Bonus isolation fix: disposable validation
> servers no longer share the production prefs file (`WEB_UI_PREFS_PATH`).
> Remaining known quirk (read-only, pre-existing): disposable servers still
> LIST real pi sessions because the scan reads the shared `PI_AGENT_DIR`.

_Prepared 2026-08-21 from a read-only investigation. No files in `/root/pi-web-ui` were modified._

**Trigger:** the owner archived 6–7 sessions from the browser, each taking several seconds, and then hit
`Too many requests, please try again later.` Infrastructure was ruled out first: service memory 460 MB of a
12 GiB limit, peak 1.21 GB, **every `memory.events` counter zero**, PIDs 11/1024, host 17 GiB free, PSI
avg10/60/300 all 0.00, zero worker crashes, zero OOM kills, and the Internal API reporting 1 active turn of 6
with 12.4 GiB headroom. **This is not a resource problem.** It is a request-count cap plus a client retry loop
that amplifies rather than backs off.

Line references are `server/src/…` and `client/src/…` at the time of writing; re-confirm before editing.

---

## Confirmed defects

### 1. The global rate limiter counts static assets and the SPA fallback
`server/src/app.ts:66` mounts `rateLimit(...)` **before** `express.static` (`:136`) and the `index.html`
fallback (`:140`). Every asset, favicon and SPA route request is charged against the same 100-request budget
as real API calls.

**Fix:** move the limiter so it applies to `/api` only (`app.use('/api', rateLimit(...))`), or mount static
before it. Today `client/dist` holds only 8 files, so the present blast radius is small — but it becomes
severe the moment the bundle is code-split, and it is wrong in principle either way.

### 2. The rate-limit cap is not tunable — the env var name does not match
`server/src/config.ts:281` reads `RATE_LIMIT_MAX`. Every env file — `.env:19`, `.env.production:18`,
`.env.example:50` — sets **`RATE_LIMIT_MAX_REQUESTS`**. The variable has never been read, so the limiter has
always used the hard-coded default of `100`.

`RATE_LIMIT_WINDOW_MS` **is** matched correctly (`config.ts:280`), and `.env` sets it to `60000`. The net
effect is a cap of **100 requests per 60 seconds** — fifteen times tighter than the code's own default of
100 per 900 000 ms, and silently un-raisable.

**Fix:** accept both names (`RATE_LIMIT_MAX ?? RATE_LIMIT_MAX_REQUESTS`) or correct the env files, then decide
the real value deliberately. Add a startup log line stating the effective window and cap so this class of
mismatch is visible.

### 3. The 429 carries no `Retry-After` or `RateLimit-*` headers
The inline limiter at `app.ts:66` sets neither `standardHeaders` nor `legacyHeaders`. The exported
`apiLimiter` in `server/src/security/rate-limit.ts:4` **does** set `standardHeaders: true` — so behaviour
differs depending on which limiter rejects first, and a client cannot back off correctly.

**Fix:** set `standardHeaders: true` on both, and keep them consistent.

### 4. The client retries a 429 like a network error — this is the amplifier
`client/src/store/sessionStore.ts:130-148`. `syncPreferenceDelta` retries **any** thrown error at
`[500, 1500, 4000] ms`, and `postPreferenceDelta` (`client/src/lib/api.ts:280-283`) throws `ApiError` on any
non-OK response, 429 included.

So one archive click that hits the cap becomes **four requests in ~6 seconds**, all rejected, all charged
against the same 60-second window. Seven archives can issue up to 28 requests inside the window that is
already refusing them, then silently revert the optimistic archive after the final failure. That matches the
reported symptom exactly: several seconds per archive, then a hard stop.

**Fix:** do not retry 4xx other than 408/429; on 429, honour `Retry-After` (once fix 3 lands) rather than the
fixed ladder; surface a distinct "rate limited, retrying in Ns" state instead of a silent revert.

### 5. Every preference delta returns the entire preferences object
`server/src/routes/preferences.ts:457/468/479/495/511/527` all reply with `withLegacy(...)`, which is the whole
prefs object **plus** the derived legacy arrays. The live file is **196 KB across 873 records**, and
`deriveLegacyArrays` adds an `archivedSessionPaths` array of ~826 paths on top.

Archiving one session therefore ships ~200 KB back for a one-path write, serialised behind `withPrefsLock`.
This is the direct cause of "several seconds per archive", and it degrades as the file grows — the file that
grows precisely *because* the owner archives.

**Fix:** return only the affected record (or `204 No Content`) from the delta endpoints; keep the full-object
response on `GET /api/preferences` where it belongs. Note the client currently consumes the returned object,
so this is a paired client/server change.

### 6. Double rate limiting on the same request
`apiLimiter` is applied per-route in `routes/sessions.ts:34`, `models.ts:18`, `usage.ts:41`, `files.ts:28` and
`worktrees.ts` on top of the global limiter, with **different key functions** — global keys by IP, `apiLimiter`
keys by `req.user?.userId ?? req.ip`. Two independent budgets can reject the same request for different
reasons, and only one of them reports headers.

**Fix:** pick one limiter with one key strategy. Given a single-user deployment, per-user keying on `/api`
alone is the sensible shape.

---

## Session hygiene

### Current state (measured)
- **Registry: 409 sessions** — 97 under 7 days, 143 at 7–30 days, 150 at 30–90 days, 19 at 90–180 days.
- **Preferences: 873 records, 826 archived, 0 pinned**, 196 KB.
- By runtime: pi 257, claude 110, antigravity 21, opencode 16, commandcode 5.
- By status: 396 idle, 12 error, 1 running.

### 7. Cleanup only ever deletes sessions the owner has *manually archived*
`server/src/session-cleanup.ts:195` (`autoDeleteArchivedSessions`) filters on `rec.archived`. A session that
is never archived is **never** removed, at any age. Auto-unpin after 24 h works (`:113`), and the retention
delete correctly hard-deletes the prefs husk afterwards (`:270-291`, already fixed with a good comment) — but
nothing ever *enters* the archived state on its own.

That is why 409 sessions accumulate while retention appears to be "working": the 90-day rule
(`DEFAULT_ARCHIVE_RETENTION_MS`, `:17`) is only ever applied to the subset the owner hand-archived.

**Recommended fix — a two-stage funnel, aggressive on the reversible step and conservative on the
irreversible one:**

1. **Auto-archive** any session with no activity for **N days (suggest 30)**. Archiving is reversible, removes
   the session from the default view, and is exactly the manual action the owner is currently performing by
   hand — which is what triggered this whole incident.
2. **Keep the existing 90-day retention delete unchanged.** It is the only destructive path, it already ages
   by real file mtime, and it should stay conservative. With auto-archive feeding it, it starts doing real work
   without becoming more dangerous.

Make both intervals configurable, log a one-line summary per pass, and gate the first production run behind a
dry-run mode that reports what *would* be archived and deleted.

**Explicit caution:** session transcripts are the durable record and are referenced from outside this repo.
Be aggressive about archiving; do not shorten the deletion window without the owner's explicit decision.

### 8. The session list is unbounded in the UI
409 sessions render into a default view with no age filter or pagination, which is what makes manual archiving
feel necessary in the first place. Consider defaulting the list to recent + unarchived, with an explicit
"show all" — this reduces the pressure that produced the incident, independently of items 1–6.

---

## Suggested order

| Priority | Item | Why first |
|---|---|---|
| 1 | #4 client 429 retry | Stops the amplifier; smallest, safest change |
| 2 | #2 env name mismatch | Makes the cap tunable at all |
| 3 | #1 limiter scope | Stops static/SPA traffic consuming the API budget |
| 4 | #3 headers | Prerequisite for a correct client backoff |
| 5 | #5 delta response size | Removes the multi-second archive latency |
| 6 | #7 auto-archive | Removes the underlying cause of the manual archiving |
| 7 | #6 double limiter, #8 list bounds | Cleanup and ergonomics |

## Verification

- Reproduce first: archive ~10 sessions in one minute and confirm the 429, before changing anything.
- After #4: confirm a 429 produces **one** request plus a backed-off retry, not four immediate ones.
- After #5: measure the archive round-trip and the response body size; it should be kilobytes, not ~200 KB.
- After #7: run the cleanup pass in dry-run and check the counts against the age buckets above before enabling.
- Re-check `memory.events` after any change to the cleanup loop — it is all-zero today and should stay so.

## What was not established

Which requests exhausted the budget *before* the archive clicks could not be confirmed. `express-rate-limit`
does not log rejections and this vhost has no access log, so the 429s themselves are not in `journalctl`. The
attribution above rests on the exact message string, which nothing else in the codebase produces, and on the
retry ladder in #4. If more certainty is wanted, add temporary request logging with a per-path counter and
reproduce.
