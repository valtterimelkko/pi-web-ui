# E2a-6c — crash-recovery arm with real goal children (wave K entry evidence) — r2 after 09-correction

> Lane E2a-6c of the E2 re-measure (plan §6 *E2*, *Wave K*). Brief and its
> numbered amendments live in `/root/orch-ops/orchestration-scaling/e2/E2a-6c/`.
> **Status: the first-pass arms are WITHDRAWN as wave-K evidence after the Luna
> review REJECT and the parent-verified 09-correction** (drain-arm recovery was
> misdetected; placement was disabled on every boot, so orphan figures were not
> sound). This document states the corrected method, the corrected chronology
> and terms, and what is withdrawn. The re-run (fresh fixtures per arm, all
> 09 fixes, placement asserted enabled and fail-closed) runs in the next lock
> slot; its numbers and the R5 conclusion land here and in `10-complete.md`.

## What the first pass got wrong (verified)

1. **Drain arm did not self-recover.** The "1 s to working / no parent action"
   result counted tool calls recorded *during* the 45-second blocking drain.
   All four final session files end between 03:54:17Z and 03:54:54Z, before
   the restarted API was ready at 03:55:00Z; no event exists after readiness.
   **Withdrawn.** Detection is now timestamp-gated on the harness's own
   readiness probe; a goal that reads `running` with no post-readiness work
   and no busy flag is reported as a **silent stall**, a distinct outcome.
2. **Placement was disabled on every boot.** The journal shows
   `[Placement] DISABLED — tools root unavailable`: the anchor had no numeric
   `memory.max`, so no child tool process ran in the production-like anchor
   and **neither arm's orphan figure is evidence.** The anchor now carries
   `MemoryMax=6G`/`MemoryHigh=5G`; a pre-arm journal assertion fails the run
   on any `DISABLED` line; the work phase requires an observed child tool
   process under the anchor cgroup and aborts otherwise; missing orphan
   evidence is an error, never a zero (and the drain producer/collection
   filename mismatch is fixed).
3. **"0 duplicate side effects" was unmeasured, not measured-zero.** The old
   detector compared exact child-writable text lines and commit subjects and
   saw only one final build snapshot. Duplicates are now counted per
   normalised step id (`slugify`, `initials`, `maskEmail`, `build`) from
   evidence the harness owns: commits mapped to steps by files touched, plus
   a harness-written append-only operation ledger (commits seen and
   `build-info.json` hashes per sample, written outside the child's cwd).
   Child-writable progress text is reported **unmeasured**, never 0.

## Corrected chronology of the first pass (journal-derived)

- 03:23:42Z — kill-arm server boot (`Available providers (with auth): zai`).
- 03:28:17Z — SIGKILL; systemd auto-restart; API-ready 03:28:33Z.
- 03:41:18Z — kill arm completed (fixtures 1–4 of that run).
- 03:41:20Z — failed drain attempt's server boot (journal).
- ~03:46:05Z–03:46:50Z — drain started and reached `timed_out` server-side;
  the harness client destroyed its request at 30 s.
- 03:46:35Z — harness released the stress lock (client timeout);
  **03:46:35Z–03:48:22Z: the server was still running without the lock — an
  unprotected interval, disclosed as a process defect** (the runner now stops
  units before releasing the lock, with a scripted check).
- 03:48:22Z — server stopped by the harness after the 08-note.
- 03:49:26Z — retry server boot (journal; not 03:47:52Z as first reported).
- 04:07:24Z — drain arm completed — **result withdrawn per finding 1.**

Sample counts by attempt: kill arm 131 sample batches; drain attempt 1
(failed) 23; drain attempt 2 (successful) 23. The first report's "46" merged
the two drain attempts.

## Terms (09 item 7)

- **"Recorded transcript-event loss"** (was "turns lost"): the count of
  recorded session-file events present before the interruption and absent
  from the recovered file (common-prefix comparison). It does **not** count
  semantic or model turns, and cannot see unflushed generation that never
  reached the session file; interrupted-turn evidence is the run receipts'
  terminal states.
- **Watch ledgers (narrowed claim):** both arms' ledgers carry an `agent_end`
  firing whose evidence string says "interrupted by restart …"
  (`server_restart`/`drain_timeout`), and the journal records
  restart-reconciliation firing all four watches. There is **no typed
  interruption flag and no `goal_end` firing** in the ledgers, and
  `wakeAttempts` is empty — whether a parent actually received a wake is
  unverified.

## Kill arm — first pass, narrow surviving observation

The kill arm's orphan and duplicate figures are **not evidence** (finding 2
and 3). What survives: four goal children on `zai/glm-5.3-flash` (high),
mid-work on real fixtures, all four goals went `paused` on the SIGKILL+restart
and none resumed without a parent follow-up prompt. Prompt-to-work from raw
tool-call times: **about 9–11 s for three children, about 135 s for c1**; the
sample-detection times in the first report (632–761 s) are upper bounds of
when the sampler noticed, not when work resumed. Recorded transcript-event
loss 0/4 (the reviewer's independent prefix re-analysis reconciles:
pre-interruption counts 51/36/36/57).

## R5 conclusion

**Deferred to the re-run.** The conclusion will be written only from re-run
data, with n stated per arm (planned: 4 children per arm, fresh fixtures each,
one interruption each), covering: self-recovery vs parent-action rates under
timestamp-gated detection, duplicate executions per step id from the
harness-owned ledger, orphans under a verified-enabled placement, and
silent-stall counts.

## Harness (post-09)

`scripts/e2a-crash/` on `orch/e2-a6c` (branch history rewritten so no raw
session excerpt is reachable — `git log --all -- scripts/e2a-crash/testdata/real-session-excerpt.jsonl`
is empty; only `testdata/synthetic-session-excerpt*.jsonl` remain). Typecheck
(as run): `npx tsc --noEmit --strict --target ES2022 --module ESNext
--moduleResolution bundler --esModuleInterop --allowImportingTsExtensions
--skipLibCheck scripts/e2a-crash/*.ts` → 0. Tests:
`env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u
CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test node --import tsx --test
scripts/e2a-crash/analysis.test.ts` → 0. Disposable `server.env` secrets and
`internal-api-token` files are deleted whenever a server stops.
