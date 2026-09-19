# Playback health — the client observability gap, closed

**Date:** 2026-09-19 · **Owner directive:** *"fill the observability gap. no flushing the queue."* (ledger **D-09**)

**The gap.** A crash was only half of "why didn't I hear it?". The other half — a lane that **accepted audio and
never played it** — was invisible from the server: the browser diagnostic ring is manual-only and dies with the tab,
and the playback pipeline's faults and stats never left the page at all. That is why the lane-overlap defect
([`../lane-overlap-20260918/`](../lane-overlap-20260918/README.md)) needed a purpose-built lab to diagnose.

**The change.** The existing bounded client-observability upload and the existing `ClientVoice` component now carry a
second, non-error record family — no second store, no new query surface. `reportPlaybackHealth` uploads each playback
fault the moment it happens, and one lane-end summary per period of playback activity, measured **before** the queue
is cleared. The server re-emits it as a `ClientVoice` **warn** record with `operation: playback_health`, a `reason`
and the bounded `stats`. At `lane_end`, a non-zero `pendingMs` **is** the stranded audio.

**How to read it in production** (the ordinary documented query):

```bash
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?component=ClientVoice&limit=200" \
  | jq '.recentLogs[] | select(.operation == "playback_health")'
```

## Proof, three layers

### 1. Unit and route tests (the contract)

- `server/tests/unit/routes/client-diagnostics.test.ts` — 15 tests. A health record lands as ONE queryable
  `ClientVoice` **warn** record carrying its `reason` and `stats`, with no invented `error` object; a lane-end summary
  carries the stranded figure; the error path, its `error` shape and its credential-scrub test are unchanged; and a
  health body missing `stats`, carrying an unknown `reason`, carrying an out-of-range statistic, or carrying an
  **unknown field** is rejected with 400 and emits **no** record (the schema is strict, so transcript content cannot be
  smuggled in beside a health record).
- `client/tests/unit/lib/clientDiagnosticsReporter.test.ts` — 16 tests, including the bounded upload, the separate
  per-page health cap, the reset, and the client-side scrub.
- `client/src/lib/voiceLive/surface.test.ts` — 34 tests, including the fault upload with the stats at the moment it
  happened, the lane-end summary measured BEFORE the queue is cleared, "no double report on dispose after an explicit
  stop", and silence for a lane that never received audio.

### 2. A real server, real auth, the real read path — `live-validation-server.txt`, `ring-records.json`

A disposable validation server (`npm run validate:server`, own socket/token/state), password login over the same
cookie route the UI uses, two `playback_health` POSTs, then the DOCUMENTED Internal API read:

```bash
node scripts/live-validate-playback-health.mjs \
  --base http://localhost:<port> --socket <dir>/internal-api.sock \
  --token-path <dir>/internal-api-token --password validation-pass
```

**11/11 checks**, including the lane-end record carrying `pendingMs: 4500` at `level: warn` with its
`workerSessionId` correlation, the fault record carrying `chunksDropped: 3`, both invalid bodies rejected with no
record, and no smuggled transcript content in the ring. `ring-records.json` is the raw response from that read — the
two records exactly as the ring holds them.

### 3. A real browser, the real surface — `browser-validation.txt`

The dev-lab page (the real `VoiceLiveSurface` on a real `AudioContext`), with `window.fetch` intercepted:

```bash
npx vite --config client/voice-live-lab.vite.config.ts --port 5293 --strictPort &
node scripts/live-validate-playback-health-browser.mjs \
  --url http://127.0.0.1:5293/client/voice-live-lab.html
```

**8/8 checks**: a sequence gap uploaded `playback_seq_gap` with the stats at that moment and the lane's
`workerSessionId` correlation, `stopPlayback()` uploaded `lane_end` with the stranded figure measured before the reset
(`pendingMs: 400`, `pendingChunks: 4`, while the pipeline reports 0 pending afterwards), and no page errors.

## What is still not proven

- **OS-rendered audio.** Unchanged: this record says what the client accepted, scheduled and left unplayed, not what
  the speaker emitted. The audio regression lab's `capture:chain` cannot start on this host.
- **The operator's ear.** Still the final acceptance for the lane-overlap fix, and still outstanding: no voice lane
  had run since the 2026-09-18 17:12 deploy when this record was written.
- **A production lane carrying a real fault.** The three layers above use a real server and a real browser, but not a
  production lane that genuinely stranded audio; the first such lane will be the first production record.
