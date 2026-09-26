# Pi Web UI and Internal API — deep review (2026-09-26)

> **Status:** complete. Plan of record that follows from it: [`docs/plans/ORCHESTRATION-SCALING-READINESS-PLAN.md`](../plans/ORCHESTRATION-SCALING-READINESS-PLAN.md).
> **Review session:** Claude Code session `fc35fbf1-7f12-4962-9243-da710409fb56` ("Internal API Review"), Opus.
> **Read this before** a review moment of that plan, or before any work on Internal API capacity, admission, lifecycle, isolation or orchestration ergonomics.

## 1. The question

The owner asked (paraphrased closely): *Is Pi Web UI, including its Internal API, working optimally? The owner wants to scale up Internal API orchestration soon: is it robust, is it allocated enough resources, is the architecture optimal? Do a deep analysis, and use the jev-session-eval repo to mine the full session history from as many angles as possible.*

Follow-up questions in the same session: do the recommendations address the three main problems, and which issues fall outside the original question? Both answers are folded into §6–§7.

## 2. Bottom line

Capacity is ample and stability has improved markedly: no crashes since 15 September. The service is **not yet ready for a large scale-up**, for three reasons:

1. **One process does everything.** Browser sockets, the Internal API and every in-process Pi agent share one Node event loop and one 4 GiB V8 heap. One runaway session can starve the service (the 2026-09-12 stall), and every restart kills in-process children.
2. **Heap grows with uptime, not load, and admission cannot see it.** Admission budgets the 18 GiB cgroup, PIDs and host pressure, but not the V8 heap cap or event-loop lag. Frequent restarts hide the growth. This is not yet proven to be a leak: `heapUsed` includes uncollected garbage, which is why the 24 h soak (plan step A1) exists.
3. **Orchestration costs parents too much.** Supervision overhead is heavy; parents hand-roll curl and sleep loops; child results need correcting in roughly four orchestration sessions in ten; many children hit workspace problems.

## 3. Method and data sources

