# Phase 8 execution record (2026-09-24)

## Pre-state
- Production contract: 1.44.0; HEAD: 44350706b804e06cfcfa753c6a26a075be631a7e; CI green on it.
- §0.2 WAIVER: activeTurns read 1 (P2, persistent) while all 200 sessions idle, zero
  non-terminal receipts, no board consumer — owner approved proceeding
  (Telegram question 4c770143 → "proceed now"). The restart cleared the slot
  (post-restart activeTurns: 0), confirming it was quarantined-slot debt.

## 8a
- Backup: /root/.pi/agent/extension-backups/20260924T195637Z/ (auto-compact-75, goal-engine,
  SHA256SUMS manifest, 19 entries). OUTSIDE the extensions directory (loader safety).
- Build gate: HEAD 44350706…, tracked tree clean, npm run build exit 0,
  server/dist/index.js sha256 753ded6b474e8f266548e5122e44a130e252f762603d822b49248acb27cb0c46.
- Deploy: rsync auto-compact-75 + goal-engine → live; diff -rq both: NO differences.
- Containment check: extensions/ subfolder list unchanged (16 known subfolders, no *.bak*,
  no unexpected entries).
- Restart: RESTART_TS=2026-09-24T20:01:06Z via scripts/restart-pi-web-ui.sh --force --reason
  "Phase 8 8a deploy … stale capacity slot waived …" — the wrapper's active-turn pre-flight
  vetoed the plain restart (same stale slot); --force is the wrapper's documented, audited
  override (RESTART-REQUESTED record written, requester named). NOTE: the veto also intercepted
  plain tool-call text merely MENTIONING restart paths (the Agent OS coordination gate,
  gate-command.ts Rule 1, hasFlag('--force') is its sanctioned bypass).

## Post-restart verification (all PASS)
- Service active since Thu 2026-09-24 20:01:21 UTC.
- GET /api/v1/health → contract.contractVersion = "1.45.0" ✓
- GET /api/v1/capacity → activeTurns = 0 ✓ (stale slot gone, as predicted)
- GET /api/v1/sessions/01a0d304… (never-loaded ORACLE parent session) → ownership
  {status:"unknown", leaseState:"owned" (owned by that session's own tui CLI pid 3536474)} —
  honest unknown: the server never loaded it, nothing published. CORRECT behaviour.
- GET /api/v1/sessions/01a0d366… (the execution session, loaded server-side) → ownership
  {status:"conflict", ownerPid:1496414, ownerMode:"tui", leaseState:"owned"} — the extension
  PUBLISHED the fence against the executor's own tmux pi CLI. And POST control
  set_thinking_level on it → 409 SESSION_OWNED_BY_OTHER_RUNTIME in 11 ms naming that owner:
  the ownership gate is live in production.
- Journal (since 20:01:06Z): 16 extensions loaded exactly once each — including
  auto-compact-75 and goal-engine (the two new builds); ZERO extension-backups loads;
  ZERO error-level lines.

## 8b
- Backup: /root/.pi/agent/extension-backups/20260924T195637Z/settings.json.bak
  (pre-edit sha256 b8816bcce944d52883bdd71c749ba07c8346c760c8f2812e6441988950e650f5).
- Removed EXACTLY the four http entries → PostToolUse/Stop/SessionStart/UserPromptSubmit
  127.0.0.1:3111/hook/* (surgical: matcher groups without other hooks dropped; all Agent OS
  command hooks intact — see hooks-before/after captures).
- Validation: settings.json parses (JSON valid ✓); grep 3111 count == 0 ✓.
- Fresh-Claude-session smoke deferred to the next natural Claude session: the four entries no
  longer exist, so the ECONNREFUSED source is structurally gone.
