# Phase 8 Restart Runbook — silent no-op plan (contract 1.45.0)

**Owner-gated.** Execute only after the owner's explicit approval in the execution conversation.
This runbook is the complete, ordered procedure. Nothing in it may be skipped or reordered
without saying so in the hand-back notes. Another agent may be using the production Internal
API — the pre-checks exist for that reason.

## 0. Preconditions (verify ALL before touching anything)

1. **CI green on master**: `gh run list --branch master --limit 4` — the latest commit's
   "Application correctness" and "Docs checks" runs are `success`. If not: stop, fix, push,
   wait for green.
2. **No agent run in flight on the Internal API**: `GET /api/v1/capacity` (production socket,
   read-only) → `activeTurns` must be **0**. Check the exact field in the response
   (`curl --unix-socket /root/.pi-web-ui/internal-api.sock -H "Authorization: Bearer $(cat
   /root/.pi-web-ui/internal-api-token)" http://localhost/api/v1/capacity`). If `activeTurns`
   > 0: stop, wait, re-check. Never restart under load.
3. **No other agent on the Agent OS board depends on the Internal API**: run
   `npm --prefix /root/agent-os run agent-os -- board who` and read every entry whose
   `repos`/`paths` include `/root/pi-web-ui` or whose assignment text references dispatching,
   children, watches, sessions, or Pi Web UI at all. For each such entry: confirm it is
   `idle`/`waiting` AND its last-seen timestamp is stale (> 30 min), or ask the owner. Entries
   owned by this execution (pi-01a0d366) are exempt. If any ACTIVE consumer exists: stop and
   ask the owner.
4. **Production is still expected to serve 1.44.0** before this runbook and **1.45.0** after
   (verify at step 4). If it already serves 1.45.0, this runbook already ran — stop.

## 1. Backup (8a safety) — OUTSIDE the extensions directory

