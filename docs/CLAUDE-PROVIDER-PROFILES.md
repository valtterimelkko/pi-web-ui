# Claude Provider Profiles

> Operator reference for the Claude provider profile system.
>
> If you want to understand how the three Claude backends relate to each other, read [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) first.
> For the full env var table for production deployments, see [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## What profiles are

The provider profile system lets Pi Web UI run Claude sessions through different backends and providers without touching `~/.claude/settings.json`.

Each **profile** specifies:
- which backend to use (`sdk-subscription`, `cli-direct`, or `channel`)
- which launcher style (`native-env` or `command`)
- which provider endpoint and auth token to use
- which model, model aliases, skills, and permission mode to apply
- how many concurrent sessions the profile allows

Profiles live in a JSON file (default: `~/.pi-web-ui/claude-profiles.json`) and are Zod-validated at startup. Auth tokens are sourced from env vars or validated secret files at session launch time. They are **never stored in the profile file itself** and are never logged.

## Enable the system

Add these env vars to your `.env` or systemd unit:

```env
CLAUDE_PROFILES_ENABLED=true          # opt-in gate
CLAUDE_PROFILES_PATH=                 # default: ~/.pi-web-ui/claude-profiles.json
CLAUDE_DEFAULT_PROFILE=               # optional: profile id to use for all new Claude sessions
CLAUDE_SDK_ENABLED=true               # enable sdk-subscription backend (default: true when profiles enabled)
CLAUDE_DIRECT_PROFILES_ENABLED=true   # enable cli-direct profile support (default: true)
CLAUDE_BACKEND_DEFAULT=sdk            # sdk | direct | channel (default: direct)
```

After enabling, restart Pi Web UI. Profile-backed model entries appear in the new-session model picker as `profile:<id>`.

To roll back to legacy direct mode at any time:

```env
CLAUDE_PROFILES_ENABLED=false
CLAUDE_SDK_ENABLED=false
CLAUDE_BACKEND_DEFAULT=direct
```

## Profile config file format

```json
{
  "profiles": [
    { "id": "claude-sonnet-sdk", "label": "Claude Sonnet — SDK", ... },
    { "id": "glm52-claude-sdk",  "label": "GLM 5.2 — Claude SDK", ... }
  ],
  "defaultProfileId": "claude-sonnet-sdk"
}
```

`defaultProfileId` is optional and is overridden by `CLAUDE_DEFAULT_PROFILE` in the env.

## Full field reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes | — | Unique profile identifier. Appears in the model picker as `profile:<id>`. |
| `label` | string | yes | — | Display name shown in the model picker UI. |
| `backend` | `sdk-subscription` \| `cli-direct` \| `channel` | yes | — | Which Claude backend drives this profile. |
| `launcherType` | `native-env` \| `command` | yes | — | How the Claude binary is launched. `native-env` injects env vars; `command` calls a wrapper executable. |
| `command` | string | no | — | Absolute path to a wrapper executable. Required when `launcherType: 'command'`. |
| `baseUrl` | string (URL) | no | — | Override for `ANTHROPIC_BASE_URL`. Use for Anthropic-compatible providers (e.g. Z.ai Coding Plan). |
| `authTokenEnv` | string | no | — | Name of the env var that holds the auth token. Read at session launch time from the server environment. |
| `authTokenPath` | string | no | — | Absolute path to a secret file whose contents are the auth token. Must be non-symlink and readable by the service user. |
| `authMode` | `subscription` \| `anthropic-compatible-token` \| `wrapper` | no | — | Auth semantics hint. Informational; not mechanically enforced. |
| `model` | string | yes | — | Model name or Claude alias (e.g. `sonnet`, `opus`). |
| `modelMode` | `claude-alias` \| `pass-through` | no | `claude-alias` | How the `model` field is interpreted by the SDK. |
| `modelAliases` | object (string→string) | no | — | Env vars injected to override Claude model aliases, e.g. `{ "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2[1m]" }`. |
| `settingSources` | array of `user` \| `project` \| `local` | no | `["user","project"]` | Which Claude settings source levels to load for this profile. |
| `skills` | `"all"` \| string[] | no | — | Skills to enable. `"all"` enables every available skill. Empty array disables all. |
| `permissionMode` | string | no | `dontAsk` | Tool permission mode passed to the Claude SDK or subprocess. |
| `allowedTools` | string[] | no | — | Explicit tool allowlist. |
| `disallowedTools` | string[] | no | — | Explicit tool denylist. |
| `maxConcurrent` | integer ≥ 1 | no | `2` | Maximum simultaneous sessions allowed for this profile. |
| `enabled` | boolean | no | `true` | Set `false` to disable a profile without removing it from the file. |
| `notes` | string | no | — | Free-text notes. Not used at runtime. |

## Examples

### Native Anthropic subscription via SDK backend

Uses the existing Claude Code subscription. No extra token needed.

```json
{
  "id": "claude-sonnet-sdk",
  "label": "Claude Sonnet — SDK",
  "backend": "sdk-subscription",
  "launcherType": "native-env",
  "model": "sonnet",
  "permissionMode": "dontAsk",
  "maxConcurrent": 2
}
```

### GLM 5.2 via Z.ai Coding Plan — SDK backend

Routes through the Z.ai GLM Coding Plan endpoint as an Anthropic-compatible provider.
The `modelAliases` entry overrides Claude's internal sonnet alias to resolve to `glm-5.2[1m]`.

```json
{
  "id": "glm52-claude-sdk",
  "label": "GLM 5.2 — Claude SDK",
  "backend": "sdk-subscription",
  "launcherType": "native-env",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "authTokenEnv": "GLM_CODING_PLAN_TOKEN",
  "model": "sonnet",
  "modelAliases": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2[1m]"
  },
  "skills": "all",
  "permissionMode": "dontAsk"
}
```

Set `GLM_CODING_PLAN_TOKEN=<your-token>` in your `.env` or systemd unit. Never put the token value in the profile file.

### GLM 5.2 via direct CLI backend

Uses `claude -p` subprocess dispatch with profile-resolved env instead of the SDK. Useful as a fallback or for tooling that behaves differently under the SDK path.

```json
{
  "id": "glm52-claude-cli-direct",
  "label": "GLM 5.2 — CLI Direct",
  "backend": "cli-direct",
  "launcherType": "native-env",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "authTokenEnv": "GLM_CODING_PLAN_TOKEN",
  "model": "sonnet",
  "modelAliases": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2[1m]"
  },
  "permissionMode": "dontAsk"
}
```

### Command wrapper launcher

Delegates to a wrapper script that prepares its own env before calling Claude.

```json
{
  "id": "my-wrapper-profile",
  "label": "Claude via wrapper",
  "backend": "cli-direct",
  "launcherType": "command",
  "command": "/usr/local/bin/my-claude-wrapper",
  "model": "sonnet",
  "permissionMode": "dontAsk"
}
```

## How secrets work

- **`authTokenEnv`** — Pi Web UI reads `process.env[authTokenEnv]` at session launch time. Set the env var in your `.env` file or systemd unit. The resolved value is never logged or exposed through APIs.
- **`authTokenPath`** — Pi Web UI reads the file at launch time. The path must be absolute, non-symlink, and readable by the service user. File contents become the token and are never logged.
- **Never put token values in the profile JSON.** The profile file is configuration, not a credentials store. It may appear in logs, debug output, or agent tool reads.

## Safety invariants

These are enforced in code and verified by the profile validation runner:

- **`ANTHROPIC_API_KEY` is always stripped** from the subprocess environment for all profile-backed sessions. This prevents accidental pay-per-use charges when routing through a provider profile. When you see `apiKeySource: "none"` in session info, that is correct and expected.
- **`authTokenPath` must be absolute and non-symlink.** Symlinks are explicitly rejected.
- **Token values are never logged.** The `redactSecrets` helper replaces them with `[REDACTED]` in all server log lines, even at debug verbosity.
- **`apiKeySource=none` is asserted** by the live validation runner for every profile-backed session.

## How profiles appear in the UI

When `CLAUDE_PROFILES_ENABLED=true`, profiles are selectable in two places:

- **Browser UI** — In the New Session modal, choose the **Claude Direct** session type. A **structured selector** then appears with three axes:
  - **Provider** — Claude or GLM.
  - **Backend** — SDK / CLI direct / Channel (in priority order). Only the backends that have a matching profile are shown; GLM omits Channel.
  - **Model** — Sonnet / Opus / Haiku (shown for Claude only; GLM has a single model).

  The selection is resolved to the matching `profile:<id>` and sent as the session's `model`; the server resolves the backend/provider at creation time. For the structured selector to offer a combination, a profile for it must exist in `claude-profiles.json` (see the matrix below).
- **Internal API** — `GET /api/v1/models` returns profile-backed entries with `profile:<id>` IDs plus `backend` and `claudeModel` fields; create a session with `model: "profile:<id>"` (or an explicit `profileId`).

Selecting a profile creates a session bound to it. Profile binding persists across follow-up turns in the same session. To use a different profile, create a new session.

### Base-alias routing

A bare model alias (`sonnet`/`opus`/`haiku`, with no `profile:` prefix) resolves to a **native Claude** SDK profile for that model — never the configured default profile. This prevents the footgun where a GLM default profile caused a bare "Claude Sonnet" selection to silently run GLM. The `defaultProfileId` / `CLAUDE_DEFAULT_PROFILE` setting now only applies to sessions created with no model at all (e.g. session transfer).

### Recommended profile matrix

For the structured selector to expose the full grid, define one profile per combination:

| Provider | Backend | Models | Example ids |
|---|---|---|---|
| Claude | SDK | sonnet/opus/haiku | `claude-sonnet-sdk-subscription`, `claude-opus-sdk-subscription`, `claude-haiku-sdk-subscription` |
| Claude | CLI direct | sonnet/opus/haiku | `claude-{sonnet,opus,haiku}-cli-direct` |
| Claude | Channel | sonnet/opus/haiku | `claude-{sonnet,opus,haiku}-channel` |
| GLM | SDK | (single) | `glm52-claude-sdk-native-profile` |
| GLM | CLI direct | (single) | `glm52-claude-cli-direct` |

Channel profiles require `CLAUDE_CHANNEL_ENABLED=true`.

A ready-to-copy config with all of the above is committed at [`claude-profiles.example.json`](./claude-profiles.example.json). Copy it to `~/.pi-web-ui/claude-profiles.json` and set `GLM_CODING_PLAN_TOKEN` in the environment.

## Validating a profile setup

Use the dedicated profile validation runner against a disposable validation server so you never touch the production registry:

```bash
# 1. Boot a throwaway validation server with profiles enabled
VAL_DIR=$(mktemp -d)
cp ~/.pi-web-ui/claude-profiles.json "$VAL_DIR/claude-profiles.json"

CLAUDE_PROFILES_ENABLED=true \
CLAUDE_SDK_ENABLED=true \
CLAUDE_PROFILES_PATH="$VAL_DIR/claude-profiles.json" \
GLM_CODING_PLAN_TOKEN="<your-token>" \
npm run validate:server -- --dir "$VAL_DIR" --port 0

# 2. Run the profile scenarios (in another terminal or background)
npm run validate:claude-profiles -- \
  --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --glm-profile "glm52-claude-sdk" \
  --native-profile "claude-sonnet-sdk" \
  --direct-profile "glm52-claude-cli-direct"
```

This validates:
- SDK native Claude subscription returns correct model identity
- SDK GLM profile runs without pay-per-use (`apiKeySource=none`)
- Direct CLI GLM profile works
- Tool calls are visible (`tool_execution_start` / `tool_execution_end`)
- Skills are available and usable
- Follow-up turns work with profile persistence across turns

List available scenarios:

```bash
npm run validate:claude-profiles -- --list
```

Run a subset by name:

```bash
npm run validate:claude-profiles -- \
  --socket <sock> --token-path <token> \
  --glm-profile glm52-claude-sdk \
  --only sdk-model-identity,tool-visibility
```

Test simultaneous Claude + GLM sessions with zero cross-contamination:

```bash
npx tsx scripts/concurrency-test.ts \
  --socket <sock> --token-path <token> \
  --profiles claude-sonnet-sdk,glm52-claude-sdk
```

## Failure modes and diagnosis

### Profile does not appear in the model picker

- Confirm `CLAUDE_PROFILES_ENABLED=true` is set in the **running** server environment
- Check startup logs for Zod validation errors: `journalctl -u pi-web-ui | grep -i "profile"`
- Confirm the profile has `"enabled": true` (or omit the field; it defaults to `true`)
- Confirm `CLAUDE_PROFILES_PATH` points to the correct file and the file is readable

### Session creation fails immediately

- Check that `authTokenEnv` is set in the environment: `echo $GLM_CODING_PLAN_TOKEN`
- If using `authTokenPath`, verify the path is absolute, not a symlink (`ls -la <path>`), and readable by the service user
- Verify `baseUrl` is a valid HTTPS URL if provided

### Wrong model identity at runtime

- Confirm `modelAliases` uses the exact env var name the provider expects (e.g. `ANTHROPIC_DEFAULT_SONNET_MODEL`)
- Use the `sdk-model-identity` scenario in the validation runner to assert model identity mechanically

### `ANTHROPIC_API_KEY` errors from the provider

This is expected behaviour: `ANTHROPIC_API_KEY` is always stripped from the environment. Anthropic-compatible providers receive credentials through `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` instead. If a provider explicitly requires `ANTHROPIC_API_KEY` (non-Anthropic-compatible), this profile system does not support that provider.

### Profile loads but sessions hang or produce no events

- Verify the SDK backend is active: check journal for `ClaudeSdkService` log lines
- Check `CLAUDE_SDK_ENABLED=true` if backend is `sdk-subscription`
- Run the `smoke` and `tool-visibility` scenarios from the validation runner to confirm end-to-end connectivity

## Related docs

- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) — backend mode architecture (SDK, direct, channel), env vars, and live validation commands
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — full production env var table
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — validation runner guide
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — diagnosing Claude runtime failures
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — SDK backend sharp edges
