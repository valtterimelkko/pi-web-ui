You are the SOLE WRITER in the isolated git worktree **/root/pi-web-ui-wt-restart** (branch `task/restart-path`, based on master 7c87147). Your session id is {{SID}}. Do all work in that worktree.

## Why this exists
`scripts/command-code-weekly-refresh.ts` is the only unattended restart path in this repo. It restarts production when `activeTurns === 0` — and that counter was measured reading **0 while a session was provably mid-turn for ~59 minutes**. Restarting `pi-web-ui.service` kills every process in its cgroup, so that script can currently kill live agent work while believing the service is idle.

## The outcome that must be true when you are done
1. Idleness is decided from the **live busy-session count** — `GET /api/v1/sessions`, count entries with `busy === true` — not from `/capacity.activeTurns`.
2. If the busy count **cannot be determined** (API unreachable, malformed response) the script does **not** restart.
3. When it does restart, it calls `scripts/restart-pi-web-ui.sh --reason "weekly command-code catalogue refresh"` through the existing `run(...)` helper, instead of `run('systemctl', ['restart','pi-web-ui'])`, so the restart names its requester and takes the production lock.
4. Existing behaviour is preserved: the `--dry-run` and `--no-restart` flags, and the existing "server busy ⇒ defer the restart, the committed catalogue takes effect at the next ordinary restart" branch.

## Code pointers — verify these yourself before editing
- `scripts/command-code-weekly-refresh.ts`: the idle decision is at ≈ line 354 (`if ((capacity.activeTurns ?? 0) === 0) { idle = true; break; }`); the restart call is at ≈ line 362 inside `run('systemctl', ['restart', 'pi-web-ui'], …)`.
- The script already builds an Internal API client and exposes a dependency seam `dependencies.createInternalApiClient` — that is where a test supplies a fake.
- The client class it uses is `packages/internal-api-mcp/src/internal-api-client.ts`; it already has `listSessions()` returning the sessions response that carries the busy flag. Read it before assuming a shape.
- `scripts/restart-pi-web-ui.sh` already exists and supports `--reason`, `--no-lock` and `--dry-run`. Read it first.

## How to work
- **TDD, RED first.** Extend `server/tests/unit/command-code/command-code-weekly-refresh.test.ts` (9 tests pass now: `npm test --workspace=server -- tests/unit/command-code/command-code-weekly-refresh.test.ts` from the worktree root). Required cases: (a) a busy session present ⇒ no restart; (b) only idle sessions ⇒ restart through the wrapper with the reason; (c) the sessions call throws ⇒ no restart; (d) one busy among idle ⇒ no restart. Paste the RED output for each new test in your handback — a test that never failed proves nothing.
- Keep the diff minimal and path-limited. Do not refactor unrelated code, do not reformat the file.
- **Do not run `npm install`** — `node_modules` is symlinked from the main checkout. If you hit a cache error mentioning `node_modules/.vite`, retry once, then run with `--no-cache`.

## Gates — all must pass, paste the exact commands and exit statuses
```
cd /root/pi-web-ui-wt-restart
npm test --workspace=server -- tests/unit/command-code/command-code-weekly-refresh.test.ts
npm run typecheck
npm run lint
```
- Commit your work on the branch with a clear message. **DO NOT PUSH. DO NOT MERGE. NEVER restart, touch or validate against production.**

## Owned paths — nothing else may be modified
- `scripts/command-code-weekly-refresh.ts`
- `server/tests/unit/command-code/command-code-weekly-refresh.test.ts`
- a new small helper file under `scripts/` **only** if you extract the idle decision for testability (say so in the handback).

## Read-only / off limits
- `/root/pi-web-ui` (the main checkout) is READ-ONLY to you. Never write there except the handback file named below.
- Every other repository, the production service, and any live Internal API action beyond read-only GETs.

## Coordination
- **Handback:** write ONCE, at the end, to `/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15/A-restart-complete.md`, beginning with the word `FROZEN`, containing: what changed (file:line), the RED evidence, the green evidence, exact commands + exit statuses, what you deliberately did *not* do, and any uncertainty or residual risk you see.
- **Questions:** if you need the conductor, write `/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15/A-restart-questions.md` and **end your turn immediately**. Never wait, never poll, never hold your turn open. Ask only about: a contradiction or impossibility in these instructions, an authority or scope boundary you cannot cross, something irreversible, or a premise that turned out to be false. Everything below that line is yours to decide, record and move on with.
- Optionally declare your presence once: `npm --prefix /root/agent-os run agent-os -- board declare --join-session {{SID}} --task "W-A: catalogue-script restart path" --repo /root/pi-web-ui-wt-restart`.

This session runs under a **goal engine**: the objective above is your durable aim. Keep working until it is true, then stop. If you are blocked, record it honestly rather than claiming success.