**Critical:** the Pi SDK loads EVERY subfolder of `extensions/` that contains an `index.ts`
(loader.js:560). A backup written inside `extensions/` (e.g. `auto-compact-75.bak-…/`) would be
loaded as a duplicate extension. Back up to a directory the loader never scans:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
sudo mkdir -p /root/.pi/agent/extension-backups/$TS
sudo cp -a /root/.pi/agent/extensions/auto-compact-75 /root/.pi/agent/extension-backups/$TS/
sudo cp -a /root/.pi/agent/extensions/goal-engine /root/.pi/agent/extension-backups/$TS/
sha256sum /root/.pi/agent/extension-backups/$TS/*/* | tee /root/.pi/agent/extension-backups/$TS/SHA256SUMS
```

Rollback for step 2 = `rsync -a --delete /root/.pi/agent/extension-backups/$TS/auto-compact-75/
/root/.pi/agent/extensions/auto-compact-75/` (same for goal-engine) and restart again.

## 2. Pre-restart build gate (production serves server/dist)

A restart only ever deploys a CLEAN BUILD of the exact master HEAD:

1. `git -C /root/pi-web-ui rev-parse HEAD` — record the hash (this is what CI must be green on).
2. `git -C /root/pi-web-ui status --short` — must show NO tracked-file modifications (untracked
   docs are acceptable). A dirty tree means the build would not be the recorded commit — stop.
3. `npm --prefix /root/pi-web-ui run build` — MUST exit 0. If the build fails: stop, fix on
   master, push, wait for CI green, and only then rebuild. **Do not restart on a stale or
   failed build** — production runs `node server/dist/index.js`, so the build output IS the
   deployment.
4. Record `sha256sum /root/pi-web-ui/server/dist/index.js` for the verification log.

## 3. 8a — deploy the extension builds (store → live)

Copy BOTH changed extensions from their store repos (they are committed and pushed):

1. `rsync -a --delete /root/pi-enhancement/auto-compact-75/ /root/.pi/agent/extensions/auto-compact-75/`
   (Phase 4a: ownership status publication.)
2. `rsync -a --delete /root/pi-enhancement/goal-engine/ /root/.pi/agent/extensions/goal-engine/`
   (Round 2: `--yes`/`--replace` non-interactive flags. Without this copy the API's clear/replace
   calls hit the old extension and honestly 409 — degraded, not broken.)
3. Diff check: `diff -rq /root/pi-enhancement/auto-compact-75 /root/.pi/agent/extensions/auto-compact-75`
   and the same for goal-engine — both must report NO differences. (The reverse direction —
   live-only files — must also be empty.)
4. **Post-copy containment check (critical — the loader loads every subfolder with an
   index.ts):**
   `ls /root/.pi/agent/extensions/`
   Compare against the expected extension set (the subfolders that existed before this runbook
   plus `auto-compact-75` and `goal-engine` updates). Any unexpected subfolder — especially
   anything matching `*.bak*` or a new directory — must be moved out to
   `/root/.pi/agent/extension-backups/` BEFORE continuing. A stray directory with an index.ts
   would load as a duplicate extension.
5. **Restart** (the only service touch in this runbook):
   `sudo systemctl restart pi-web-ui.service`
   Note: already-loaded sessions pick up the new extensions only when they are reloaded; the
   restart unloads everything, so all sessions get the new builds.

## 3. Post-restart verification (all must hold)

1. `GET /api/v1/health` → `contract.contractVersion` == **"1.45.0"**.
2. `GET /api/v1/capacity` → `activeTurns` == 0.
3. Read-only `GET /api/v1/sessions` → pick any Pi session → `GET /api/v1/sessions/:id` →
   `ownership.status` is present (`unknown` is acceptable on first sight only if no extension
   has published yet; after opening a session it must be `owned`/`conflict`/`unmanaged`).
4. Journal: `journalctl -u pi-web-ui.service --since "<restart timestamp>"` shows clean startup,
   no `Ownership: conflict` lines for sessions the server itself opened.
5. UI smoke (read-only): open the web UI, confirm a session view loads.

## 4. 8b — remove the four dead :3111 HTTP hooks

Owner-approved plan: REMOVE ONLY the four entries; everything else in
`/root/.claude/settings.json` stays byte-identical.

1. **Back up first**: `cp /root/.claude/settings.json /root/.claude/settings.json.bak-$(date -u +%Y%m%dT%H%M%SZ)`
   and record its sha256.
2. Edit `/root/.claude/settings.json`: delete exactly the four hook groups whose URL is
   `http://127.0.0.1:3111/hook/…` — `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`
   (each is an object `{ "matcher": "*", "hooks": [ { "type": "http", "url": "http://127.0.0.1:3111/hook/…" } ] }`
   inside its event array). Do NOT touch the Agent OS command hooks
   (`agent-os-hook.mjs`, `pre-tool-bash.sh`) or any other key.
3. Validate: `python3 -c "import json;d=json.load(open('/root/.claude/settings.json'));print(json.dumps(d['hooks'],indent=1))"`
   — parses, and no `3111` remains: `grep -c 3111 /root/.claude/settings.json` == 0.
4. New Claude session smoke: start a throwaway Claude Code session and confirm no
   `ECONNREFUSED 127.0.0.1:3111` hook errors appear.

**Why removal is safe (test citation):** `server/tests/unit/claude/claude-channel-hooks-config.test.ts`
("ClaudeChannelHooksConfig") proves the channel manages exactly its own entries:
"should generate correct hooks JSON" (the writer emits exactly the four http entries),
"should merge with existing settings.json" (re-registration after removal), and
"should remove only its own hooks on cleanup" (its removal path touches nothing else).
If the Claude channel mode is ever re-enabled, `claude-channel-service.ts` calls
`writeHooksConfig()` on start and the hooks come back automatically on the configured port.

## 5. Rollback

- Extensions: restore from `/root/.pi/agent/extension-backups/<timestamp>/` (rsync back, per the
  step-1 mapping), `sudo systemctl restart pi-web-ui.service`, re-verify
  health shows **1.44.0**-era behaviour (note: the contract constant only reverts with a server
  build rollback — `git checkout <pre-1.45 commit>` + rebuild if a full code rollback is needed).
- Hooks: restore `settings.json` from the step-4.1 backup.

## 6. Close-out

- Record in the execution report: restart timestamp, post-restart verification outputs,
  hooks diff, and the new production contract version.
- Telegram the owner: restart done, verification results, and that already-running agents
  (if any appeared between pre-check and restart) were handled how.
