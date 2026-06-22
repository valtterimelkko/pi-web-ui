# Runtime Overview

Pi Web UI can present **four runtime families in one browser UI**, but you do not need to adopt all four.

This guide helps you choose where to start.

## Recommended mindset

Start with **one runtime you already trust or already use**.

Then add more runtimes only if they solve a real problem for you:
- provider access
- subscription economics
- model diversity
- extension/plugin ecosystem
- different strengths for different tasks

## Comparison table

| Runtime family | Uses | Integration style | Setup difficulty | Streaming/tool visibility | Best for | Caveat level |
|---|---|---|---|---|---|---|
| **Pi Coding Agent** | Pi Coding Agent | Native SDK/session integration | Medium | Richest Pi Coding Agent behaviour | Pi Coding Agent extensions, custom tools, Pi Coding Agent-first workflows | Low |
| **Claude Code** | Claude Agent SDK, `claude -p`, or channel-backed Claude Code | SDK integration (preferred), subprocess, or PTY/plugin | Medium-high | SDK and channel modes offer good tool visibility; legacy direct is weaker | Claude Code-centric workflows, multi-provider access (GLM via Z.ai, etc.) | Medium–higher |
| **OpenCode** | `opencode serve` | Local server/API integration | Medium | Strong normalized streaming via SSE adaptation | OpenCode-backed workflows and OpenCode/Z.AI setups | Low-medium |
| **Antigravity** | `agy -p` | Subprocess-per-turn wrapper | Medium | No true live streaming today; replay/log driven | Gemini/Antigravity access in the same UI | Higher |

## The important trust distinction

These runtime paths are **not equally native**.

### More native / supported integration surfaces
- **Pi Coding Agent**
- **OpenCode**

### More wrapper-oriented paths
- **Claude Code**
- **Antigravity**

That does not make Claude or Antigravity useless. It just means adopters should expect those paths to be more operationally sensitive when upstream CLIs change.

## Which runtime should I start with?

### Start with Pi Coding Agent if...
- you already use Pi Coding Agent
- you want the deepest extension path
- you want companion Pi Coding Agent extensions to matter
- you want the most native Pi Coding Agent workflow behaviour

Read next:
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md)
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md)

### Start with OpenCode if...
- OpenCode is already in your workflow
- you want a local server/API style integration rather than a per-turn wrapper
- OpenCode/Z.AI/GLM access is one of the reasons you are considering Pi Web UI

Read next:
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md)

### Start with Claude Code if...
- Claude Code is the reason you want a browser UI
- you want to route through alternative providers (e.g. GLM 5.2 via Z.ai Coding Plan) using the same browser UI and session model
- you accept that this path has more operational nuance than Pi Coding Agent or OpenCode
- you specifically want channel-backed Claude visibility/features later

Read next:
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) (if you want to configure provider profiles)

### Start with Antigravity if...
- Gemini/Antigravity access is the key reason you want this repo
- you are comfortable with a subprocess-per-turn runtime path
- replay/history are good enough even without full live tool visibility

Read next:
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)

## Capability summary

| Capability | Pi Coding Agent | Claude Code | OpenCode | Antigravity |
|---|---|---|---|---|
| Unified sidebar session | Yes | Yes | Yes | Yes |
| History replay | Yes | Yes | Yes | Yes |
| Follow-up turns | Yes | Yes | Yes | Yes |
| Mid-turn steer | Yes | No | No | No |
| Approvals in UI | Extension/path dependent | Yes in richer path | Yes | No |
| Best companion ecosystem | Strongest | Limited | Good with plugins | Limited |

## Practical recommendations

### For the simplest serious adoption
Choose:
- **Pi Coding Agent-only**, or
- **OpenCode-only**

### For a stronger mixed setup
Choose:
- **Pi Coding Agent + Claude Code**, or
- **Pi Coding Agent + OpenCode**

### For the fullest multi-runtime philosophy
Choose:
- **Pi Coding Agent + Claude Code + OpenCode + Antigravity**

But only if you already know why each one belongs.

## Persistence and source of truth

| Runtime family | Primary persistence |
|---|---|
| **Pi Coding Agent** | `~/.pi/agent/sessions/` |
| **Claude Code** | `~/.pi-web-ui/claude-sessions/` + Claude native session JSONL |
| **OpenCode** | OpenCode runtime owns transcript storage; Pi Web UI stores registry metadata and replay transforms |
| **Antigravity** | `~/.pi-web-ui/antigravity-sessions/` + agy-owned conversation DBs |

## Companion repos

These can make a major difference to the richness of Pi and OpenCode workflows:

- **Pi Coding Agent extensions:** [valtterimelkko/pi-extensions-public](https://github.com/valtterimelkko/pi-extensions-public)
- **OpenCode plugins:** [valtterimelkko/opencode-plugins](https://github.com/valtterimelkko/opencode-plugins)

See [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md).

## Related docs

- [`GETTING-STARTED.md`](./GETTING-STARTED.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
