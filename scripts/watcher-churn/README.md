# Watcher churn harness (B1.1)

Synthetic, model-free proof that the `SessionWatcher` no longer retains state
for deleted session files. It writes and deletes session JSONL files in a
disposable validation server's watched sessions directory and compares
forced-GC heap snapshots taken through the server's loopback inspector.

## What it does

1. Creates a fixed set of child directories (so later `FSWatcher` growth is
   per-file retention, not new directory watches).
2. Forced-GC heap snapshot **before**.
3. Churns files in three cases (see `churn.ts`):
   - `before-stability` — created and deleted ~300 ms after write completion;
   - `inside-debounce` — ~700 ms after write completion;
   - `after-debounce` — ~1200 ms after write completion.

   These delays are measured from **write completion** and are *intended*
   cohorts, not event-aligned ones: on the old `awaitWriteFinish` build chokidar
   declares an add ~300 ms after it observes the file, so the same wall-clock
   delay lands in a different phase than on the corrected build. The driver
   records the **measured** per-file lifetime percentile for each case, and
   `verdict.txt` prints it, so the comparison is honest about the alignment; the
   aggregate old-grows/new-zero result is the load-bearing one.
4. Settles, forced-GC, heap snapshot **after**.
5. `summarize.ts` (imports the heap-soak read-only retainer module owned by lane
   b0-1) reports `Timeout`/`Stats`/`Date`/`FSWatcher` instance counts, how many
   are held specifically through `SessionWatcher`/chokidar session state
   (`debounceTimers`, `_pendingWrites`, `_watched`, `_closers`, `readStateByPath`)
   as opposed to a generic `fs.FSWatcher` handle the Pi SDK also creates, and
   the dominant shortest retainer chains — which are the watcher map sizes (for
   example instances reached through
   `object:SessionWatcher --property:debounceTimers--> object:Map`).

Outputs in `--out-dir`: `before.heapsnapshot`, `after.heapsnapshot`,
`churn.json`, `summary.json`, `summary.md`, `verdict.json`, `verdict.txt`.

## Usage

Start a disposable validation server with the inspector enabled (outside the
production systemd cgroup), then run the driver against its sessions dir:

```bash
# terminal 1 — disposable server (own scope; never production)
systemd-run --scope --collect --unit=pi-web-ui-validate-b11 \
  npx tsx scripts/validation-server.ts --dir /tmp/b1-1-churn --inspect-port 9330

# terminal 2 — churn + retainer verdict
node --import tsx scripts/watcher-churn/cli.ts \
  --sessions-dir /tmp/b1-1-churn/pi-sessions \
  --inspect-port 9330 \
  --out-dir /root/.pi-web-ui/validation/watcher-churn-b1-1/<run> \
  --label new-build \
  --files-per-case 1000 --directories 12 --settle-ms 8000
```

`verdict.txt` compares before/after per constructor and prints the total
watcher-held growth. A build that still retains deleted-file state shows growth
roughly proportional to the churned file count; a fixed build returns the
watcher-held deltas to ~0.

To summarise snapshots already on disk:

```bash
node --max-old-space-size=12288 --import tsx scripts/watcher-churn/summarize.ts \
  --before before.heapsnapshot --after after.heapsnapshot \
  --targets Timeout,Stats,Date,FSWatcher,SessionWatcher \
  --out-md summary.md --label my-run
```

## Live-session load profile (`live-load.ts`)

Separation of deleted-file retention from live-session cost: `live-load.ts`
generates a large realistic session file, appends a real entry at a stream
cadence, and reports the watcher's complete-file read count, the total time
inside `readSessionInfo` and a real event-loop-delay histogram — no server and
no model tokens. It is how the B1.1 correction measured that removing
`awaitWriteFinish` initially made a large appended session start back-to-back
complete-file reads (see `docs/plans/execution-reports/orchestration-scaling/B1.1.md` §11).

```bash
npx tsx scripts/watcher-churn/live-load.ts \
  --watcher server/src/pi/session-watcher.ts \
  --label my-build --file-mb 80 --append-ms 50 --duration-ms 30000
```