| Source | What was taken | Where it is now |
| --- | --- | --- |
| systemd / cgroup | limits, MemoryPeak, `memory.events`, PSI, TasksCurrent | re-read with `systemctl show pi-web-ui.service -p MemoryMax,MemoryHigh,TasksMax,…` and `/sys/fs/cgroup/system.slice/pi-web-ui.service/memory.events` |
| Internal API (read-only) | `GET /api/v1/capabilities`, `/health`, `/capacity` over `~/.pi-web-ui/internal-api.sock` | live; the contract was 1.47.1 at review time |
| Stop audit | 34 clean stops 15–25 Sep | `~/.pi-web-ui/stop-audit.log` (written by `scripts/systemd-stop-audit.sh`) |
| systemd PID-1 unit messages | watchdog kills and failure exits July–September | `journalctl _PID=1 UNIT=pi-web-ui.service --since 2026-07-01` (fast; grepping the unit's own 3.8 GB journal times out) |
| Journal memory line | 11,586 samples of heap/rss/resident sessions, 12–25 Sep | extract in `/root/jev-session-eval/runs/piwebui-review-2026-09-26-data/heap2.txt`; analysis `/root/jev-session-eval/analyses/2026-09-26-piwebui-review/heap_by_boot.py` |
| Session registry | 1,727 entries; 322 with `origin: internal-api` (all September; the field was not recorded earlier); 149 with `parentSessionId` | `~/.pi-web-ui/session-registry.json`; child id list in the data dir above |
| Session history (Jev) | five evaluations over Claude Code, Pi, Command Code and Antigravity sessions, 3,392 units, 0 errors, about $0.50 | specs `/root/jev-session-eval/specs/piwebui-*.toml` (commit `38e8277`); runs `/root/jev-session-eval/runs/piwebui-{orch-parent,orch-children,restarts,dev-hotspots}-v2` and `piwebui-operator-reports-v3` |
| Code census | Internal API endpoints, error codes, curl vs client, sleep calls over 219 sessions | `/root/jev-session-eval/analyses/2026-09-26-piwebui-review/census.py` + data dir |
| Git history | 921 commits and 202 fix commits since 1 July; fix hotspots; contract 1.15→1.47 in about eight weeks | `git log --since=2026-07-01` |
| Agent OS recall | the 2026-09-12 stall root cause; the watchdog loop cause | `agent-os recall "pi-web-ui event-loop stall watchdog"` |

The five Jev specs (each spec file carries its pilot notes and wording changes):

| Spec | Unit / population | Question it answers |
| --- | --- | --- |
| `piwebui-orch-parent` | 220 sessions whose tool calls touch the Internal API; gate = real orchestration (70) | Did orchestration deliver, what was the main friction, how heavy was supervision, did parents redo child work? |
| `piwebui-orch-children` | 321 registry children with origin `internal-api` | Did children complete, loop or stall, hit environment problems, have reports contradicted by their own output? How good were their briefs? |
| `piwebui-restarts` | 43 sessions that restarted or stopped production | Why restart, did they check active work, did restarts interrupt work? |
| `piwebui-dev-hotspots` | 133 real sessions in the pi-web-ui repo since July | What kind of work, which area, regressions, severity. |
| `piwebui-operator-reports` | 2,614 operator prompts mentioning Pi Web UI, the Internal API, orchestration or stuck sessions; gate = reports a malfunction (206) | What fails in the owner's own words, how badly, fixed in-session, recurring? |

## 4. Findings

### 4.1 Resources and capacity

- Limits: MemoryMax 18 GiB, MemoryHigh 14 GiB, TasksMax 8192, `NODE_OPTIONS=--max-old-space-size=4096`, `PI_MAX_SESSIONS=20`, `MAX_CLAUDE_PROCESSES=16`. Admission: 16 active turns, 2 interactive reserve, 14 API turns, 512 MiB and 96 PIDs reserved per turn, 1.5 GiB minimum headroom. Command Code allows 1 active turn.
- Usage at review: 0.43 GB service memory; `memory.events` all zero; memory PSI zero; host 23 GiB available of 31 GiB; 16 cores lightly loaded.
- **The binding limit is the heap, not the cgroup.** The service is a single Node process (`systemd-cgls` shows one PID), and Pi sessions run in-process via `createAgentSession` (`server/src/pi/pi-service.ts`). The admission controller (`server/src/internal-api/admission-controller.ts`) reads cgroup memory, PIDs and host PSI, but neither V8 heap nor event-loop lag. Heap pressure only arms message shedding (`server/src/internal-api/event-loop-shed.ts`).

### 4.2 Heap behaviour

- Heap does **not** track resident sessions: median heap was 1,505 MB with 0 sessions resident, and about 300 MB with 6–9 resident.
- It grows within a boot: 24 Sep 10:41 boot 391 → 1,918 MB in 7.8 h; 24 Sep 20:01 boot 535 → 1,557 MB with a single session; 19 Sep boot 134 → 821 MB.
- About three restarts per day (mean uptime about 7.5 h) reset it, masking the trend.
- Caveat: `heapUsed` includes garbage not yet collected, so this is a strong signal, not proof. Weak suspects to check during the soak, not conclusions: per-session maps that outlive sessions, the never-pruned tombstone set in `server/src/internal-api/session-disposal.ts`, run-receipt and watch stores, diagnostics buffers, registry caches. `/capacity` showed 13 `disposalOwners` entries for sessions dating back to 11 Sep; per the code, that is registered handles for sessions never deleted, which is not by itself a leak.

### 4.3 Stability and restarts

- July to 14 Sep: about 45 failure exits and 13 watchdog kills (two on 3 Sep, one on 10 Sep, ten on 14 Sep; the 14 Sep loop came from watchdog misconfiguration, now fixed).
- Since 15 Sep: **zero crashes**; 34 stops, all clean exit 0.
- 2026-09-12 stall (from Agent OS recall): a runaway generation streamed 131,072 output tokens over 29.5 minutes while every streamed tool-argument delta ran quadratic JSON parsing on the single event loop, amplified by a broker byte-accounting leak. Fixed and deployed; the class of risk remains architectural.
- Restarts (Jev): 63% deploys, 12% config, 5% recovery; only about half checked active sessions or children first. About 1% of children (4 of 321) ended within 3 minutes of a service stop.

### 4.4 Orchestration as parents experience it (70 real orchestration sessions)

- Outcome: delivered about 60%, partial 18%, unclear 17%, failed 4%.
- Supervision overhead: mean 1.46 on a 0–2 scale; half the sessions heavy.
- Parent had to correct or redo child work: mean probability 0.43 (29 of 70 at ≥0.5).
- Main friction (expected shares): waiting/supervision 21%, none 21%, API misuse 13%, child quality 12%, refusals (busy/capacity/ownership) 11%, child stall 9%, service down 8%, provider 6%.
- Code census over all 219 API-touching sessions: 81% of socket calls are hand-written curl; 0 calls through the Internal API MCP adapter (`packages/internal-api-mcp`, inactive by design); 42 of 70 orchestrating parents used `sleep` loops. Most frequent structured error codes: `INVALID_REQUEST` (44 results in 31 sessions), `SESSION_BUSY` (23/14), `NOT_FOUND` (22/16), `SESSION_NOT_FOUND` (18/11), `UNAUTHORIZED` (14/13), `METHOD_NOT_ALLOWED` (12/9).
- Defects seen: a follow-up to a Pi session that stays busy past the 900 s inactivity window becomes `TURN_STALLED` and is never delivered (22 "never executed" runs in the journal); admission refused at 11 tasks on 10–11 Sep (`reservedTasks=1024` vs `taskLimit=1024`, before TasksMax was raised; not current); `SESSION_CREATE_FAILED` from a registry temp-file rename race on 9 Sep (fixed in `0960fa3f`).

### 4.5 Children (321 registry children)

- 92% end cleanly on an assistant turn (code check); about 1% at a service stop.
- 43% hit workspace or tooling problems (wrong paths, missing files or tools); 2% provider problems.
- Brief quality: mean 1.64 on 0–2.
- Report contradicted by the child's own visible output: mean probability 0.36.
- Models: mostly `zai/glm-5.3-flash` (196), then DeepSeek v4.1 Flash variants.
- Lineage: only 149 of 322 children record `parentSessionId`.

### 4.6 Operator-reported malfunctions (206 prompts)

- Orchestration 27%, Voice 16%, other 16%, stuck sessions 13%, performance 12%, runtime-specific 11%, lost state 5%.
- Severity mean 1.20 on 0–2; about a third fixed in the same session; 74% described as recurring (possibly over-called by Jev, but consistent with where fix commits cluster). Performance problems had the lowest in-session fix rate (0.24).

### 4.7 Where engineering effort goes

- September pi-web-ui sessions: Voice/Drive about 40%, Internal API about 20%, runtime integrations 17%.
- Fix-commit hotspots: DriveMode, `server/src/internal-api/routes`, `server/src/websocket/connection.ts`. `server/src/internal-api/routes/sessions.ts` is 7,762 lines and `connection.ts` 4,623.
- The contract moved from 1.15 to 1.47 in about eight weeks; Internal API docs plus the orchestration skill total about 6.7k lines.

## 5. Audits and corrections (why the numbers can be trusted)

- Every Jev spec was piloted on 20 random sessions before its full run, and individual units were checked against their raw state with `jev-eval show`.
- **Dropped:** the children's "cut off" verdicts (24%). Children finished and then ran the auto-injected Agent OS session-end capture, so the tail Jev saw was the capture, not the task report. The code check (last turn role, proximity to service stops) replaced it. Contract 1.47.0 (`a8864898`, 2026-09-25) made Agent OS skip capture for Internal API children that do not set `agentOsCapture`, so this artefact should not recur for new children.
- **Dropped:** the parents' "polling" judgement, which under-read. It was replaced by counted `sleep` calls.
- **Reworded:** the children's report-honesty score. Head/tail truncation hid mid-transcript evidence, so it became "report contradicted by visible output".
- **Harness bug fixed** in jev-session-eval (`38e8277`): Pi background-shell notices, watch-wake deadlines, child "fired" wakes and goal-recovery notes were counted as operator prompts (407 of 3,082 prompt units). Prompt-level runs from before 26 Sep may include them.
- Restart gate: the restart spec's gate misread some sessions, so restart reasons were tabulated over the code-counted `restarts > 0` population.
- Limits: Jev judgements are group-calibrated; the origin field on registry children exists only from September; 19 of 70 orchestration parents are reconstructions (crumbs) of deleted sessions.

## 6. Recommendations and how they map to the plan

The six steps first proposed covered the three problems only partly. Problem 1 was barely addressed, and problem 3 covered API mechanics but not child quality. The revised sequence became the plan's stages:

| Problem | Plan steps |
| --- | --- |
| 1 — one process | B3 per-run budgets, B4 drain-then-restart, D1 contained child execution, D2 module split |
| 2 — heap and admission | A1 soak, A2 telemetry and alerts, B1 fix the retainer, B2 heap- and lag-aware admission with an aligned heap cap |
| 3 — parent cost and child quality | C1 thin client, C2 busy follow-ups and never-started runs, C3 completion receipts and verify, C4 dispatch preflight, C5 lineage, C6 contract stability window |
| Recurrence | E1 recurring-defect ledger, E2 final re-measure |

## 7. Issues outside the original question

- Incomplete child lineage (149 of 322) → C5.
- Recurring defects with a low in-session fix rate → E1.
- Never-started runs take 900 s to surface → C2.
- Diagnosability: the journal is slow to search, and the memory log line is frequent but awkward → A2.
- The capture tail in children → fixed by contract 1.47.0; the pending Agent OS candidate `cand-36j5xixlub` describes the old behaviour.
- Orphan `session-registry.json.*.tmp` file; Command Code single-turn limit → the plan's small items.
- The share of effort going to Voice is a prioritisation decision for the owner, not a defect.

## 8. Soak-test design decisions (owner, 2026-09-26)

- 24 h window. The Pi runtime carries the load: `zai/glm-5.3-flash` is the backbone. OpenRouter free models are allowed for this soak only. Command Code free models are allowed only in the soak's isolated config; Command Code's paid credit was at 7% monthly remaining.
- Free models are best-effort: congested or slow lanes are circuit-broken and topped up by GLM; neither the run nor the verdict depends on them.
- zai 5-hour quota guard (the owner uses zai concurrently): throttle at 50% or less, pause at 30% or less and during the GLM peak window (Mon–Fri 07:00–11:00 Europe/London), resume at 60% or more.
- Robustness: rehearsal Gates 0 and 1 before the long run; supervisor reattaches without restarting the server; early checkpoint pings; the report works on partial data.
- No synthetic data may reach Agent OS: the `agent-os-inject` extension stays loaded for realism, but `AGENT_OS_BIN`, a PATH stub, `BOARD_STORE_DIR`, `AGENT_OS_VAULT_ROOT` and a fake `HOME` keep every side effect inside the run directory; a production-write audit enforces this.
- Harness code: `scripts/heap-soak/` (README there), built by a delegated Sonnet child and reviewed by the review session. Evidence: `docs/plans/execution-reports/orchestration-scaling/A1-harness.md`.

## 9. Open items at the time of writing

- Before the soak fixes landed, rehearsals leaked synthetic data into Agent OS: about 97 board entries (TTL 120 min, left to age out by owner decision) and, in the vault, 97 files under `memory-vault/derived/inject/sessions/` plus 6 recall lines in `memory-vault/evidence/usage/usage-ledger.jsonl`. Whether to remove the vault items is an owner decision.
- The pending Agent OS candidate `cand-36j5xixlub` needs a correction (see §7).

## 10. How to reproduce or extend

```bash
# Live state (read-only)
T=$(cat ~/.pi-web-ui/internal-api-token)
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock -H "Authorization: Bearer $T" http://x/api/v1/capacity
systemctl show pi-web-ui.service -p MemoryMax,MemoryHigh,TasksMax,MemoryPeak
journalctl _PID=1 UNIT=pi-web-ui.service --since 2026-07-01 --no-pager | grep -E "Watchdog timeout|Failed with result"

# Jev re-runs (same specs and pinned model, for before/after comparison)
cd /root/jev-session-eval
jev-eval run specs/piwebui-orch-parent.toml --out runs/piwebui-orch-parent-<date> --yes
# children: regenerate session_ids from the registry first (see the spec header)
python3 -c "import sys; sys.path.insert(0,'analyses/2026-09-26-piwebui-review'); from agg import load, agg; agg(load('runs/piwebui-orch-parent-<date>'), 'parents', 'orchestrated')"
```
