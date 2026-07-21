# First run: Linux + one runtime

This is the shortest supported path from a fresh clone to a working Pi Web UI session. It intentionally configures **one runtime first**. Add other runtimes only after the basic UI works.

## 1. Prerequisites

- Linux host (local machine or VPS)
- a currently supported Node.js release for this repository
- Git
- credentials or an authenticated CLI for at least one supported runtime
- a browser that can reach the host

Pi Web UI is operator-controlled software, not a turnkey multi-tenant service. Read [`../SECURITY.md`](../SECURITY.md) before exposing it beyond a trusted network.

## 2. Clone and install

```bash
git clone https://github.com/valtterimelkko/pi-web-ui.git
cd pi-web-ui
npm ci --include=dev
cp .env.example .env
```

## 3. Configure the minimum

Open `.env` and set the login password and the origin from which the browser will access the UI. Keep secrets only in `.env`; never commit it.

Then configure exactly one runtime:

- **Pi Coding Agent** — best first choice for native Pi extensions and custom tools
- **OpenCode** — a straightforward server-backed path
- **Claude Code** — choose the SDK backend first, especially for provider profiles
- **Antigravity** — useful for Gemini/Antigravity workflows, but operationally the least native path

Use [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) for runtime-specific authentication and caveats.

## 4. Start development mode

```bash
npm run dev
```

A successful start should leave the server running without a fatal configuration error. Open the URL shown by the server, sign in, and create a session using the runtime you configured.

## 5. Confirm the first working session

Send a small prompt that requires no repository mutation, for example:

```text
Reply with the runtime name and current working directory only.
```

Confirm that:

1. the session appears in the sidebar;
2. the response streams or completes visibly;
3. refreshing the browser preserves the session;
4. reopening the session restores its visible transcript.

## 6. Know where to go next

- Production or always-on service: [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
- Runtime selection: [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md)
- Internal API: [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md)
- Telegram and terminal-agent notifications: [`SELF-NOTIFICATIONS.md`](./SELF-NOTIFICATIONS.md)
- Troubleshooting: [`TROUBLESHOOTING-DECISION-TREE.md`](./TROUBLESHOOTING-DECISION-TREE.md)
- Files tab: [`FILES-TAB.md`](./FILES-TAB.md)

## 7. Stop, restart, and update

Stop the foreground development server with `Ctrl+C`. For a persistent deployment, use the documented service setup rather than leaving development mode in a terminal.

Before updating a live installation:

1. back up operator-owned state;
2. read [`RECENT-CHANGES.md`](./RECENT-CHANGES.md);
3. pull the desired revision;
4. run `npm ci --include=dev`;
5. run the repository checks appropriate to the change;
6. restart the service;
7. verify login, one existing session, and one fresh session.

The durability boundaries for sessions, receipts, diagnostics, notifications, and watches are summarized in [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md).