# H8 — Secrets migration (out of the public repo) + talker credential

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Why

`pi-web-ui` is a **publicly facing GitHub repository**. Secrets currently live in
`/root/pi-web-ui/.env.production` — which is gitignored, but that is a *convention,
not a control*: `git add -f` bypasses it, it does not scrub history, and it leaves
secrets inside the repo tree where backups and tooling can pick them up. The file
is also mode **644** (world-readable).

The goal is to make the repo directory **incapable** of leaking secrets, rather
than asking it not to.

**Authorised by the operator:** this migration, a production restart, and adding
the talker credential.

## Task 1 — Move secrets out of the repository

1. Create `/root/.pi-web-ui/secrets.env` — **outside** `/root/pi-web-ui` — mode
   **600**, owned by root.
2. Move these six variables **out** of `/root/pi-web-ui/.env.production` and into
   the new file, preserving their values exactly:
   - `JWT_SECRET`
   - `AUTH_PASSWORD`
   - `OPENCODE_SERVER_PASSWORD`
   - `OPENAI_API_KEY`
   - `GLM_CODING_PLAN_TOKEN`
   - `TELEGRAM_BOT_TOKEN`
3. **Do NOT delete `GLM_CODING_PLAN_TOKEN`.** It is in active use: the default
   Claude provider profile (`glm53-claude-sdk-native-profile`) and
   `glm53-claude-cli-direct` both declare `authTokenEnv: GLM_CODING_PLAN_TOKEN`.
   Deleting it breaks GLM-backed Claude sessions. It moves; it does not go away.
4. Leave all **non-secret** configuration in `.env.production`.
5. Patch the systemd unit to load both files, secrets second:
   ```ini
   EnvironmentFile=/root/pi-web-ui/.env.production
   EnvironmentFile=/root/.pi-web-ui/secrets.env
   ```
   Write it as a **drop-in** (`/etc/systemd/system/pi-web-ui.service.d/secrets.conf`)
   so the repo-owned unit file is not edited in place. Use `systemctl daemon-reload`
   after.
6. Consider adding `/root/pi-web-ui/.env.production.bak` to `.gitignore` if such a
   file ever appears — the ignore list already mentions it.

## Task 2 — Add the talker credential

The voice talker resolves its key via `resolveTalkerModelConfig`:
`TALKER_API_KEY || OPENROUTER_API_KEY`. Neither exists in production today, so the
talker refuses with `model_unconfigured`.

Add the OpenRouter key to `/root/.pi-web-ui/secrets.env` as **`TALKER_API_KEY`**.
The key value is available on the host in `~/.bashrc` as `OPENROUTER_API_KEY` — read
it there; do **not** commit or echo it.

**Use `TALKER_API_KEY`, not `OPENROUTER_API_KEY`**, so the talker's budget and
limits stay separate from anything else using OpenRouter, and so the name still
tells the truth if the talker ever moves provider.

## Hard constraints

- **Never print, log, echo, or commit a secret value.** When reporting, say
  "present, length N" — never the value. Redact in any command output you paste.
- **Do not add secrets to any file inside `/root/pi-web-ui`.**
- Do not change any other production configuration.
- Do not touch the database, sessions, or the talker code.

## Method — verify, don't assume

1. **Capture the before state** (names only): which variables the service currently
   resolves, and that it is currently healthy. Record `systemctl show
   pi-web-ui.service -p EnvironmentFiles`.
2. Make the change.
3. `systemctl daemon-reload && systemctl restart pi-web-ui.service`.
4. **Verify live, from outside the service** — the whole point is that nothing broke:
   - `GET /api/v1/capabilities` over the unix socket returns the expected contract
     version and runtimes;
   - `/api/v1/health` responds;
   - **the talker is no longer `model_unconfigured`**: create a throwaway Pi session
     and confirm the talker registry would resolve a model (or call
     `resolveTalkerModelConfig` in a node one-liner with the service env — do NOT
     send a real relay);
   - **the default Claude profile still authenticates** — this is the risk the
     migration carries. Confirm `glm53-claude-sdk-native-profile` can still resolve
     its token (a bounded check; do not run a full session);
   - the UI auth still works — `JWT_SECRET`/`AUTH_PASSWORD` moved, so verify login
     or at least that the auth endpoints respond as before;
   - check the journal for errors introduced by the restart.
5. Delete the throwaway session.

## Stop and report if

- Any verification fails — **roll back immediately** by restoring `.env.production`
  (keep a copy of the original contents in `/tmp/h8-backup/` before you start) and
  removing the drop-in, then report exactly what failed.
- You cannot read the OpenRouter key from the host.
- You find a secret referenced somewhere you did not expect.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / **rolled back**.
2. **What moved** — variable names only, and where. Never values.
3. **Before/after `EnvironmentFiles`.**
4. **Verification evidence** — raw output for each check in step 4, with any secret
   values redacted.
5. **The talker credential** — confirm `TALKER_API_KEY` is present (length only) and
   that the talker no longer reports unconfigured.
6. **Anything that broke or nearly broke**, and how you handled it.
7. **What you could NOT verify** and why.
8. **Confirmation** that no secret value was printed, logged, or written inside the
   repository.
