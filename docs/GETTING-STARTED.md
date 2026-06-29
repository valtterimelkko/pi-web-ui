# Getting Started

This guide is for people who want their **first working Pi Web UI session**, not a full production deployment on day one.

If you are choosing between runtimes first, read [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md).
If you are deciding where to host this, read [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md).

## 1. Decide how you want to run it

There are three common adoption patterns:

### A. Local development / local personal use
Good for trying the repo, making changes, or using it while your own machine is on.

### B. Always-on home machine or Mac mini
Good if you want the web UI available throughout your local network or whenever that machine stays on.

### C. Linux VPS / always-on server
Best if you want Pi Web UI available 24/7, want to resume work from multiple devices, or want long-running coding-agent workflows.

You do **not** need a big server for light tasks such as markdown editing, smaller coding help, or lightweight orchestration. Heavier coding workflows, builds, and agent tool use need more RAM/CPU headroom.

## 2. Support tiers

- **Linux:** first-class target
- **macOS:** viable for technical users, especially local/personal setups
- **Windows:** not a primary target today

Full details: [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md)

## 3. Choose one runtime first

Most adopters should start with **one runtime**, not all four.

Good first choices:

- **Pi Coding Agent** if you already use Pi Coding Agent and want the richest extension path
- **OpenCode** if OpenCode is already part of your workflow
- **Claude Code** if Claude Code is your main coding runtime and you accept a more wrapper-oriented integration
- **Antigravity** if Gemini/Antigravity is specifically why you want this UI

## 4. Install base prerequisites

### Linux or macOS
- Node.js 20+
- npm
- git

Check:

```bash
node -v
npm -v
git --version
```

## 5. Install runtime-specific prerequisites

Install only the runtime(s) you plan to use first.

### Pi Coding Agent path
- Pi Coding Agent CLI / SDK environment available on the machine

### Claude Code
- `claude` installed
- authenticated as the same OS user that will run Pi Web UI

### Channel-backed Claude mode only
- Bun installed
- `pi-claude-channel/` dependencies installable locally

### OpenCode
- `opencode` installed and configured

### Antigravity
- `agy` installed
- authenticated as the same OS user that will run Pi Web UI

For runtime trade-offs, read [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md).

## 6. Clone and install

```bash
git clone git@github.com:valtterimelkko/pi-web-ui.git
cd pi-web-ui
npm install
```

## 7. Create your local config

```bash
cp .env.example .env
```

At minimum, set:

```bash
NODE_ENV=development
JWT_SECRET=replace-with-a-random-secret
CSRF_SECRET=replace-with-a-random-secret
AUTH_PASSWORD=choose-a-password-you-will-log-in-with
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001
```

Important notes:
- In local development, `AUTH_PASSWORD` can be plain text.
- In production, use a strong secret set and a bcrypt hash for `AUTH_PASSWORD`.
- Login is password-based in the browser. The browser login password is the value behind `AUTH_PASSWORD`.

If you are only enabling some runtimes, leave the others disabled or simply do not configure them yet.

## 8. Runtime-specific env examples

### Pi Coding Agent-focused first run
Usually just the base config is enough if your Pi Coding Agent environment is already available to the same OS user.

Optional but useful now: the Pi runtime can also surface a much broader **OpenRouter-backed model catalogue** into the Pi model picker. That is not required for first success, but once your Pi auth is working you can refresh the catalogue with:

```bash
npm run pi:refresh-models
```

Read [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md) if you want the weekly refresh path or the auth/storage details.

### Claude Code-focused first run
For the current best Claude experience, start with the **profile-enabled SDK path** even if you only want native Claude at first. That gives you the same browser surface for:
- native Claude subscription sessions
- GLM 5.2 / Z.ai provider profiles
- direct CLI fallback and channel fallback later if you need them

Minimal Claude-first setup:

```bash
CLAUDE_PROFILES_ENABLED=true
CLAUDE_SDK_ENABLED=true
CLAUDE_PROFILES_PATH=~/.pi-web-ui/claude-profiles.json
CLAUDE_CHANNEL_ENABLED=false
```

Then create `claude-profiles.json` and read [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) for the full field reference and examples.

When profiles are enabled, the New Session modal exposes a **structured Claude selector**:
- **Provider** → Claude or GLM
- **Backend** → SDK, direct CLI, or channel (where available)
- **Model** → Sonnet / Opus / Haiku for Claude, or the GLM profile route you configured

If you intentionally want the richer channel-backed path later:

```bash
CLAUDE_CHANNEL_ENABLED=true
CLAUDE_CHANNEL_PLUGIN_DIR=./pi-claude-channel
CLAUDE_CHANNEL_WS_PORT=3100
CLAUDE_CHANNEL_HOOK_PORT=3101
```

### OpenCode-focused first run
Check:

```bash
OPENCODE_ENABLED=true
OPENCODE_SERVER_HOST=127.0.0.1
OPENCODE_SERVER_PORT=4096
OPENCODE_WORKING_DIR=/path/to/default/workspace
```

### Antigravity-focused first run
Check:

```bash
ANTIGRAVITY_ENABLED=true
ANTIGRAVITY_DEFAULT_MODEL=Gemini 3.5 Flash (Medium)
```

## 9. Start the app locally

```bash
npm run dev
```

This starts:
- the Vite frontend (usually `http://localhost:5173`)
- the backend server (usually `http://localhost:3001`)

Open:

```text
http://localhost:5173
```

Log in with the password you set in `AUTH_PASSWORD`.

## 10. Create your first session

Once logged in:

1. open the new-session UI
2. choose the runtime you configured
3. choose a working directory
4. send a simple prompt such as `Reply OK`

If that works, you have a valid end-to-end setup.

## 10b. Optional: enable Telegram notifications

If you want a ping when a session yields control back to you, you can enable the notification layer.

Add to `.env`:

```bash
NOTIFICATIONS_ENABLED=true
NOTIFICATIONS_PUBLIC_BASE_URL=http://localhost:5173
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

Then restart the app. In the session list, use the bell icon on a session row to opt that session in.

This is optional and per-session. Read [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) for the deeper operator details.

## 11. Useful first checks

### Base health
```bash
npm run lint
npm run typecheck
npm run build
```

### Runtime checks
```bash
# Claude
claude auth status --json

# OpenCode
which opencode

# Antigravity
agy -p "Reply OK"
```

### Pi Web UI checks
```bash
curl http://localhost:3001/api/health/live
curl http://localhost:3001/api/health/ready
curl http://localhost:3001/api/config/validate
```

## 12. If you want it available all the time

For persistent day-to-day use, many people will want an always-on machine:

- a Linux VPS
- a home Linux box
- a Mac mini or other always-on macOS machine

That is not mandatory, but it is the most practical shape if you want:
- access from multiple devices
- long-running workflows
- a persistent personal coding-agent workspace

The maintainer's own preferred shape is an always-on server behind a reverse proxy, and **Caddy** is a very good fit for that. Read [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## 13. What to read next

- [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md)
- [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md)
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md)
- [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md)
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
- [`../SECURITY.md`](../SECURITY.md)
