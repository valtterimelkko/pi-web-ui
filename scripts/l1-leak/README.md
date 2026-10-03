# L1 leak reproduction harness (`scripts/l1-leak/`)

Reproduces the 2026-10-03 production admission-count leak (phantom quarantined
turns) against a real `zai/glm-5.3-flash` goal child on a **disposable**
server, and re-runs the same scenario against the fixed build. Lane L1 brief:
`/root/orch-ops/orchestration-scaling/k/L1/brief.md`.

## What it does

1. Boots the repo's disposable validation server inside `k-l1.slice`
   (`k-l1-server.service` + delegated `k-l1-tools-anchor.service`,
   MemoryMax 6G, RuntimeMaxSec 2700, Restart=no), isolated agent dir with the
   real extension set and the `zai` credential only, fake `$HOME`, Agent OS
   stub, notifications off, placement ON at our own anchor (asserted never to
   be production's). Asserts from the boot journal that only `zai` is
   authenticated.
2. Spawns a goal child (A) whose objective runs a silent foreground command
   (default `sleep`-loop 420 s) — the "long silent turn" production saw.
3. Spawns a plain session (B) as watch subject, then fires the production
   prompt shapes at busy A, timed off A's busy state:
   - **W** — watch-wake `follow_up` into busy A (the wake dispatch path gives
     the run its **own admission lease**; the silent turn gives it no eligible
     activity, so the start watchdog terminalises it NEVER_STARTED and the
     §11 drain fence holds its lease against a still-busy session),
   - **S** — a detached **steer** (joined, lease-less — control),
   - **Q** — a detached **queued follow_up** through the prompt path
     (lease-less — control),
   - **A** — an **abort** of the busy session (`cancelSession` first, so the
     cancelled runs' leases drain against the still-busy session).
4. Samples `GET /capacity` and the session's run receipts every 5 s into
   `timeline.jsonl`, until the session has settled for 3 minutes (bounded).
5. Writes `probe-summary.json` and `probe-events.log` with every dispatch
   response.

The leak signature: `quarantinedRuns > 0` while every run standing behind a
quarantined entry is already **terminal** — no non-terminal receipt backs it —
and the count does **not** return to 0 after the session settles (pre-fix).
Post-fix the reconciliation guard releases quarantined entries once the whole
session is confirmed quiescent, so the count returns to 0.

## Usage

```bash
npm run build   # arm runs --compiled
node --import tsx scripts/l1-leak/boot.ts  start --run-id l1-r1
node --import tsx scripts/l1-leak/probe.ts --run-id l1-r1 [--wedge-seconds 420]
node --import tsx scripts/l1-leak/boot.ts  stop  --run-id l1-r1   # deletes the disposable token too
```

Evidence lands under `/root/k-runs/l1/<run-id>/evidence/`. Units, containment
and credential rules follow `/root/orch-ops/orchestration-scaling/COMMON-BRIEF-k.md`.
