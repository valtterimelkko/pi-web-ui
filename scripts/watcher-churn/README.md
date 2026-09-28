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
   - `before-stability` — created and deleted inside chokidar's former 300 ms
     `awaitWriteFinish` window (the add was never declared stable);
   - `inside-debounce` — deleted while `SessionWatcher`'s 500 ms debounce timer
     is pending;
   - `after-debounce` — deleted after the debounce fired.
4. Settles, forced-GC, heap snapshot **after**.
5. `summarize.ts` (imports the heap-soak read-only retainer module owned by lane
   b0-1) reports `Timeout`/`Stats`/`Date`/`FSWatcher` instance counts, how many
   are watcher-held, and the dominant shortest retainer chains — which are the
   watcher map sizes (for example instances reached through
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
